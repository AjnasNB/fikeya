# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import socket
import sqlite3
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fikeya_agent_core import (
    AgentEvent,
    ApprovalDecision,
    EventKind,
    Stage,
    deterministic_read_sample_graph,
)
from fikeya_runtime.deep_agents_host import create_deep_agents_workspace_host
from fikeya_runtime.workspace import initialize_workspace

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


async def collect(events: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in events]


def _run(coroutine: object, monkeypatch: pytest.MonkeyPatch) -> object:
    """Permit only asyncio's Windows self-pipe; graph and broker stay offline."""

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    return asyncio.run(coroutine)  # type: ignore[arg-type]


def test_sample_graph_runs_through_real_durable_workspace_broker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _run(_run_approved_sample(tmp_path), monkeypatch)


async def _run_approved_sample(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("# Brokered sample\n", encoding="utf-8")
    workspace, _ = initialize_workspace(tmp_path)
    graph = deterministic_read_sample_graph("README.md")

    with create_deep_agents_workspace_host(graph, workspace, mode="review") as host:
        session = host.adapter.start(
            "Read README.md through the bounded workspace broker.",
            session_id="session:deep-agents-runtime-sample",
        )
        paused = await collect(host.adapter.stream(session.session_id))

        assert paused[-1].kind == EventKind.APPROVAL_REQUESTED
        assert host.broker.state.receipts == []
        assert host.adapter.interrupt(session.session_id) is not None

        completed = await collect(host.adapter.resume(session.session_id, ApprovalDecision.ALLOW_ONCE))

        assert completed[-1].kind == EventKind.SESSION_COMPLETED
        assert host.adapter.state(session.session_id).stage == Stage.COMPLETED
        assert len(host.broker.state.receipts) == 1
        assert host.broker.state.receipts[0].name == "workspace.read_file"
        assert graph.remaining == 0
        status = host.diagnostic.as_json()
        assert status["graphSource"] == "deterministic-sample"
        assert status["modelSource"] == "none"
        assert status["toolExecution"] == "fikeya-workspace-broker-only"

    with sqlite3.connect(workspace.state_path) as connection:
        row = connection.execute(
            "SELECT revision FROM agent_checkpoints WHERE session_id = ?",
            ("session:deep-agents-runtime-sample",),
        ).fetchone()
    assert row is not None and int(row[0]) > 0


def test_denied_sample_tool_never_executes_in_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _run(_run_denied_sample(tmp_path), monkeypatch)


async def _run_denied_sample(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("private until approved\n", encoding="utf-8")
    workspace, _ = initialize_workspace(tmp_path)
    graph = deterministic_read_sample_graph("README.md")

    with create_deep_agents_workspace_host(graph, workspace, mode="review") as host:
        session = host.adapter.start("Do not bypass denial.", session_id="session:deep-agents-runtime-denied")
        await collect(host.adapter.stream(session.session_id))

        denied = await collect(host.adapter.resume(session.session_id, ApprovalDecision.DENY_ONCE))

        assert denied[-1].kind == EventKind.SESSION_COMPLETED
        assert host.broker.state.receipts == []
        assert host.adapter.state(session.session_id).stage == Stage.COMPLETED
        assert host.adapter.state(session.session_id).observations[0].status == "denied"
