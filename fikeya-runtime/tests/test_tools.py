# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import sys
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
