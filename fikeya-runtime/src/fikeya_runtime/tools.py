# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Approval-gated, argument-vector-only local tool execution."""

from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import time
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
                raise ConfigurationError("Every tool argument must be a non-empty string.")
            if len(argument) > 8_192:
                raise ConfigurationError("A tool argument exceeds 8192 characters.")
            if _SENSITIVE_ARGUMENT.match(argument):
                raise ConfigurationError(
                    "Credentials cannot be passed in tool arguments; use a dedicated adapter."
                )
        executable_name = Path(self.argv[0]).name.lower()
        if Path(self.argv[0]).name != self.argv[0]:
            raise ConfigurationError("Tool executable must be an allowlisted command name, not a path.")
        if executable_name in _COMMAND_INTERPRETERS:
            raise ConfigurationError("Command interpreters are not executable tools.")
        if Path(self.cwd).is_absolute() or "\x00" in self.cwd:
            raise ConfigurationError("Tool cwd must be a relative workspace path.")
        if not 0.1 <= self.timeout_seconds <= 300:
            raise ConfigurationError("Tool timeout must be between 0.1 and 300 seconds.")
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
            raise ConfigurationError("Tool broker requires a non-empty executable allowlist.")
        normalized = {name.lower() for name in allowed_executables}
        if normalized & _COMMAND_INTERPRETERS:
            raise ConfigurationError("Command interpreters cannot be placed on the allowlist.")
        if maximum_output_bytes < 1 or maximum_output_bytes > 16_777_216:
            raise ConfigurationError("maximum_output_bytes is outside the safe range.")
        self.boundary = boundary
        self.approvals = approvals
        self.allowed_executables = normalized
        self.execution_enabled = execution_enabled
        self.maximum_output_bytes = maximum_output_bytes

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
        environment = _minimal_environment()
        environment.update(request.environment)
        start = time.monotonic()
        try:
            completed = subprocess.run(
                [executable, *request.argv[1:]],
                cwd=working_directory,
                env=environment,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=request.timeout_seconds,
                check=False,
                shell=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ApprovalError("Approved tool exceeded its timeout.") from error
        duration_ms = max(0, round((time.monotonic() - start) * 1_000))
        stdout, stdout_truncated = self._decode(completed.stdout)
        stderr, stderr_truncated = self._decode(completed.stderr)
        return ToolResult(
            status="executed",
            request_sha256=request.request_sha256,
            exit_code=completed.returncode,
            duration_ms=duration_ms,
            stdout=stdout,
            stderr=stderr,
            truncated=stdout_truncated or stderr_truncated,
        )

    def _validate_request(self, request: ToolRequest) -> tuple[str, Path]:
        command = request.argv[0].lower()
        if command not in self.allowed_executables:
            raise ApprovalError(f"Executable is not allowed: {request.argv[0]}")
        resolved_executable = shutil.which(request.argv[0])
        if resolved_executable is None:
            raise ApprovalError(f"Executable is not installed: {request.argv[0]}")
        working_directory = self.boundary.resolve(request.cwd, must_exist=True)
        if not working_directory.is_dir():
            raise ApprovalError("Tool working directory is not a directory.")
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
