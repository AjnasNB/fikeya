# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from fikeya_runtime.qarinah import QarinahAdapter
from fikeya_runtime.state import StateStore


def test_query_uses_stdin_argv_boundary_and_persists_no_content(tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    response = json.dumps(
        {
            "items": [{"eventId": "evt_1"}, {"eventId": "evt_2"}],
            "retrieval": {"coverage": {"status": "direct"}},
        }
    )

    def runner(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append({"argv": argv, **kwargs})
        return subprocess.CompletedProcess(argv, 0, stdout=response, stderr="")

    state = StateStore(tmp_path / "state.sqlite3")
    session = state.create_session(session_id="ses_context")
    adapter = QarinahAdapter(
        workspace_root=tmp_path,
        state=state,
        executable="qarinah",
        runner=runner,
    )
    result = adapter.query(session.session_id, "private retrieval question")

    assert {
        "argv": calls[0]["argv"],
        "query_not_in_argv": "private retrieval question" not in str(calls[0]["argv"]),
        "shell": calls[0]["shell"],
        "coverage": result.receipt.coverage,
        "evidence_count": result.receipt.evidence_count,
        "response": result.content,
        "query_not_in_database": b"private retrieval question" not in state.path.read_bytes(),
        "response_not_in_database": response.encode("utf-8") not in state.path.read_bytes(),
    } == {
        "argv": ["qarinah", "query", "--stdin-json"],
        "query_not_in_argv": True,
        "shell": False,
        "coverage": "direct",
        "evidence_count": 2,
        "response": response,
        "query_not_in_database": True,
        "response_not_in_database": True,
    }


def test_diagnostic_accepts_only_zero_write_commands(tmp_path: Path) -> None:
    def runner(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(argv, 0, stdout="healthy\n", stderr="")

    state = StateStore(tmp_path / "state.sqlite3")
    adapter = QarinahAdapter(
        workspace_root=tmp_path,
        state=state,
        runner=runner,
    )

    assert adapter.diagnostic("doctor") == "healthy\n"
