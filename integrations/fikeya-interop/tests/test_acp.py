from __future__ import annotations

import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from acp import PROTOCOL_VERSION, RequestError
from acp import schema as acp_schema

from fikeya_interop import (
    MemoryReceiptSink,
    PathPolicy,
    PermissionDecision,
    PermissionResolution,
    ProcessPolicy,
    ProcessSpec,
    ResourceLimits,
)
from fikeya_interop.acp import AcpAgentAdapter, FikeyaAcpHost


class FakeAcpConnection:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def initialize(self, protocol_version: int, **kwargs: object) -> acp_schema.InitializeResponse:
        self.calls.append("initialize")
        assert protocol_version == PROTOCOL_VERSION
        assert kwargs["client_capabilities"].terminal is False  # type: ignore[union-attr]
        return acp_schema.InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=acp_schema.AgentCapabilities(
                load_session=True,
                mcp_capabilities=acp_schema.McpCapabilities(http=True, sse=False, acp=False),
                session_capabilities=acp_schema.SessionCapabilities(
                    resume=acp_schema.SessionResumeCapabilities(),
                    fork=acp_schema.SessionForkCapabilities(),
                ),
            ),
            agent_info=acp_schema.Implementation(name="fake-agent", version="1.0"),
        )

    async def new_session(self, cwd: str, **kwargs: object) -> acp_schema.NewSessionResponse:
        del cwd, kwargs
        self.calls.append("new")
        return acp_schema.NewSessionResponse(session_id="session-1")

    async def resume_session(self, session_id: str, cwd: str, **kwargs: object) -> acp_schema.ResumeSessionResponse:
        del session_id, cwd, kwargs
        self.calls.append("resume")
        return acp_schema.ResumeSessionResponse()

    async def fork_session(self, session_id: str, cwd: str, **kwargs: object) -> acp_schema.ForkSessionResponse:
        del session_id, cwd, kwargs
        self.calls.append("fork")
        return acp_schema.ForkSessionResponse(session_id="session-fork")

    async def prompt(self, session_id: str, prompt: list[object], **kwargs: object) -> acp_schema.PromptResponse:
        del session_id, prompt, kwargs
        self.calls.append("prompt")
        return acp_schema.PromptResponse(stop_reason="end_turn")

    async def cancel(self, session_id: str, **kwargs: object) -> None:
        del session_id, kwargs
        self.calls.append("cancel")


class FakeAcpFactory:
    def __init__(self, connection: FakeAcpConnection) -> None:
        self.connection = connection

    @asynccontextmanager
    async def connect(self, host: object, spec: ProcessSpec, process_policy: ProcessPolicy):
        del host
        process_policy.validate(spec)
        yield self.connection


def policy(workspace: Path) -> ProcessPolicy:
    return ProcessPolicy(
        root=PathPolicy(workspace),
        allowed_commands=frozenset({Path(sys.executable).name}),
    )


@pytest.mark.asyncio
async def test_acp_adapter_negotiates_and_normalizes_session_lifecycle(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    receipts = MemoryReceiptSink()
    connection = FakeAcpConnection()
    spec = ProcessSpec("fake-acp", sys.executable, cwd=workspace)

    async with AcpAgentAdapter(
        spec,
        policy(workspace),
        ResourceLimits(),
        receipts,
        connection_factory=FakeAcpFactory(connection),
    ) as adapter:
        assert adapter.capabilities is not None
        assert adapter.capabilities.resume_session is True
        assert adapter.capabilities.fork_session is True
        assert adapter.capabilities.mcp_http is True
        session = await adapter.start_session()
        resumed = await adapter.resume_session(session.session_id)
        forked = await adapter.fork_session(session.session_id)
        stop_reason = await adapter.send_prompt(session.session_id, "private ACP prompt")
        await adapter.cancel(session.session_id)

    assert (resumed.session_id, forked.session_id, forked.parent_session_id, stop_reason) == (
        "session-1",
        "session-fork",
        "session-1",
        "end_turn",
    )
    assert connection.calls == ["initialize", "new", "resume", "fork", "prompt", "cancel"]
    assert "private ACP prompt" not in json.dumps(receipts.as_dicts())


@pytest.mark.asyncio
async def test_acp_host_maps_permission_choices_and_root_bounds_files(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    async def allow_once(request: object) -> PermissionResolution:
        del request
        return PermissionResolution(PermissionDecision.ALLOW_ONCE)

    host = FikeyaAcpHost(PathPolicy(workspace), ResourceLimits(), allow_once)
    response = await host.request_permission(
        "session-1",
        acp_schema.ToolCallUpdate(tool_call_id="tool-1", kind="edit", title="Edit a file"),
        [
            acp_schema.PermissionOption(option_id="yes", name="Allow once", kind="allow_once"),
            acp_schema.PermissionOption(option_id="no", name="Reject", kind="reject_once"),
        ],
    )
    await host.write_text_file("session-1", "notes.txt", "bounded content")
    read = await host.read_text_file("session-1", "notes.txt")

    assert response.outcome.option_id == "yes"  # type: ignore[union-attr]
    assert read.content == "bounded content"
    with pytest.raises(RequestError):
        await host.read_text_file("session-1", "../outside.txt")


@pytest.mark.asyncio
async def test_acp_host_keeps_terminal_callbacks_disabled(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    host = FikeyaAcpHost(PathPolicy(workspace), ResourceLimits())

    with pytest.raises(RequestError, match="execution broker"):
        await host.create_terminal("session-1", "powershell")
