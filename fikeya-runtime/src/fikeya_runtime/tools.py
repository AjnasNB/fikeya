# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Approval-gated, argument-vector-only local tool execution."""

from __future__ import annotations

import os
import re
import secrets
import signal
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .errors import ApprovalError, ConfigurationError
from .state import StateStore
from .util import sha256_text, stable_json, utc_now
from .workspace import WorkspaceBoundary

_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_SENSITIVE_ENVIRONMENT = re.compile(
    r"(SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION|ACCESS_?TOKEN|REFRESH_?TOKEN|BEARER)",
    re.IGNORECASE,
)
_SENSITIVE_ARGUMENT = re.compile(
    r"^--?(api[-_]?key|password|passwd|secret|token|authorization)(=|$)",
    re.IGNORECASE,
)
_COMMAND_INTERPRETERS = {
    "bash",
    "cmd",
    "cmd.exe",
    "command.com",
    "fish",
    "ksh",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "sh",
    "zsh",
}
_WINDOWS_NATIVE_EXECUTABLE_SUFFIXES = frozenset({".com", ".exe"})
_WINDOWS_SHELL_SHIM_SUFFIXES = frozenset({".bat", ".cmd", ".ps1", ".sh"})
_PROCESS_POLL_SECONDS = 0.05
_PROCESS_CLEANUP_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class ToolRequest:
    """A canonical process request that cannot represent a raw shell command."""

    argv: tuple[str, ...]
    cwd: str = "."
    environment: dict[str, str] = field(default_factory=dict)
    timeout_seconds: float = 60.0

    def __post_init__(self) -> None:
        if not isinstance(self.argv, tuple) or not 1 <= len(self.argv) <= 128:
            raise ConfigurationError("Tool argv must be a tuple with 1-128 items.")
        for argument in self.argv:
            if not isinstance(argument, str) or not argument or "\x00" in argument:
                raise ConfigurationError(
                    "Every tool argument must be a non-empty string."
                )
            if len(argument) > 8_192:
                raise ConfigurationError("A tool argument exceeds 8192 characters.")
            if _SENSITIVE_ARGUMENT.match(argument):
                raise ConfigurationError(
                    "Credentials cannot be passed in tool arguments; use a dedicated adapter."
                )
        executable_name = Path(self.argv[0]).name.lower()
        if Path(self.argv[0]).name != self.argv[0]:
            raise ConfigurationError(
                "Tool executable must be an allowlisted command name, not a path."
            )
        if executable_name in _COMMAND_INTERPRETERS:
            raise ConfigurationError("Command interpreters are not executable tools.")
        if Path(self.cwd).is_absolute() or "\x00" in self.cwd:
            raise ConfigurationError("Tool cwd must be a relative workspace path.")
        if not 0.1 <= self.timeout_seconds <= 300:
            raise ConfigurationError(
                "Tool timeout must be between 0.1 and 300 seconds."
            )
        if len(self.environment) > 64:
            raise ConfigurationError("Tool environment can contain at most 64 entries.")
        for name, value in self.environment.items():
            if not _ENVIRONMENT_NAME.fullmatch(name):
                raise ConfigurationError(f"Invalid tool environment name: {name}")
            if _SENSITIVE_ENVIRONMENT.search(name):
                raise ConfigurationError(
                    f"Sensitive environment variable {name} requires a dedicated adapter."
                )
            if not isinstance(value, str) or "\x00" in value or len(value) > 16_384:
                raise ConfigurationError(f"Invalid tool environment value for {name}.")

    @property
    def request_sha256(self) -> str:
        """Hash every field covered by a single-use approval."""

        return sha256_text(
            stable_json(
                {
                    "argv": list(self.argv),
                    "cwd": self.cwd,
                    "environment": self.environment,
                    "timeoutSeconds": self.timeout_seconds,
                }
            )
        )


@dataclass(frozen=True, slots=True)
class ToolResult:
    """Bounded process output or a dry-run preview."""

    status: str
    request_sha256: str
    exit_code: int | None
    duration_ms: int
    stdout: str
    stderr: str
    truncated: bool


class ApprovalLedger:
    """Issue and atomically consume exact-request, single-use approvals."""

    def __init__(self, state: StateStore) -> None:
        self.state = state
        self.state.initialize()

    def approve(self, request: ToolRequest, *, ttl_seconds: float = 60.0) -> str:
        """Return a bearer-like approval token while storing only its digest."""

        if not 1 <= ttl_seconds <= 600:
            raise ApprovalError("Approval lifetime must be between 1 and 600 seconds.")
        token = secrets.token_urlsafe(32)
        token_sha256 = sha256_text(token)
        with self.state._connect() as connection:
            connection.execute(
                """
                INSERT INTO approvals (
                    approval_id, request_sha256, token_sha256, issued_at,
                    expires_at_epoch, consumed_at, decision
                ) VALUES (?, ?, ?, ?, ?, NULL, 'approved')
                """,
                (
                    f"apr_{secrets.token_hex(16)}",
                    request.request_sha256,
                    token_sha256,
                    utc_now(),
                    time.time() + ttl_seconds,
                ),
            )
        return token

    def consume(self, request: ToolRequest, token: str) -> None:
        """Consume one matching, unexpired approval in a write transaction."""

        if not token:
            raise ApprovalError("Tool execution requires an approval token.")
        with self.state._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT approval_id, request_sha256, expires_at_epoch, decision
                FROM approvals WHERE token_sha256 = ?
                """,
                (sha256_text(token),),
            ).fetchone()
            if row is None:
                raise ApprovalError("Approval token is unknown.")
            if row["decision"] != "approved":
                raise ApprovalError("Approval token has already been consumed.")
            if float(row["expires_at_epoch"]) < time.time():
                raise ApprovalError("Approval token has expired.")
            if row["request_sha256"] != request.request_sha256:
                raise ApprovalError("Approval does not match the exact tool request.")
            connection.execute(
                """
                UPDATE approvals
                SET decision = 'consumed', consumed_at = ?
                WHERE approval_id = ? AND decision = 'approved'
                """,
                (utc_now(), row["approval_id"]),
            )


class ToolBroker:
    """Preview tools by default and execute only inside a strict boundary."""

    def __init__(
        self,
        *,
        boundary: WorkspaceBoundary,
        approvals: ApprovalLedger,
        allowed_executables: set[str],
        execution_enabled: bool = False,
        maximum_output_bytes: int = 262_144,
    ) -> None:
        if not allowed_executables:
            raise ConfigurationError(
                "Tool broker requires a non-empty executable allowlist."
            )
        normalized = {name.lower() for name in allowed_executables}
        if normalized & _COMMAND_INTERPRETERS:
            raise ConfigurationError(
                "Command interpreters cannot be placed on the allowlist."
            )
        if maximum_output_bytes < 1 or maximum_output_bytes > 16_777_216:
            raise ConfigurationError("maximum_output_bytes is outside the safe range.")
        self.boundary = boundary
        self.approvals = approvals
        self.allowed_executables = normalized
        self.execution_enabled = execution_enabled
        self.maximum_output_bytes = maximum_output_bytes
        self._resolved_executables: dict[str, str] = {}

    def approve(self, request: ToolRequest, *, ttl_seconds: float = 60.0) -> str:
        """Explicitly approve the exact canonical request."""

        self._validate_request(request)
        return self.approvals.approve(request, ttl_seconds=ttl_seconds)

    def execute(
        self,
        request: ToolRequest,
        *,
        dry_run: bool = True,
        approval_token: str | None = None,
        cancellation_requested: Callable[[], bool] | None = None,
    ) -> ToolResult:
        """Preview or execute an approved argv request with `shell=False`."""

        executable, working_directory = self._validate_request(request)
        if dry_run:
            return ToolResult(
                status="dry-run",
                request_sha256=request.request_sha256,
                exit_code=None,
                duration_ms=0,
                stdout="",
                stderr="",
                truncated=False,
            )
        if not self.execution_enabled:
            raise ApprovalError("Real tool execution is disabled for this broker.")
        if approval_token is None:
            raise ApprovalError("Real tool execution requires an approval token.")
        self.approvals.consume(request, approval_token)
        if _is_cancellation_requested(cancellation_requested):
            raise ApprovalError("Approved tool was cancelled before process creation.")
        environment = _minimal_environment()
        environment.update(request.environment)
        start = time.monotonic()
        process, process_tree = _start_process_tree(
            [executable, *request.argv[1:]],
            cwd=working_directory,
            environment=environment,
        )
        deadline = start + request.timeout_seconds
        termination_reason: str | None = None
        try:
            while True:
                try:
                    stdout, stderr = process.communicate(timeout=_PROCESS_POLL_SECONDS)
                    break
                except subprocess.TimeoutExpired:
                    if _is_cancellation_requested(cancellation_requested):
                        termination_reason = "Approved tool was cancelled."
                        break
                    if time.monotonic() >= deadline:
                        termination_reason = "Approved tool exceeded its timeout."
                        break
            if termination_reason is not None:
                process_tree.terminate()
                raise ApprovalError(termination_reason)
        finally:
            # A successfully returned parent may still have launched background descendants.
            # Closing the managed tree is therefore mandatory on both success and failure.
            try:
                process_tree.terminate()
            finally:
                try:
                    process_tree.close()
                finally:
                    _wait_after_termination(process)
        duration_ms = max(0, round((time.monotonic() - start) * 1_000))
        stdout_value, stdout_truncated = self._decode(stdout)
        stderr_value, stderr_truncated = self._decode(stderr)
        return ToolResult(
            status="executed",
            request_sha256=request.request_sha256,
            exit_code=process.returncode,
            duration_ms=duration_ms,
            stdout=stdout_value,
            stderr=stderr_value,
            truncated=stdout_truncated or stderr_truncated,
        )

    def _validate_request(self, request: ToolRequest) -> tuple[str, Path]:
        command = request.argv[0].lower()
        if command not in self.allowed_executables:
            raise ApprovalError(f"Executable is not allowed: {request.argv[0]}")
        working_directory = self.boundary.resolve(request.cwd, must_exist=True)
        if not working_directory.is_dir():
            raise ApprovalError("Tool working directory is not a directory.")
        resolved_executable = self._resolved_executables.get(command)
        if resolved_executable is None:
            resolved_executable = _resolve_trusted_executable(
                request.argv[0],
                workspace_root=self.boundary.root,
            )
            self._resolved_executables[command] = resolved_executable
        return resolved_executable, working_directory

    def _decode(self, value: bytes) -> tuple[str, bool]:
        truncated = len(value) > self.maximum_output_bytes
        bounded = value[: self.maximum_output_bytes]
        return bounded.decode("utf-8", errors="replace"), truncated


def _minimal_environment() -> dict[str, str]:
    names = {
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    }
    return {name: value for name, value in os.environ.items() if name.upper() in names}


def _resolve_trusted_executable(command: str, *, workspace_root: Path) -> str:
    """Resolve a native executable from explicit PATH entries outside the workspace."""

    windows = os.name == "nt"
    command_suffix = Path(command).suffix.casefold()
    if windows and command_suffix in _WINDOWS_SHELL_SHIM_SUFFIXES:
        raise ApprovalError("Windows command-script shims are not executable tools.")

    path_entries: list[Path] = []
    for raw_entry in os.environ.get("PATH", "").split(os.pathsep):
        entry = os.path.expandvars(raw_entry.strip().strip('"'))
        if not entry:
            # Empty PATH entries mean the current directory, which is the untrusted workspace.
            continue
        try:
            resolved_entry = Path(entry).expanduser().resolve(strict=True)
        except OSError:
            continue
        if not resolved_entry.is_dir() or _is_within(resolved_entry, workspace_root):
            continue
        path_entries.append(resolved_entry)

    names = _executable_candidate_names(command, windows=windows)
    for directory in path_entries:
        for name in names:
            candidate = directory / name
            try:
                resolved = candidate.resolve(strict=True)
            except OSError:
                continue
            if not resolved.is_file() or _is_within(resolved, workspace_root):
                continue
            if windows:
                if (
                    resolved.suffix.casefold()
                    not in _WINDOWS_NATIVE_EXECUTABLE_SUFFIXES
                ):
                    continue
            elif not os.access(resolved, os.X_OK):
                continue
            return str(resolved)
    raise ApprovalError(f"A trusted native executable is not installed: {command}")


def _executable_candidate_names(command: str, *, windows: bool) -> tuple[str, ...]:
    if not windows:
        return (command,)
    suffix = Path(command).suffix.casefold()
    if suffix:
        return (command,) if suffix in _WINDOWS_NATIVE_EXECUTABLE_SUFFIXES else ()
    configured = [
        value.casefold()
        for value in os.environ.get("PATHEXT", ".COM;.EXE").split(os.pathsep)
        if value
    ]
    suffixes = [
        value for value in configured if value in _WINDOWS_NATIVE_EXECUTABLE_SUFFIXES
    ]
    for fallback in (".com", ".exe"):
        if fallback not in suffixes:
            suffixes.append(fallback)
    return tuple(f"{command}{suffix}" for suffix in suffixes)


def _is_within(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


class _ProcessTree:
    """Own one process tree and terminate every descendant before releasing it."""

    def __init__(
        self, process: subprocess.Popen[bytes], windows_job: int | None
    ) -> None:
        self.process = process
        self.windows_job = windows_job
        self.terminated = False
        self.closed = False

    def terminate(self) -> None:
        if self.closed or self.terminated:
            return
        if os.name == "nt" and self.windows_job is not None:
            _terminate_windows_job(self.windows_job)
            self.terminated = True
            return
        if os.name != "nt":
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.terminated = True
            return
        if self.process.poll() is None:
            self.process.kill()
        self.terminated = True

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if os.name == "nt" and self.windows_job is not None:
            _close_windows_handle(self.windows_job)


def _start_process_tree(
    argv: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
) -> tuple[subprocess.Popen[bytes], _ProcessTree]:
    keyword_arguments: dict[str, object] = {
        "cwd": cwd,
        "env": environment,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "shell": False,
    }
    if os.name == "nt":
        keyword_arguments["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        keyword_arguments["start_new_session"] = True
    try:
        process = subprocess.Popen(argv, **keyword_arguments)  # type: ignore[arg-type]
    except OSError as error:
        raise ApprovalError("Approved tool could not be started.") from error

    windows_job: int | None = None
    if os.name == "nt":
        try:
            windows_job = _create_windows_kill_on_close_job(process)
        except OSError as error:
            process.kill()
            _wait_after_termination(process)
            raise ApprovalError(
                "Approved tool could not enter a managed Windows process tree."
            ) from error
    return process, _ProcessTree(process, windows_job)


def _wait_after_termination(process: subprocess.Popen[bytes]) -> None:
    try:
        process.communicate(timeout=_PROCESS_CLEANUP_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()


def _is_cancellation_requested(callback: Callable[[], bool] | None) -> bool:
    if callback is None:
        return False
    try:
        return bool(callback())
    except Exception:  # noqa: BLE001 - a broken callback must request cancellation.
        # A broken cancellation channel cannot safely authorize continued execution.
        return True


def _create_windows_kill_on_close_job(process: subprocess.Popen[bytes]) -> int:
    import ctypes
    from ctypes import wintypes

    job_object_extended_limit_information = 9
    job_object_limit_kill_on_job_close = 0x00002000

    class IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimitInformation),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL

    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    information = ExtendedLimitInformation()
    information.BasicLimitInformation.LimitFlags = job_object_limit_kill_on_job_close
    if not kernel32.SetInformationJobObject(
        handle,
        job_object_extended_limit_information,
        ctypes.byref(information),
        ctypes.sizeof(information),
    ):
        error = ctypes.get_last_error()
        _close_windows_handle(int(handle))
        raise ctypes.WinError(error)
    process_handle = wintypes.HANDLE(int(process._handle))  # type: ignore[attr-defined]
    if not kernel32.AssignProcessToJobObject(handle, process_handle):
        error = ctypes.get_last_error()
        _close_windows_handle(int(handle))
        raise ctypes.WinError(error)
    return int(handle)


def _terminate_windows_job(handle: int) -> None:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    if not kernel32.TerminateJobObject(wintypes.HANDLE(handle), 1):
        raise ctypes.WinError(ctypes.get_last_error())


def _close_windows_handle(handle: int) -> None:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    if not kernel32.CloseHandle(wintypes.HANDLE(handle)):
        raise ctypes.WinError(ctypes.get_last_error())
