# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import json
import socket
import sqlite3
import sys
from pathlib import Path

import pytest
from fikeya_agent_core import ApprovalDecision, CancellationToken, ToolCall

from fikeya_runtime.coding import CodingAgentRunner, WorkspaceExecutionBroker
from fikeya_runtime.credentials import CredentialResolver
from fikeya_runtime.inference import JsonResponse, ProviderExecutor
from fikeya_runtime.providers import ProviderKind, ProviderStore, build_profile
from fikeya_runtime.workspace import initialize_workspace

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def _run(coroutine: object, monkeypatch: pytest.MonkeyPatch) -> object:
    """Create asyncio's Windows self-pipe without permitting provider network I/O."""

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    return asyncio.run(coroutine)  # type: ignore[arg-type]


class MemorySecrets:
    def set(self, account: str, secret: str) -> str:
        raise AssertionError("local provider must not write a secret")

    def get(self, reference: str) -> str:
        raise AssertionError("local provider must not read a secret")

    def delete(self, reference: str) -> None:
        raise AssertionError("local provider must not delete a secret")


class ScriptedTransport:
    def __init__(self, decisions: list[dict[str, object]]) -> None:
        self.decisions = decisions
        self.calls = 0

    def post(self, *arguments: object, **keyword_arguments: object) -> JsonResponse:
        del arguments, keyword_arguments
        decision = self.decisions[self.calls]
        self.calls += 1
        body = {
            "choices": [{"message": {"content": json.dumps(decision)}}],
            "usage": {
                "completion_tokens": 5,
                "prompt_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 4},
            },
        }
        raw = json.dumps(body, separators=(",", ":")).encode()
        return JsonResponse(200, body, raw)


def _runner(
    tmp_path: Path,
    decisions: list[dict[str, object]],
) -> tuple[CodingAgentRunner, Path, ScriptedTransport]:
    root = tmp_path / "workspace"
    home = tmp_path / "home"
    root.mkdir()
    source = root / "answer.py"
    source.write_bytes(b"VALUE = 1\n")
    workspace, _ = initialize_workspace(root)
    providers = ProviderStore(home, MemorySecrets())
    providers.configure(
        build_profile(name="local", kind=ProviderKind.OLLAMA, model="qwen"),
        None,
    )
    transport = ScriptedTransport(decisions)
    executor = ProviderExecutor(transport)
    return (
        CodingAgentRunner(
            workspace,
            providers,
            executor=executor,
            credentials=CredentialResolver(providers),
            allowed_executables=frozenset({Path(sys.executable).name}),
        ),
        source,
        transport,
    )


def test_coding_loop_inspects_edits_tests_and_returns_structured_outcome(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_hash = __import__("hashlib").sha256(b"VALUE = 1\n").hexdigest()
    executable = Path(sys.executable).name
    decisions: list[dict[str, object]] = [
        {
            "kind": "plan",
            "content": "Inspect the file, edit it, and run a focused test.",
        },
        {
            "kind": "tool_call",
            "toolCall": {
                "arguments": {"path": "answer.py"},
                "callId": "read:answer",
                "name": "workspace.read_file",
            },
        },
        {
            "kind": "review",
            "reviewAction": "continue",
            "content": "Apply the verified edit.",
        },
        {
            "kind": "tool_call",
            "toolCall": {
                "arguments": {
                    "expectedSha256": initial_hash,
                    "newText": "VALUE = 2",
                    "oldText": "VALUE = 1",
                    "path": "answer.py",
                },
                "callId": "edit:answer",
                "name": "workspace.replace_text",
            },
        },
        {
            "kind": "review",
            "reviewAction": "continue",
            "content": "Verify the changed value.",
        },
        {
            "kind": "tool_call",
            "toolCall": {
                "arguments": {
                    "arguments": [
                        "-c",
                        "from pathlib import Path; assert 'VALUE = 2' in Path('answer.py').read_text()",
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
                "callId": "test:answer",
                "name": "process.run",
            },
        },
        {
            "kind": "review",
            "reviewAction": "complete",
            "content": "Updated answer.py and the focused test passed.",
        },
    ]
    runner, source, transport = _runner(tmp_path, decisions)
    approvals: list[dict[str, object]] = []

    async def approve(request: dict[str, object]) -> ApprovalDecision:
        approvals.append(request)
        return ApprovalDecision.ALLOW_ONCE

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Change VALUE to 2 and verify it.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )
    assert hasattr(result, "status")

    assert source.read_text(encoding="utf-8") == "VALUE = 2\n"
    assert result.status == "completed"
    assert result.output == "Updated answer.py and the focused test passed."
    assert result.plan.startswith("Inspect the file")
    assert transport.calls == 7
    assert [request["toolName"] for request in approvals] == [
        "workspace.read_file",
        "workspace.replace_text",
        "process.run",
    ]
    outcome = result.as_json()["outcome"]
    assert isinstance(outcome, dict)
    assert len(outcome["toolCalls"]) == 3
    assert all(
        __import__("re").fullmatch(r"sha256:[0-9a-f]{64}", item["outputSha256"])
        for item in outcome["toolCalls"]
    )
    assert outcome["tests"][0]["exitCode"] == 0
    assert outcome["changedFiles"][0]["path"] == "answer.py"
    assert result.usage == {
        "cachedInputTokens": 28,
        "inputTokens": 140,
        "measurement": "provider-reported",
        "outputTokens": 35,
    }

    persisted = b"".join(
        path.read_bytes()
        for path in runner.workspace.metadata_directory.glob("state.sqlite3*")
    )
    assert b"Change VALUE to 2" not in persisted
    assert b"Updated answer.py" not in persisted
    assert b"VALUE = 2" not in persisted
    with sqlite3.connect(runner.workspace.state_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM approvals").fetchone() == (1,)
        assert connection.execute(
            "SELECT COUNT(*) FROM provider_call_receipts"
        ).fetchone() == (7,)


def test_denied_edit_leaves_the_file_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_hash = __import__("hashlib").sha256(b"VALUE = 1\n").hexdigest()
    runner, source, _ = _runner(
        tmp_path,
        [
            {"kind": "plan", "content": "Request the edit."},
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {
                        "expectedSha256": initial_hash,
                        "newText": "VALUE = 9",
                        "oldText": "VALUE = 1",
                        "path": "answer.py",
                    },
                    "callId": "edit:denied",
                    "name": "workspace.replace_text",
                },
            },
            {
                "kind": "review",
                "reviewAction": "complete",
                "content": "The requested edit was denied.",
            },
        ],
    )

    async def deny(_request: dict[str, object]) -> ApprovalDecision:
        return ApprovalDecision.DENY_ONCE

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Try a denied edit.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=deny,
            memory_mode="off",
        ),
        monkeypatch,
    )
    assert hasattr(result, "status")

    assert source.read_text(encoding="utf-8") == "VALUE = 1\n"
    assert result.status == "completed"
    assert result.changed_files == ()
    assert result.tool_calls == ()


def test_cancelled_edit_stops_at_the_approval_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_hash = __import__("hashlib").sha256(b"VALUE = 1\n").hexdigest()
    runner, source, transport = _runner(
        tmp_path,
        [
            {"kind": "plan", "content": "Request the edit."},
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {
                        "expectedSha256": initial_hash,
                        "newText": "VALUE = 9",
                        "oldText": "VALUE = 1",
                        "path": "answer.py",
                    },
                    "callId": "edit:cancelled",
                    "name": "workspace.replace_text",
                },
            },
        ],
    )

    async def cancel(_request: dict[str, object]) -> ApprovalDecision:
        return ApprovalDecision.CANCEL

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Cancel this edit.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=cancel,
            memory_mode="off",
        ),
        monkeypatch,
    )
    assert hasattr(result, "status")

    assert source.read_text(encoding="utf-8") == "VALUE = 1\n"
    assert result.status == "cancelled"
    assert result.changed_files == ()
    assert result.tool_calls == ()
    assert transport.calls == 2


def test_denied_process_never_reaches_the_execution_broker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = Path(sys.executable).name
    runner, source, _ = _runner(
        tmp_path,
        [
            {"kind": "plan", "content": "Request a process operation."},
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {
                        "arguments": [
                            "-c",
                            "from pathlib import Path; Path('unexpected.txt').write_text('ran')",
                        ],
                        "cwd": ".",
                        "executable": executable,
                        "timeoutSeconds": 15,
                    },
                    "callId": "process:denied",
                    "name": "process.run",
                },
            },
            {
                "kind": "review",
                "reviewAction": "complete",
                "content": "The process request was denied and nothing was executed.",
            },
        ],
    )

    async def deny(_request: dict[str, object]) -> ApprovalDecision:
        return ApprovalDecision.DENY_ONCE

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Try a process operation.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=deny,
            memory_mode="off",
        ),
        monkeypatch,
    )
    assert hasattr(result, "status")

    assert not (source.parent / "unexpected.txt").exists()
    assert result.status == "completed"
    assert result.tool_calls == ()


def test_broker_rejects_stale_edits_and_workspace_escape(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    file = root / "value.txt"
    file.write_text("current", encoding="utf-8")
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({Path(sys.executable).name})
    )
    cancellation = CancellationToken()

    stale = _run(
        broker.execute(
            ToolCall(
                "edit:stale",
                "workspace.replace_text",
                {
                    "expectedSha256": "0" * 64,
                    "newText": "changed",
                    "oldText": "current",
                    "path": "value.txt",
                },
            ),
            cancellation,
            idempotency_key="1" * 64,
        ),
        monkeypatch,
    )
    escaped = _run(
        broker.execute(
            ToolCall("read:escape", "workspace.read_file", {"path": "../outside.txt"}),
            cancellation,
            idempotency_key="2" * 64,
        ),
        monkeypatch,
    )

    metadata_case_bypass = _run(
        broker.execute(
            ToolCall(
                "write:metadata-case",
                "workspace.write_file",
                {
                    "content": "must not be written",
                    "expectedSha256": None,
                    "path": ".FIKEYA/unsafe.txt",
                },
            ),
            cancellation,
            idempotency_key="3" * 64,
        ),
        monkeypatch,
    )
    assert (
        hasattr(stale, "status")
        and hasattr(escaped, "status")
        and hasattr(metadata_case_bypass, "status")
    )

    assert stale.status == "error"
    assert escaped.status == "error"
    assert metadata_case_bypass.status == "error"
    assert not (root / ".FIKEYA" / "unsafe.txt").exists()
    assert file.read_text(encoding="utf-8") == "current"
