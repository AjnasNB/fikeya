# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import json
import socket
import sys
from collections import deque
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fikeya_agent_core import (
    AgentEvent,
    AgentOrchestrator,
    ApprovalDecision,
    ApprovalResponse,
    CancellationToken,
    DecisionKind,
    InMemoryCheckpointStore,
    ProviderDecision,
    ProviderResult,
    ReviewAction,
    Stage,
    ToolCall,
)

from fikeya_runtime.coding import WorkspaceExecutionBroker
from fikeya_runtime.mcp_broker import McpBrokerRegistry, broker_tool_name
from fikeya_runtime.modes import AgentMode
from fikeya_runtime.tool_presets import ToolEnablementStore, ToolPresetLoader
from fikeya_runtime.workspace import Workspace, initialize_workspace

_PRESET_ID = "cockroach-browser"
_SECRET = "deterministic-keyring-only-test-credential"
_UPSTREAM_TOOLS = (
    "browser_capabilities",
    "browser_health",
    "browser_sessions",
    "browser_snapshot",
    "browser_capture",
    "browser_network",
    "browser_audit",
    "browser_propose_action",
)
_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def _run(coroutine: object, monkeypatch: pytest.MonkeyPatch) -> object:
    """Permit only asyncio's Windows self-pipe connection."""

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    return asyncio.run(coroutine)  # type: ignore[arg-type]


class _ScriptedProvider:
    def __init__(self, *results: ProviderResult) -> None:
        self.results = deque(results)

    async def complete(
        self, _request: object, cancellation: CancellationToken
    ) -> ProviderResult:
        cancellation.raise_if_cancelled()
        return self.results.popleft()


def _provider_result(decision: ProviderDecision) -> ProviderResult:
    return ProviderResult(
        decision,
        provider_name="deterministic",
        model_name="deterministic-mcp-test",
    )


async def _collect(stream: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in stream]


def _approval_response(
    orchestrator: AgentOrchestrator,
    session_id: str,
    decision: ApprovalDecision,
) -> ApprovalResponse:
    request = orchestrator.state(session_id).pending_approval
    assert request is not None
    return ApprovalResponse(
        request.request_id,
        request.session_id,
        request.call_id,
        request.tool_name,
        request.arguments_sha256,
        request.expected_revision,
        decision,
    )


def test_enabled_preset_exposes_only_namespaced_tools_in_execution_modes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _run(_assert_namespaced_mode_tools(tmp_path), monkeypatch)


async def _assert_namespaced_mode_tools(tmp_path: Path) -> None:
    workspace = _workspace_with_fake_server(tmp_path)
    build_registry = _registry(workspace)
    build = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.BUILD,
        mcp_registry=build_registry,
    )
    try:
        build_names = {
            tool.name for tool in await build.list_tools(CancellationToken())
        }
        expected = {broker_tool_name(_PRESET_ID, name) for name in _UPSTREAM_TOOLS}
        assert expected <= build_names
        assert not set(_UPSTREAM_TOOLS) & build_names
    finally:
        build.close()

    review_registry = _registry(workspace)
    review = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.REVIEW,
        mcp_registry=review_registry,
    )
    try:
        review_names = {
            tool.name for tool in await review.list_tools(CancellationToken())
        }
        assert not any(name.startswith("mcp.") for name in review_names)
    finally:
        review.close()


def test_agent_core_pauses_before_namespaced_mcp_call_and_executes_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _run(_assert_exact_approval_execution(tmp_path), monkeypatch)


async def _assert_exact_approval_execution(tmp_path: Path) -> None:
    workspace = _workspace_with_fake_server(tmp_path)
    marker = workspace.root / "mcp-call-log.jsonl"
    tool_name = broker_tool_name(_PRESET_ID, "browser_capabilities")
    provider = _ScriptedProvider(
        _provider_result(
            ProviderDecision(DecisionKind.PLAN, content="Inspect browser capabilities.")
        ),
        _provider_result(
            ProviderDecision(
                DecisionKind.TOOL_CALL,
                tool_call=ToolCall(
                    "call:mcp-capabilities",
                    tool_name,
                    {"message": "approved bounded request"},
                ),
            )
        ),
        _provider_result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="The brokered MCP result was reviewed.",
                review_action=ReviewAction.COMPLETE,
            )
        ),
    )
    broker = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.BUILD,
        mcp_registry=_registry(workspace),
    )
    orchestrator = AgentOrchestrator(
        provider,
        broker,
        InMemoryCheckpointStore(),
    )
    session = orchestrator.start(
        "Inspect the enabled browser tool.",
        session_id="session:mcp-exact-approval",
    )
    try:
        await _collect(orchestrator.stream(session.session_id))
        paused = orchestrator.state(session.session_id)
        assert paused.stage is Stage.AWAITING_APPROVAL
        assert paused.pending_approval is not None
        assert paused.pending_approval.tool_name == tool_name
        assert not marker.exists()

        await _collect(
            orchestrator.stream(
                session.session_id,
                approval=_approval_response(
                    orchestrator,
                    session.session_id,
                    ApprovalDecision.ALLOW_ONCE,
                ),
            )
        )
        completed = orchestrator.state(session.session_id)
        assert completed.stage is Stage.COMPLETED
        assert len(completed.observations) == 1
        output = json.loads(completed.observations[0].output)
        assert output["effect"] == "read-and-propose"
        assert output["presetId"] == _PRESET_ID
        assert output["structuredContent"] == {"echo": "approved bounded request"}
        calls = [
            json.loads(line) for line in marker.read_text(encoding="utf-8").splitlines()
        ]
        assert calls == [
            {
                "arguments": {"message": "approved bounded request"},
                "name": "browser_capabilities",
            }
        ]
        assert [receipt.name for receipt in broker.state.receipts] == [tool_name]
    finally:
        broker.close()


def test_denied_namespaced_mcp_call_never_reaches_the_child(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _run(_assert_denied_call_does_not_execute(tmp_path), monkeypatch)


async def _assert_denied_call_does_not_execute(tmp_path: Path) -> None:
    workspace = _workspace_with_fake_server(tmp_path)
    marker = workspace.root / "mcp-call-log.jsonl"
    tool_name = broker_tool_name(_PRESET_ID, "browser_capabilities")
    provider = _ScriptedProvider(
        _provider_result(ProviderDecision(DecisionKind.PLAN, content="Inspect.")),
        _provider_result(
            ProviderDecision(
                DecisionKind.TOOL_CALL,
                tool_call=ToolCall(
                    "call:mcp-denied",
                    tool_name,
                    {"message": "must not execute"},
                ),
            )
        ),
        _provider_result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="The external call was denied.",
                review_action=ReviewAction.COMPLETE,
            )
        ),
    )
    broker = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.BUILD,
        mcp_registry=_registry(workspace),
    )
    orchestrator = AgentOrchestrator(
        provider,
        broker,
        InMemoryCheckpointStore(),
    )
    session = orchestrator.start(
        "Do not execute without approval.",
        session_id="session:mcp-denied",
    )
    try:
        await _collect(orchestrator.stream(session.session_id))
        await _collect(
            orchestrator.stream(
                session.session_id,
                approval=_approval_response(
                    orchestrator,
                    session.session_id,
                    ApprovalDecision.DENY_ONCE,
                ),
            )
        )
        assert orchestrator.state(session.session_id).stage is Stage.COMPLETED
        assert not marker.exists()
        assert broker.state.receipts == []
    finally:
        broker.close()


def _workspace_with_fake_server(tmp_path: Path) -> Workspace:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    loader = ToolPresetLoader()
    preset = loader.catalog.get(_PRESET_ID)
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    _write_fake_server(workspace.root / "mcp")
    return workspace


def _registry(workspace: Workspace) -> McpBrokerRegistry:
    return McpBrokerRegistry(
        workspace,
        secret_resolver=lambda _preset, _name: _SECRET,
        executable_resolver=lambda _command: sys.executable,
    )


def _write_fake_server(path: Path) -> None:
    source = f"""# deterministic fake MCP child for broker integration
import json
from pathlib import Path
import sys

TOOLS = {json.dumps(_UPSTREAM_TOOLS)}
MARKER = Path.cwd() / "mcp-call-log.jsonl"

def send(request_id, result):
    response = {{"jsonrpc": "2.0", "id": request_id, "result": result}}
    sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        send(request["id"], {{
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {{"tools": {{"listChanged": False}}}},
            "serverInfo": {{"name": "cockroach-browser", "version": "0.4.1"}}
        }})
    elif method == "tools/list":
        send(request["id"], {{"tools": [{{
            "name": name,
            "description": "Deterministic reviewed MCP tool",
            "inputSchema": {{
                "type": "object",
                "properties": {{"message": {{"type": "string"}}}},
                "required": ["message"],
                "additionalProperties": False
            }}
        }} for name in TOOLS]}})
    elif method == "tools/call":
        call = request["params"]
        with MARKER.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(call, sort_keys=True) + "\\n")
        message = call["arguments"]["message"]
        send(request["id"], {{
            "content": [{{"type": "text", "text": message}}],
            "isError": False,
            "structuredContent": {{"echo": message}}
        }})
"""
    path.write_text(source, encoding="utf-8")
