# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Cross-platform ownership for subprocesses and every descendant they create."""

from __future__ import annotations

import os
import signal
import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

_PROCESS_CLEANUP_SECONDS = 5.0


class ManagedProcessTree:
    """Own one process group or Windows Job Object until it is closed."""

    def __init__(
        self,
        process: Any,
        windows_job: int | None,
        *,
        contained: bool,
    ) -> None:
        self.process = process
        self.windows_job = windows_job
        self.contained = contained
        self.terminated = False
        self.closed = False

    def terminate(self) -> None:
        """Force-stop the managed process tree exactly once."""

        if self.closed or self.terminated:
            return
        if os.name == "nt" and self.windows_job is not None:
            _terminate_windows_job(self.windows_job)
            self.terminated = True
            return
        if os.name != "nt" and self.contained:
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
        """Release native ownership after callers have terminated the tree."""

        if self.closed:
            return
        self.closed = True
        if os.name == "nt" and self.windows_job is not None:
            _close_windows_handle(self.windows_job)


def start_managed_process(
    argv: list[str],
    *,
    cwd: str | Path,
    environment: Mapping[str, str],
    stdin: object = subprocess.DEVNULL,
    stdout: object = subprocess.PIPE,
    stderr: object = subprocess.PIPE,
    text: bool = False,
    process_factory: Callable[..., Any] = subprocess.Popen,
) -> tuple[Any, ManagedProcessTree]:
    """Start one shell-free process in a separately owned process tree.

    A custom ``process_factory`` is a deterministic unit-test seam. Only the
    real ``subprocess.Popen`` path is represented as OS-contained.
    """

    contained = process_factory is subprocess.Popen
    keyword_arguments: dict[str, object] = {
        "cwd": str(cwd),
        "env": dict(environment),
        "stdin": stdin,
        "stdout": stdout,
        "stderr": stderr,
        "shell": False,
        "text": text,
    }
    if os.name == "nt":
        keyword_arguments["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        keyword_arguments["start_new_session"] = True
    process = process_factory(argv, **keyword_arguments)

    windows_job: int | None = None
    if os.name == "nt" and contained:
        try:
            windows_job = _create_windows_kill_on_close_job(process)
        except OSError:
            process.kill()
            _wait_after_termination(process)
            raise
    return process, ManagedProcessTree(
        process,
        windows_job,
        contained=contained,
    )


def _wait_after_termination(process: subprocess.Popen[bytes]) -> None:
    try:
        process.wait(timeout=_PROCESS_CLEANUP_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


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
