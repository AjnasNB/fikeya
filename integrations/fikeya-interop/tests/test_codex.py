from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from fikeya_interop import (
    MemoryReceiptSink,
    PathPolicy,
    PermissionDecision,
    PermissionRequest,
    PermissionResolution,
    ProcessPolicy,
    ProcessSpec,
    ResourceLimits,
)
from fikeya_interop.codex import CodexAppServerAdapter
from fikeya_interop.errors import LimitExceededError
from fikeya_interop.jsonrpc import JsonLineRpcProcess

FAKE_SERVER = Path(__file__).parent / "fakes" / "fake_codex_app_server.py"


class AllowOnceBroker:
    def __init__(self) -> None:
        self.requests: list[PermissionRequest] = []

    async def resolve(self, request: PermissionRequest) -> PermissionResolution:
        self.requests.append(request)
        return PermissionResolution(PermissionDecision.ALLOW_ONCE)


def process_policy(workspace: Path) -> ProcessPolicy:
    return ProcessPolicy(
        root=PathPolicy(workspace),
        allowed_commands=frozenset({Path(sys.executable).name}),
    )


def process_spec(workspace: Path) -> ProcessSpec:
    return ProcessSpec(
        identifier="fake-codex",
        command=sys.executable,
        args=(str(FAKE_SERVER),),
        cwd=workspace,
    )


@pytest.mark.asyncio
async def test_codex_adapter_negotiates_sessions_permissions_and_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-cross")
    broker = AllowOnceBroker()
    receipts = MemoryReceiptSink()
    notifications: list[str] = []

    async def observe(method: str, params: object) -> None:
        del params
        notifications.append(method)

    async with CodexAppServerAdapter(
        process_spec(workspace),
        process_policy(workspace),
        ResourceLimits(),
        receipts,
        permission_broker=broker,
        notification_handler=observe,
    ) as adapter:
        assert adapter.capabilities is not None
        assert adapter.capabilities.raw["sawSensitiveEnvironment"] is False
        started = await adapter.start_session(model="test-model")
        resumed = await adapter.resume_session(started.session_id)
        forked = await adapter.fork_session(started.session_id)
        turn_id = await adapter.start_turn(started.session_id, "private prompt that must not be retained")
        await adapter.cancel(started.session_id, turn_id)

    assert (started.session_id, resumed.session_id, forked.parent_session_id) == (
        "thread-1",
        "thread-1",
        "thread-1",
    )
    assert broker.requests[0].operation == "commandExecution"
    assert "turn/started" in notifications
    assert "turn/completed" in notifications
    receipt_json = json.dumps(receipts.as_dicts())
    assert "private prompt" not in receipt_json
    assert {receipt.operation for receipt in receipts.snapshot()} >= {
        "initialize",
        "thread/start",
        "thread/resume",
        "thread/fork",
        "turn/start",
        "turn/interrupt",
    }


@pytest.mark.asyncio
async def test_jsonl_transport_rejects_oversized_peer_output(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    limits = ResourceLimits(max_message_bytes=512)

    async with JsonLineRpcProcess(process_spec(workspace), process_policy(workspace), limits) as rpc:
        await rpc.request("initialize")
        await rpc.notify("initialized")
        with pytest.raises(LimitExceededError, match="exceeds"):
            await rpc.request("oversized")
