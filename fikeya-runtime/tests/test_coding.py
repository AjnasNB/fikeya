# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import json
import socket
import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest
from fikeya_agent_core import ApprovalDecision, CancellationToken, ToolCall
from fikeya_agent_core.errors import CancellationError

from fikeya_runtime.browser import BrowserActionResult, BrowserError, BrowserReceipt
from fikeya_runtime.coding import CodingAgentRunner, WorkspaceExecutionBroker
from fikeya_runtime.credentials import CredentialResolver
from fikeya_runtime.inference import JsonResponse, ProviderExecutor
from fikeya_runtime.modes import AgentMode
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


@pytest.mark.parametrize(
    ("mode", "expected_tools"),
    [
        (
            AgentMode.ASK,
            {
                "workspace.list_files",
                "workspace.read_file",
                "workspace.search_text",
            },
        ),
        (
            AgentMode.PLAN,
            {
                "workspace.list_files",
                "workspace.read_file",
                "workspace.search_text",
            },
        ),
        (
            AgentMode.REVIEW,
            {
                "workspace.list_files",
                "workspace.read_file",
                "workspace.search_text",
            },
        ),
        (
            AgentMode.RESEARCH,
            {
                "browser.assert_text",
                "browser.click",
                "browser.close",
                "browser.navigate",
                "browser.scroll",
                "browser.snapshot",
                "browser.type",
                "browser.wait",
                "workspace.list_files",
                "workspace.read_file",
                "workspace.search_text",
            },
        ),
    ],
)
def test_non_build_modes_expose_only_their_mechanical_tool_policy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: AgentMode,
    expected_tools: set[str],
) -> None:
    root = tmp_path / mode.value
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    broker = WorkspaceExecutionBroker(workspace, mode=mode)
    tools = _run(broker.list_tools(CancellationToken()), monkeypatch)
    assert {tool.name for tool in tools} == expected_tools


def test_review_mode_rejects_a_forged_write_call_even_if_execution_is_invoked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "review"
    root.mkdir()
    target = root / "answer.py"
    target.write_text("VALUE = 1\n", encoding="utf-8")
    workspace, _ = initialize_workspace(root)
    broker = WorkspaceExecutionBroker(workspace, mode=AgentMode.REVIEW)
    result = _run(
        broker.execute(
            ToolCall(
                "write:forged",
                "workspace.write_file",
                {
                    "content": "VALUE = 2\n",
                    "expectedSha256": None,
                    "path": "answer.py",
                },
            ),
            CancellationToken(),
            idempotency_key="review-forged-write",
        ),
        monkeypatch,
    )
    assert result.status == "error"
    assert result.output == "Tool is unavailable in review mode."
    assert target.read_text(encoding="utf-8") == "VALUE = 1\n"
    assert [receipt.name for receipt in broker.state.receipts] == [
        "workspace.write_file"
    ]


class _FakeBrowserSession:
    def __init__(self) -> None:
        self.closed = False
        self.urls: list[str] = []

    def navigate(self, url: str) -> BrowserActionResult:
        self.urls.append(url)
        return BrowserActionResult(
            BrowserReceipt("navigate", url, "sha256:" + "1" * 64, 3)
        )

    def inspect(self, _kind: str) -> BrowserActionResult:
        return BrowserActionResult(
            BrowserReceipt(
                "inspect",
                self.urls[-1] if self.urls else None,
                "sha256:" + "4" * 64,
                2,
            ),
            text="Simulation ready",
        )

    def close(self) -> BrowserActionResult:
        self.closed = True
        return BrowserActionResult(
            BrowserReceipt(
                "close",
                self.urls[-1] if self.urls else None,
                "sha256:" + "2" * 64,
                1,
            )
        )


class _CancellableBrowserSession:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.closed = False

    def wait(
        self,
        _milliseconds: int,
        *,
        cancellation_requested: object,
    ) -> BrowserActionResult:
        assert callable(cancellation_requested)
        self.entered.set()
        deadline = time.monotonic() + 5
        while not cancellation_requested() and time.monotonic() < deadline:
            time.sleep(0.01)
        if cancellation_requested():
            raise BrowserError("Browser wait was cancelled.")
        raise AssertionError("Browser cancellation was not delivered.")

    def close(self) -> BrowserActionResult:
        self.closed = True
        return BrowserActionResult(
            BrowserReceipt("close", None, "sha256:" + "5" * 64, 1)
        )


def test_broker_cancellation_unwinds_browser_worker_before_close(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "cancel-browser"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    session = _CancellableBrowserSession()
    broker = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.BUILD,
        browser_session=session,  # type: ignore[arg-type]
    )
    token = CancellationToken()

    async def exercise() -> None:
        task = asyncio.create_task(
            broker.execute(
                ToolCall(
                    "browser:wait-cancel",
                    "browser.wait",
                    {"milliseconds": 10_000},
                ),
                token,
                idempotency_key="browser-wait-cancel",
            )
        )
        entered = await asyncio.to_thread(session.entered.wait, 5)
        assert entered
        token.cancel()
        with pytest.raises(CancellationError):
            await task

    _run(exercise(), monkeypatch)
    broker.close()
    assert session.closed
    assert broker.state.receipts == []


def test_build_mode_routes_browser_actions_and_records_content_minimal_receipts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "browser"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    session = _FakeBrowserSession()
    broker = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.BUILD,
        browser_session=session,  # type: ignore[arg-type]
    )

    result = _run(
        broker.execute(
            ToolCall(
                "browser:navigate",
                "browser.navigate",
                {"url": "https://example.com/docs?section=runtime"},
            ),
            CancellationToken(),
            idempotency_key="browser-navigation",
        ),
        monkeypatch,
    )

    assert result.status == "ok"
    assert json.loads(result.output) == {
        "receipt": {
            "action": "navigate",
            "durationMs": 3,
            "evidenceSha256": "sha256:" + "1" * 64,
            "url": "https://example.com/docs?section=runtime",
        },
        "truncated": False,
    }
    assert session.urls == ["https://example.com/docs?section=runtime"]
    assert [receipt.name for receipt in broker.state.receipts] == [
        "browser.navigate"
    ]
    asserted = _run(
        broker.execute(
            ToolCall(
                "browser:assert",
                "browser.assert_text",
                {"text": "Simulation ready"},
            ),
            CancellationToken(),
            idempotency_key="browser-assertion",
        ),
        monkeypatch,
    )
    assert asserted.status == "ok"
    assert [receipt.name for receipt in broker.state.receipts] == [
        "browser.navigate",
        "browser.assert_text",
    ]
    broker.close()
    assert session.closed is True


def test_browser_session_lifecycle_stays_on_one_dedicated_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import fikeya_runtime.coding as coding_module

    thread_ids: list[int] = []

    class ThreadBoundBrowser:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            self.thread_id = threading.get_ident()
            thread_ids.append(self.thread_id)

        def _result(self, action: str) -> BrowserActionResult:
            current = threading.get_ident()
            assert current == self.thread_id
            thread_ids.append(current)
            return BrowserActionResult(
                BrowserReceipt(
                    action,  # type: ignore[arg-type]
                    "https://example.com/",
                    "sha256:" + "3" * 64,
                    1,
                )
            )

        def navigate(self, _url: str) -> BrowserActionResult:
            return self._result("navigate")

        def inspect(self, _kind: str) -> BrowserActionResult:
            return self._result("inspect")

        def close(self) -> BrowserActionResult:
            return self._result("close")

    monkeypatch.setattr(coding_module, "BrowserSession", ThreadBoundBrowser)
    root = tmp_path / "thread-bound-browser"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    broker = WorkspaceExecutionBroker(workspace, mode=AgentMode.BUILD)

    async def exercise() -> None:
        await broker.execute(
            ToolCall(
                "browser:navigate",
                "browser.navigate",
                {"url": "https://example.com/"},
            ),
            CancellationToken(),
            idempotency_key="threaded-browser-navigate",
        )
        await broker.execute(
            ToolCall(
                "browser:snapshot",
                "browser.snapshot",
                {"kind": "accessible"},
            ),
            CancellationToken(),
            idempotency_key="threaded-browser-snapshot",
        )

    _run(exercise(), monkeypatch)
    broker.close()
    assert len(set(thread_ids)) == 1
    assert thread_ids[0] != threading.get_ident()


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


def test_broker_records_files_created_and_deleted_by_an_approved_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    removed = root / "removed.txt"
    removed.write_text("remove me", encoding="utf-8")
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )

    result = _run(
        broker.execute(
            ToolCall(
                "process:mutations",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        (
                            "from pathlib import Path; "
                            "Path('created.txt').write_text('created', encoding='utf-8'); "
                            "Path('removed.txt').unlink()"
                        ),
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="4" * 64,
        ),
        monkeypatch,
    )
    assert hasattr(result, "status") and result.status == "ok"
    output = json.loads(result.output)
    assert output["workspaceMutations"] == {
        "complete": True,
        "paths": ["created.txt", "removed.txt"],
        "truncated": False,
    }
    changed = {item.path: item for item in broker.state.changed_files.values()}
    assert changed["created.txt"].before_sha256 is None
    assert changed["created.txt"].after_sha256 is not None
    assert changed["removed.txt"].before_sha256 is not None
    assert changed["removed.txt"].after_sha256 is None
