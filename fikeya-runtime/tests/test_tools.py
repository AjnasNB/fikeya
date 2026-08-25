# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import pytest

from fikeya_runtime.errors import ApprovalError, ConfigurationError
from fikeya_runtime.state import StateStore
from fikeya_runtime.tools import ApprovalLedger, ToolBroker, ToolRequest
from fikeya_runtime.workspace import WorkspaceBoundary


def _broker(tmp_path: Path, *, enabled: bool) -> ToolBroker:
    executable = Path(sys.executable).name
    state = StateStore(tmp_path / "state.sqlite3")
    return ToolBroker(
        boundary=WorkspaceBoundary(tmp_path),
        approvals=ApprovalLedger(state),
        allowed_executables={executable},
        execution_enabled=enabled,
    )


def test_tool_request_rejects_shells_sensitive_args_and_sensitive_env() -> None:
    with pytest.raises(ConfigurationError, match="interpreters"):
        ToolRequest(("powershell", "-Command", "Write-Output unsafe"))
    with pytest.raises(ConfigurationError, match="Credentials"):
        ToolRequest(("tool", "--api-key=private"))
    with pytest.raises(ConfigurationError, match="Sensitive environment"):
        ToolRequest(("tool", "status"), environment={"ACCESS_TOKEN": "private"})


def test_broker_defaults_to_dry_run_without_launching(tmp_path: Path) -> None:
    request = ToolRequest((Path(sys.executable).name, "--version"))
    result = _broker(tmp_path, enabled=False).execute(request)

    assert {
        "status": result.status,
        "exit_code": result.exit_code,
        "empty_output": result.stdout == result.stderr == "",
    } == {"status": "dry-run", "exit_code": None, "empty_output": True}


def test_real_execution_requires_exact_single_use_approval(tmp_path: Path) -> None:
    broker = _broker(tmp_path, enabled=True)
    request = ToolRequest((Path(sys.executable).name, "--version"))
    changed = ToolRequest((Path(sys.executable).name, "-V"))
    token = broker.approve(request)

    with pytest.raises(ApprovalError, match="does not match"):
        broker.execute(changed, dry_run=False, approval_token=token)
    result = broker.execute(request, dry_run=False, approval_token=token)
    with pytest.raises(ApprovalError, match="already"):
        broker.execute(request, dry_run=False, approval_token=token)

    assert {
        "status": result.status,
        "exit_code": result.exit_code,
        "mentions_python": "python" in f"{result.stdout}{result.stderr}".lower(),
    } == {"status": "executed", "exit_code": 0, "mentions_python": True}


def test_workspace_path_entry_cannot_shadow_an_allowlisted_executable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    command = "shadow-tool"
    shadow = tmp_path / (f"{command}.exe" if os.name == "nt" else command)
    shadow.write_bytes(b"not a trusted executable")
    if os.name != "nt":
        shadow.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    broker = ToolBroker(
        boundary=WorkspaceBoundary(tmp_path),
        approvals=ApprovalLedger(StateStore(tmp_path / "shadow-state.sqlite3")),
        allowed_executables={command},
        execution_enabled=True,
    )

    with pytest.raises(ApprovalError, match="trusted native executable"):
        broker.approve(ToolRequest((command, "--version")))


@pytest.mark.skipif(
    os.name != "nt", reason="Windows command shims are platform-specific"
)
def test_windows_command_shim_is_rejected_before_approval(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    tools = tmp_path / "tools"
    workspace.mkdir()
    tools.mkdir()
    (tools / "npm.cmd").write_text("@echo off\r\n", encoding="utf-8")
    monkeypatch.setenv("PATH", str(tools))
    monkeypatch.setenv("PATHEXT", ".CMD;.EXE")
    broker = ToolBroker(
        boundary=WorkspaceBoundary(workspace),
        approvals=ApprovalLedger(StateStore(workspace / "state.sqlite3")),
        allowed_executables={"npm"},
        execution_enabled=True,
    )

    with pytest.raises(ApprovalError, match="trusted native executable"):
        broker.approve(ToolRequest(("npm", "test")))


@pytest.mark.parametrize("cancel", (False, True), ids=("timeout", "cancellation"))
def test_timeout_or_cancellation_terminates_the_complete_process_tree(
    tmp_path: Path,
    cancel: bool,
) -> None:
    broker = _broker(tmp_path, enabled=True)
    marker = tmp_path / f"unexpected-{cancel}.txt"
    child = (
        "import pathlib,time; "
        "time.sleep(0.8); "
        f"pathlib.Path({str(marker)!r}).write_text('unexpected', encoding='utf-8')"
    )
    parent = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {child!r}]); "
        "time.sleep(30)"
    )
    request = ToolRequest(
        (Path(sys.executable).name, "-c", parent),
        timeout_seconds=2.0 if cancel else 0.2,
    )
    token = broker.approve(request)
    cancelled = threading.Event()
    timer = threading.Timer(0.2, cancelled.set) if cancel else None
    if timer is not None:
        timer.start()
    try:
        with pytest.raises(
            ApprovalError,
            match="cancelled" if cancel else "timeout",
        ):
            broker.execute(
                request,
                dry_run=False,
                approval_token=token,
                cancellation_requested=cancelled.is_set,
            )
    finally:
        if timer is not None:
            timer.cancel()

    time.sleep(1.0)
    assert not marker.exists()
