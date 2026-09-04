# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import io
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fikeya_agent_core import (
    ApprovalDecision,
    CancellationToken,
    EvidenceCitation,
    EvidenceContext,
    ProviderRequest,
    RuntimeProviderAdapter,
    Stage,
    ToolCall,
    provider_context_bytes,
    render_system_instructions,
)

import fikeya_runtime.coding as coding_module
from fikeya_runtime.agent import MemoryPreparation
from fikeya_runtime.browser import BrowserActionResult, BrowserError, BrowserReceipt
from fikeya_runtime.coding import (
    ChangedFileReceipt,
    CodingAgentRunner,
    CodingRunResult,
    WorkspaceExecutionBroker,
)
from fikeya_runtime.conversation import (
    build_conversation_prompt,
    parse_conversation_history,
)
from fikeya_runtime.credentials import CredentialResolver
from fikeya_runtime.errors import ProviderConnectivityError
from fikeya_runtime.inference import MAX_REQUEST_BYTES, JsonResponse, ProviderExecutor
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
        self.payloads: list[bytes] = []

    def post(self, *arguments: object, **keyword_arguments: object) -> JsonResponse:
        del keyword_arguments
        payload = arguments[2]
        assert isinstance(payload, bytes)
        self.payloads.append(payload)
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
                        "-m",
                        "pytest",
                        "-q",
                        "test_answer.py",
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
    monkeypatch.setenv(
        "PATH", f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}"
    )
    (source.parent / "test_answer.py").write_text(
        "from answer import VALUE\n\ndef test_value():\n    assert VALUE == 2\n",
        encoding="utf-8",
    )
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
    assert outcome["changedFilesTruncated"] is False
    assert len(outcome["toolCalls"]) == 3
    assert all(
        __import__("re").fullmatch(r"sha256:[0-9a-f]{64}", item["outputSha256"])
        for item in outcome["toolCalls"]
    )
    assert outcome["tests"][0]["exitCode"] == 0
    assert outcome["changedFiles"][0]["path"] == "answer.py"
    assert __import__("re").fullmatch(
        r"sha256:[0-9a-f]{64}", outcome["changedFiles"][0]["beforeSha256"]
    )
    assert __import__("re").fullmatch(
        r"sha256:[0-9a-f]{64}", outcome["changedFiles"][0]["afterSha256"]
    )
    assert outcome["changedFiles"][0]["operation"] == "edit"
    assert outcome["changedFiles"][0]["beforeBytes"] == 10
    assert outcome["changedFiles"][0]["afterBytes"] == 10
    assert outcome["changedFiles"][0]["linesAdded"] == 1
    assert outcome["changedFiles"][0]["linesDeleted"] == 1
    assert outcome["changedFiles"][0]["lineDeltaStatus"] == "exact"
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


def test_cumulative_maximum_tool_results_reach_the_later_review_provider_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decisions: list[dict[str, object]] = [
        {"kind": "plan", "content": "Read each bounded result, then review."},
    ]
    for index in range(3):
        decisions.append(
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {"path": f"controls-{index}.txt"},
                    "callId": f"read:controls:{index}",
                    "name": "workspace.read_file",
                },
            }
        )
        decisions.append(
            {
                "kind": "review",
                "reviewAction": "complete" if index == 2 else "continue",
                "content": (
                    "All three bounded reads reached final review."
                    if index == 2
                    else f"Read the next result after {index + 1}."
                ),
            }
        )
    runner, source, transport = _runner(tmp_path, decisions)
    for index in range(3):
        (source.parent / f"controls-{index}.txt").write_bytes(b"\x01" * 1_048_576)

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        return ApprovalDecision.ALLOW_ONCE

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Read all three control-heavy files and review their measured results.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )

    assert result.status == "completed"
    assert result.output == "All three bounded reads reached final review."
    assert transport.calls == 7
    assert len(transport.payloads) == 7
    assert all(len(payload) <= MAX_REQUEST_BYTES for payload in transport.payloads)
    final_payload = transport.payloads[-1]
    assert b"fikeya-context-truncated-v1" in final_payload
    assert (
        result.tool_calls[0].output_sha256.removeprefix("sha256:").encode()
        in final_payload
    )
    assert b"read:controls:1" in final_payload
    assert b"read:controls:2" in final_payload


@pytest.mark.parametrize(
    "attachment_text",
    [
        "A" * (384 * 1024),
        "界" * (128 * 1024),
    ],
    ids=("ascii", "utf8"),
)
def test_exact_wire_budget_accepts_full_desktop_context_with_actual_tools(
    attachment_text: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner, source, transport = _runner(
        tmp_path,
        [{"kind": "plan", "content": "The complete context reached planning."}],
    )
    broker = WorkspaceExecutionBroker(runner.workspace)
    tools = _run(broker.list_tools(CancellationToken()), monkeypatch)
    assert len(tools) == 15
    history = parse_conversation_history(
        [
            {"role": "user", "content": "H" * 16_000},
            {"role": "assistant", "content": "I" * 16_000},
            {"role": "user", "content": "J" * 16_000},
            {"role": "assistant", "content": "K" * 16_000},
        ]
    )
    current_prompt = ("P" * (256 * 1024)) + "\nATTACHED FILE TEXT\n" + attachment_text
    compiled_task = build_conversation_prompt(history, current_prompt)
    evidence = EvidenceContext.from_content(
        "Q" * 64_000,
        (
            EvidenceCitation(
                "event:maximum-context", "a" * 64, "qarinah:event:maximum-context"
            ),
        ),
    )
    safety_system = render_system_instructions(evidence)
    profile = runner.providers.get("local")
    provider_request = ProviderRequest(
        session_id="session:actual-tools-maximum-context",
        stage=Stage.PLAN,
        prompt=compiled_task,
        system=safety_system,
        plan="",
        observations=(),
        review_notes="",
        candidate_answer="",
        tools=tools,
        max_output_bytes=8_192,
    )
    assert provider_context_bytes(provider_request) > 768 * 1024
    adapter = RuntimeProviderAdapter(
        ProviderExecutor(transport),
        profile,
        lambda: None,
        allow_network=True,
    )

    result = _run(
        adapter.complete(provider_request, CancellationToken()),
        monkeypatch,
    )

    assert result.decision.content == "The complete context reached planning."
    assert transport.calls == 1
    assert len(transport.payloads[0]) > 768 * 1024
    assert len(transport.payloads[0]) <= MAX_REQUEST_BYTES
    assert b"fikeya-context-truncated-v1" not in transport.payloads[0]
    payload = json.loads(transport.payloads[0])
    assert payload["messages"][0]["content"] == safety_system
    rendered_prompt = payload["messages"][-1]["content"]
    context = json.loads(rendered_prompt.split("\nInput:\n", 1)[1])
    assert context["task"] == compiled_task
    assert len(context["tools"]) == 15
    assert source.read_bytes() == b"VALUE = 1\n"


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
    def __init__(self, root: Path) -> None:
        self.closed = False
        self.root = root
        self.screenshot_count = 0
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

    def screenshot(self, relative_path: str) -> BrowserActionResult:
        self.screenshot_count += 1
        payload = b"\x89PNG\r\n\x1a\n\0" + bytes([self.screenshot_count])
        (self.root / relative_path).write_bytes(payload)
        return BrowserActionResult(
            BrowserReceipt(
                "screenshot",
                self.urls[-1] if self.urls else None,
                "sha256:" + "6" * 64,
                4,
            ),
            screenshot_path=relative_path,
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


def test_broker_cancellation_returns_exact_browser_error_before_close(
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
        result = await task
        assert result.status == "error"
        assert result.output == "Browser wait was cancelled."

    _run(exercise(), monkeypatch)
    broker.close()
    assert session.closed
    assert [receipt.call_id for receipt in broker.state.receipts] == [
        "browser:wait-cancel"
    ]
    assert broker.state.receipts[0].status == "error"


def test_build_mode_routes_browser_actions_and_records_content_minimal_receipts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "browser"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    session = _FakeBrowserSession(root)
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
    assert [receipt.name for receipt in broker.state.receipts] == ["browser.navigate"]
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
    first_screenshot = _run(
        broker.execute(
            ToolCall(
                "browser:screenshot:first",
                "browser.screenshot",
                {"path": "proof.png"},
            ),
            CancellationToken(),
            idempotency_key="browser-screenshot-first",
        ),
        monkeypatch,
    )
    first_change = json.loads(first_screenshot.output)["fileChange"]
    assert first_change["operation"] == "add"
    assert first_change["beforeSha256"] is None
    assert first_change["afterSha256"].startswith("sha256:")
    assert first_change["beforeBytes"] is None
    assert first_change["afterBytes"] == 10
    assert first_change["lineDeltaStatus"] == "binary"

    second_screenshot = _run(
        broker.execute(
            ToolCall(
                "browser:screenshot:second",
                "browser.screenshot",
                {"path": "proof.png"},
            ),
            CancellationToken(),
            idempotency_key="browser-screenshot-second",
        ),
        monkeypatch,
    )
    second_change = json.loads(second_screenshot.output)["fileChange"]
    assert second_change["operation"] == "edit"
    assert second_change["beforeSha256"] != second_change["afterSha256"]
    run_change = broker.state.changed_files["proof.png"]
    assert run_change.operation == "add"
    assert run_change.before_sha256 is None
    assert run_change.after_sha256 == second_change["afterSha256"]
    broker.close()
    assert session.closed is True


def test_browser_screenshot_write_then_error_still_records_file_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "browser-error-after-write"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    session = _FakeBrowserSession(root)

    def screenshot_then_error(relative_path: str) -> BrowserActionResult:
        (root / relative_path).write_bytes(b"\x89PNG\r\n\x1a\npost-write")
        raise BrowserError("page closed after screenshot write")

    monkeypatch.setattr(session, "screenshot", screenshot_then_error)
    broker = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.BUILD,
        browser_session=session,  # type: ignore[arg-type]
    )

    result = _run(
        broker.execute(
            ToolCall(
                "browser:screenshot:error",
                "browser.screenshot",
                {"path": "proof.png"},
            ),
            CancellationToken(),
            idempotency_key="browser-screenshot-error",
        ),
        monkeypatch,
    )

    assert result.status == "error"
    assert result.output == "page closed after screenshot write"
    assert (root / "proof.png").read_bytes().startswith(b"\x89PNG")
    change = broker.state.changed_files["proof.png"]
    assert change.operation == "add"
    assert change.before_exists is False
    assert change.after_exists is True
    assert broker.state.receipts[0].call_id == "browser:screenshot:error"
    assert broker.state.receipts[0].status == "error"
    broker.close()


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


def test_broker_rejects_direct_writes_edits_and_screenshots_in_reserved_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    qarinah_config = root / ".qarinah" / "config.json"
    qarinah_config.parent.mkdir()
    qarinah_config.write_text("original", encoding="utf-8")
    broker = WorkspaceExecutionBroker(workspace)
    broker._browser = _FakeBrowserSession(root)  # noqa: SLF001 - exercise the path gate.
    cancellation = CancellationToken()

    write = _run(
        broker.execute(
            ToolCall(
                "write:vcs-state",
                "workspace.write_file",
                {"content": "unsafe", "expectedSha256": None, "path": ".git/config"},
            ),
            cancellation,
            idempotency_key="a" * 64,
        ),
        monkeypatch,
    )
    edit = _run(
        broker.execute(
            ToolCall(
                "edit:qarinah-state",
                "workspace.replace_text",
                {
                    "expectedSha256": __import__("hashlib").sha256(b"original").hexdigest(),
                    "newText": "unsafe",
                    "oldText": "original",
                    "path": ".qarinah/config.json",
                },
            ),
            cancellation,
            idempotency_key="b" * 64,
        ),
        monkeypatch,
    )
    screenshot = _run(
        broker.execute(
            ToolCall(
                "browser:reserved-screenshot",
                "browser.screenshot",
                {"path": ".hg/proof.png"},
            ),
            cancellation,
            idempotency_key="c" * 64,
        ),
        monkeypatch,
    )

    assert write.status == "error"
    assert edit.status == "error"
    assert screenshot.status == "error"
    assert not (root / ".git").exists()
    assert not (root / ".hg").exists()
    assert qarinah_config.read_text(encoding="utf-8") == "original"
    assert broker.state.changed_files == {}
    broker.close()


def test_broker_can_list_and_read_regular_build_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    artifact = root / "build" / "report.txt"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"measured artifact\n")
    workspace, _ = initialize_workspace(root)
    # Runtime-owned state remains outside provider-visible file reads.
    runtime_state = root / ".fikeya" / "private.txt"
    runtime_state.parent.mkdir(exist_ok=True)
    runtime_state.write_text("private\n", encoding="utf-8")
    broker = WorkspaceExecutionBroker(workspace)
    cancellation = CancellationToken()

    listed = _run(
        broker.execute(
            ToolCall("list:build-artifact", "workspace.list_files", {}),
            cancellation,
            idempotency_key="d" * 64,
        ),
        monkeypatch,
    )
    read = _run(
        broker.execute(
            ToolCall(
                "read:build-artifact",
                "workspace.read_file",
                {"path": "build/report.txt"},
            ),
            cancellation,
            idempotency_key="e" * 64,
        ),
        monkeypatch,
    )
    blocked_runtime_read = _run(
        broker.execute(
            ToolCall(
                "read:runtime-state",
                "workspace.read_file",
                {"path": ".fikeya/private.txt"},
            ),
            cancellation,
            idempotency_key="f" * 64,
        ),
        monkeypatch,
    )

    assert listed.status == "ok"
    assert "build/report.txt" in json.loads(listed.output)["files"]
    assert read.status == "ok"
    assert json.loads(read.output)["content"] == "measured artifact\n"
    assert blocked_runtime_read.status == "error"
    broker.close()


def test_replace_text_rechecks_identity_inside_atomic_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "replace-race"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    target = root / "value.txt"
    target.write_text("initial", encoding="utf-8")
    expected = __import__("hashlib").sha256(b"initial").hexdigest()
    broker = WorkspaceExecutionBroker(workspace)
    original_atomic_write = broker._atomic_write

    def concurrent_write(
        path: Path,
        content: str,
        *,
        expected_before: object,
    ) -> None:
        path.write_text("concurrent-user-edit", encoding="utf-8")
        original_atomic_write(
            path,
            content,
            expected_before=expected_before,  # type: ignore[arg-type]
        )

    monkeypatch.setattr(broker, "_atomic_write", concurrent_write)
    result = _run(
        broker.execute(
            ToolCall(
                "edit:race",
                "workspace.replace_text",
                {
                    "expectedSha256": expected,
                    "newText": "agent-edit",
                    "oldText": "initial",
                    "path": "value.txt",
                },
            ),
            CancellationToken(),
            idempotency_key="replace-race",
        ),
        monkeypatch,
    )

    assert result.status == "error"
    assert "changed concurrently" in result.output
    assert target.read_text(encoding="utf-8") == "concurrent-user-edit"
    assert broker.state.changed_files == {}


def test_new_file_write_uses_exclusive_atomic_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "create-race"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    target = root / "new.txt"
    broker = WorkspaceExecutionBroker(workspace)
    original_atomic_write = broker._atomic_write

    def concurrent_create(
        path: Path,
        content: str,
        *,
        expected_before: object,
    ) -> None:
        path.write_text("concurrent-user-create", encoding="utf-8")
        original_atomic_write(
            path,
            content,
            expected_before=expected_before,  # type: ignore[arg-type]
        )

    monkeypatch.setattr(broker, "_atomic_write", concurrent_create)
    result = _run(
        broker.execute(
            ToolCall(
                "write:race",
                "workspace.write_file",
                {
                    "content": "agent-create",
                    "expectedSha256": None,
                    "path": "new.txt",
                },
            ),
            CancellationToken(),
            idempotency_key="create-race",
        ),
        monkeypatch,
    )

    assert result.status == "error"
    assert "created concurrently" in result.output
    assert target.read_text(encoding="utf-8") == "concurrent-user-create"
    assert broker.state.changed_files == {}


def test_write_file_null_precondition_never_overwrites_an_unmeasured_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    target = root / "large.bin"
    target.write_bytes(b"x" * (16 * 1024 * 1024 + 1))
    broker = WorkspaceExecutionBroker(workspace)
    result = _run(
        broker.execute(
            ToolCall(
                "write:large-precondition",
                "workspace.write_file",
                {
                    "content": "oops",
                    "expectedSha256": None,
                    "path": "large.bin",
                },
            ),
            CancellationToken(),
            idempotency_key="f" * 64,
        ),
        monkeypatch,
    )
    assert result.status == "error"
    assert target.stat().st_size == 16 * 1024 * 1024 + 1
    assert target.read_bytes()[-1:] == b"x"


def test_broker_reports_exact_process_file_mutations_and_conservative_rename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    removed = root / "removed.txt"
    removed.write_text("remove me", encoding="utf-8")
    edited = root / "edited.txt"
    edited.write_text("first\nsecond\n", encoding="utf-8")
    (root / "rename-before.txt").write_text("same\n", encoding="utf-8")
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
                            "Path('edited.txt').write_text('first\\nchanged\\nthird\\n', encoding='utf-8'); "
                            "Path('removed.txt').unlink(); "
                            "Path('rename-before.txt').rename('rename-after.txt')"
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
    mutations = output["workspaceMutations"]
    assert mutations["complete"] is True
    assert mutations["paths"] == [
        "created.txt",
        "edited.txt",
        "removed.txt",
        "rename-after.txt",
        "rename-before.txt",
    ]
    assert mutations["truncated"] is False
    mutation_changes = {item["path"]: item for item in mutations["changes"]}
    assert mutation_changes["created.txt"]["operation"] == "add"
    assert mutation_changes["created.txt"]["beforeBytes"] is None
    assert mutation_changes["created.txt"]["afterBytes"] == 7
    assert mutation_changes["created.txt"]["linesAdded"] == 1
    assert mutation_changes["created.txt"]["linesDeleted"] == 0
    assert mutation_changes["edited.txt"]["operation"] == "edit"
    assert mutation_changes["edited.txt"]["linesAdded"] == 2
    assert mutation_changes["edited.txt"]["linesDeleted"] == 1
    assert mutation_changes["removed.txt"]["operation"] == "delete"
    assert mutation_changes["removed.txt"]["beforeBytes"] == 9
    assert mutation_changes["removed.txt"]["afterBytes"] is None
    assert mutation_changes["removed.txt"]["linesAdded"] == 0
    assert mutation_changes["removed.txt"]["linesDeleted"] == 1
    assert mutation_changes["rename-after.txt"]["operation"] == "add"
    assert mutation_changes["rename-before.txt"]["operation"] == "delete"
    assert (
        mutation_changes["rename-after.txt"]["afterSha256"]
        == mutation_changes["rename-before.txt"]["beforeSha256"]
    )
    changed = {item.path: item for item in broker.state.changed_files.values()}
    assert changed["created.txt"].before_sha256 is None
    assert changed["created.txt"].after_sha256 is not None
    assert changed["created.txt"].line_delta_status == "exact"
    assert changed["edited.txt"].operation == "edit"
    assert changed["edited.txt"].lines_added == 2
    assert changed["edited.txt"].lines_deleted == 1
    assert changed["removed.txt"].before_sha256 is not None
    assert changed["removed.txt"].after_sha256 is None
    assert changed["removed.txt"].line_delta_status == "exact"


def test_broker_coalesces_multiple_direct_edits_against_the_run_preimage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    target = root / "multi.txt"
    original = "one\ntwo\n"
    target.write_bytes(original.encode("utf-8"))
    broker = WorkspaceExecutionBroker(workspace)

    async def replace(
        call_id: str, expected: str, old_text: str, new_text: str, key: str
    ) -> object:
        return await broker.execute(
            ToolCall(
                call_id,
                "workspace.replace_text",
                {
                    "expectedSha256": expected,
                    "newText": new_text,
                    "oldText": old_text,
                    "path": "multi.txt",
                },
            ),
            CancellationToken(),
            idempotency_key=key,
        )

    original_hash = __import__("hashlib").sha256(original.encode()).hexdigest()
    first = _run(
        replace("edit:first", original_hash, "one", "ONE", "5" * 64), monkeypatch
    )
    assert json.loads(first.output)["linesAdded"] == 1
    first_hash = __import__("hashlib").sha256(target.read_bytes()).hexdigest()
    _run(replace("edit:second", first_hash, "two", "TWO", "6" * 64), monkeypatch)

    run_change = broker.state.changed_files["multi.txt"]
    assert run_change.before_sha256 == f"sha256:{original_hash}"
    assert run_change.operation == "edit"
    assert run_change.lines_added == 2
    assert run_change.lines_deleted == 2
    assert run_change.line_delta_status == "exact"

    second_hash = __import__("hashlib").sha256(target.read_bytes()).hexdigest()
    _run(
        broker.execute(
            ToolCall(
                "edit:revert",
                "workspace.write_file",
                {
                    "content": original,
                    "expectedSha256": second_hash,
                    "path": "multi.txt",
                },
            ),
            CancellationToken(),
            idempotency_key="7" * 64,
        ),
        monkeypatch,
    )
    assert broker.state.changed_files == {}
    assert broker.state.original_file_snapshots == {}
    assert broker.state.original_snapshot_bytes == 0


def test_process_mutation_reports_binary_and_large_line_delta_fallbacks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    (root / "binary.bin").write_bytes(b"\0before")
    (root / "large.txt").write_text("a" * 1_048_577, encoding="utf-8")
    (root / "many-lines.txt").write_text("x\n" * 20_001, encoding="utf-8")
    (root / "repetitive.txt").write_text("a\nb\n" * 300, encoding="utf-8")
    threshold_bytes = 16 * 1024 * 1024 + 1
    (root / "threshold.txt").write_bytes(b"x" * threshold_bytes)
    (root / "small-delete.txt").write_text("delete", encoding="utf-8")
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )

    result = _run(
        broker.execute(
            ToolCall(
                "process:fallbacks",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        (
                            "from pathlib import Path; "
                            "Path('binary.bin').write_bytes(b'\\0after'); "
                            "p=Path('large.txt'); "
                            "p.write_text(p.read_text(encoding='utf-8')+'b', encoding='utf-8'); "
                            "p=Path('many-lines.txt'); "
                            "p.write_text(p.read_text(encoding='utf-8')+'y\\n', encoding='utf-8'); "
                            "Path('repetitive.txt').write_text('b\\na\\n'*300, encoding='utf-8'); "
                            "Path('threshold.txt').write_text('z', encoding='utf-8'); "
                            "Path('small-add.txt').write_text('add', encoding='utf-8'); "
                            "Path('small-delete.txt').unlink()"
                        ),
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="8" * 64,
        ),
        monkeypatch,
    )
    assert hasattr(result, "status") and result.status == "ok"
    changes = {
        item["path"]: item
        for item in json.loads(result.output)["workspaceMutations"]["changes"]
    }
    assert changes["binary.bin"]["lineDeltaStatus"] == "binary"
    assert changes["binary.bin"]["linesAdded"] is None
    assert changes["binary.bin"]["linesDeleted"] is None
    assert changes["large.txt"]["lineDeltaStatus"] == "too-large"
    assert changes["large.txt"]["linesAdded"] is None
    assert changes["large.txt"]["linesDeleted"] is None
    assert changes["many-lines.txt"]["lineDeltaStatus"] == "too-large"
    assert changes["many-lines.txt"]["linesAdded"] is None
    assert changes["many-lines.txt"]["linesDeleted"] is None
    assert changes["repetitive.txt"]["lineDeltaStatus"] == "too-large"
    assert changes["repetitive.txt"]["linesAdded"] is None
    assert changes["repetitive.txt"]["linesDeleted"] is None
    assert changes["threshold.txt"]["operation"] == "edit"
    assert changes["threshold.txt"]["beforeSha256"] is None
    assert changes["threshold.txt"]["afterSha256"] is not None
    assert changes["threshold.txt"]["beforeBytes"] == threshold_bytes
    assert changes["threshold.txt"]["afterBytes"] == 1
    assert changes["threshold.txt"]["lineDeltaStatus"] == "too-large"
    assert changes["small-add.txt"]["operation"] == "add"
    assert changes["small-delete.txt"]["operation"] == "delete"


def test_run_level_changed_file_limit_survives_multiple_process_calls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )
    monkeypatch.setattr(coding_module, "_MAX_RECORDED_MUTATIONS", 3)

    for index, names in enumerate((("a.txt", "b.txt"), ("c.txt", "d.txt"))):
        script = "; ".join(
            f"Path({name!r}).write_text('x', encoding='utf-8')" for name in names
        )
        result = _run(
            broker.execute(
                ToolCall(
                    f"process:bounded:{index}",
                    "process.run",
                    {
                        "arguments": ["-c", f"from pathlib import Path; {script}"],
                        "cwd": ".",
                        "executable": executable,
                        "timeoutSeconds": 15,
                    },
                ),
                CancellationToken(),
                idempotency_key=str(index + 1) * 64,
            ),
            monkeypatch,
        )
        assert hasattr(result, "status") and result.status == "ok"

    assert sorted(broker.state.changed_files) == ["a.txt", "b.txt", "c.txt"]
    assert broker.state.changed_files_truncated is True


def test_single_process_mutation_overflow_marks_run_evidence_truncated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )
    monkeypatch.setattr(coding_module, "_MAX_RECORDED_MUTATIONS", 3)
    script = "; ".join(
        f"Path({name!r}).write_text('x', encoding='utf-8')"
        for name in ("a.txt", "b.txt", "c.txt", "d.txt")
    )

    result = _run(
        broker.execute(
            ToolCall(
                "process:overflow",
                "process.run",
                {
                    "arguments": ["-c", f"from pathlib import Path; {script}"],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="9" * 64,
        ),
        monkeypatch,
    )
    mutations = json.loads(result.output)["workspaceMutations"]
    assert mutations["truncated"] is True
    assert mutations["complete"] is False
    assert len(mutations["changes"]) == 3
    assert broker.state.changed_files_truncated is True


def test_timed_out_process_still_records_workspace_mutations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )

    result = _run(
        broker.execute(
            ToolCall(
                "process:timeout-mutation",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        (
                            "from pathlib import Path; import time; "
                            "Path('timed-out.txt').write_text('changed', encoding='utf-8'); "
                            "assert True; time.sleep(5)"
                        ),
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 0.5,
                },
            ),
            CancellationToken(),
            idempotency_key="a" * 64,
        ),
        monkeypatch,
    )
    assert result.status == "error"
    assert (root / "timed-out.txt").read_text(encoding="utf-8") == "changed"
    change = broker.state.changed_files["timed-out.txt"]
    assert change.operation == "add"
    assert change.before_sha256 is None
    assert change.after_sha256 is not None
    assert change.lines_added == 1
    assert broker.state.changed_files_truncated is False
    assert broker.state.receipts[-1].status == "error"
    assert broker.state.receipts[-1].test is False
    assert broker.state.receipts[-1].exit_code is None


def test_cancelled_process_returns_end_to_end_partial_mutation_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = Path(sys.executable).name
    runner, source, _ = _runner(
        tmp_path,
        [
            {"kind": "plan", "content": "Run the focused mutation test."},
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {
                        "arguments": [
                            "-c",
                            (
                                "from pathlib import Path; import time; "
                                "Path('cancelled-change.txt').write_text('changed', encoding='utf-8'); "
                                "assert True; time.sleep(10)"
                            ),
                        ],
                        "cwd": ".",
                        "executable": executable,
                        "timeoutSeconds": 15,
                    },
                    "callId": "process:cancelled-test",
                    "name": "process.run",
                },
            },
        ],
    )
    token = CancellationToken()
    changed = source.parent / "cancelled-change.txt"

    def cancel_after_write() -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not changed.exists():
            time.sleep(0.01)
        token.cancel()

    canceller = threading.Thread(target=cancel_after_write, daemon=True)
    canceller.start()

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        return ApprovalDecision.ALLOW_ONCE

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Run the cancellable test.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=token,
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )
    canceller.join(timeout=5)
    assert result.status == "cancelled"
    assert changed.read_text(encoding="utf-8") == "changed"
    assert result.changed_files[0].path == "cancelled-change.txt"
    assert result.changed_files[0].operation == "add"
    assert result.tool_calls[0].status == "error"
    assert result.tool_calls[0].test is False
    assert result.as_json()["outcome"]["tests"] == []


def test_pre_provider_cancellation_returns_a_valid_terminal_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner, _, transport = _runner(
        tmp_path,
        [{"kind": "plan", "content": "This provider call must not run."}],
    )
    token = CancellationToken()
    token.cancel()

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        raise AssertionError("A pre-provider cancellation cannot request approval.")

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Cancel before contacting the provider.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=token,
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )

    assert result.status == "cancelled"
    assert result.provider_attempt_ids == ()
    assert result.provider_call_ids == ()
    assert result.as_json()["callId"] is None
    assert result.as_json()["providerAttemptId"] is None
    assert result.as_json()["providerAttemptIds"] == []
    assert result.as_json()["providerCallIds"] == []
    assert transport.calls == 0
    assert runner.state.get_session(result.session_id).status == "cancelled"


def test_cancellation_during_first_provider_request_records_attempt_without_receipt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner, _, transport = _runner(
        tmp_path,
        [{"kind": "plan", "content": "The cancelled response must not arrive."}],
    )
    token = CancellationToken()
    entered_transport = threading.Event()

    def wait_for_cancellation(*args: object, **kwargs: object) -> JsonResponse:
        payload = args[2]
        transport_token = kwargs["cancellation"]
        assert isinstance(payload, bytes)
        assert isinstance(transport_token, CancellationToken)
        transport.calls += 1
        transport.payloads.append(payload)
        entered_transport.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not transport_token.cancelled:
            time.sleep(0.005)
        transport_token.raise_if_cancelled()
        raise AssertionError("The transport should observe cancellation.")

    monkeypatch.setattr(transport, "post", wait_for_cancellation)

    def cancel_pending_request() -> None:
        assert entered_transport.wait(timeout=5)
        token.cancel()

    canceller = threading.Thread(target=cancel_pending_request, daemon=True)
    canceller.start()

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        raise AssertionError(
            "A cancelled first provider request cannot request approval."
        )

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Cancel the pending first provider request.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=token,
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )
    canceller.join(timeout=5)

    assert result.status == "cancelled"
    assert len(result.provider_attempt_ids) == 1
    assert result.provider_call_ids == ()
    assert result.as_json()["providerAttemptId"] == result.provider_attempt_ids[0]
    assert result.as_json()["callId"] is None
    assert result.tool_calls == ()
    assert result.changed_files == ()
    assert transport.calls == 1
    assert runner.state.provider_call_receipts(result.session_id) == ()
    requested = [
        event
        for event in runner.state.lineage_events(result.session_id)
        if event.event_type.value == "provider.requested"
    ]
    assert [event.event_id for event in requested] == list(result.provider_attempt_ids)


def test_initial_provider_failure_returns_attempt_identity_without_a_receipt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner, _, transport = _runner(tmp_path, [])

    def fail_first_request(*args: object, **_kwargs: object) -> JsonResponse:
        payload = args[2]
        assert isinstance(payload, bytes)
        transport.calls += 1
        transport.payloads.append(payload)
        raise ProviderConnectivityError()

    monkeypatch.setattr(transport, "post", fail_first_request)

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        raise AssertionError("A failed first provider request cannot request approval.")

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Return durable evidence for an initial provider failure.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )

    assert result.status == "failed"
    assert result.failure is not None
    assert result.failure.kind == "connectivity"
    assert result.failure.retryable is True
    assert result.failure.status_code is None
    assert len(result.provider_attempt_ids) == 1
    assert result.provider_call_ids == ()
    assert result.as_json()["providerAttemptId"] == result.provider_attempt_ids[0]
    assert result.as_json()["callId"] is None
    assert result.tool_calls == ()
    assert result.changed_files == ()
    assert result.usage["measurement"] == "unavailable"
    assert transport.calls == 1
    assert runner.state.get_session(result.session_id).status == "failed"
    assert runner.state.provider_call_receipts(result.session_id) == ()


@pytest.mark.parametrize(
    ("status_code", "kind", "retryable"),
    [(401, "authentication", False), (429, "quota", True)],
)
def test_initial_http_failure_retains_typed_handoff_classification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    kind: str,
    retryable: bool,
) -> None:
    runner, _, transport = _runner(tmp_path, [])

    def fail_with_http_status(*args: object, **_kwargs: object) -> JsonResponse:
        payload = args[2]
        assert isinstance(payload, bytes)
        transport.calls += 1
        transport.payloads.append(payload)
        return JsonResponse(status_code, {}, b"{}")

    monkeypatch.setattr(transport, "post", fail_with_http_status)

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        raise AssertionError("An HTTP-failed first provider request cannot request approval.")

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Retain the typed provider failure.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )

    assert result.status == "failed"
    assert len(result.provider_attempt_ids) == 1
    assert result.provider_call_ids == ()
    assert result.failure is not None
    assert result.failure.kind == kind
    assert result.failure.retryable is retryable
    assert result.failure.status_code == status_code
    assert result.as_json()["failure"] == {
        "kind": kind,
        "retryable": retryable,
        "statusCode": status_code,
    }


def test_provider_failure_after_mutation_returns_partial_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = Path(sys.executable).name
    runner, source, transport = _runner(
        tmp_path,
        [
            {"kind": "plan", "content": "Create the measured file."},
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {
                        "arguments": [
                            "-c",
                            "from pathlib import Path; Path('provider-failed.txt').write_text('kept', encoding='utf-8')",
                        ],
                        "cwd": ".",
                        "executable": executable,
                        "timeoutSeconds": 15,
                    },
                    "callId": "process:before-provider-failure",
                    "name": "process.run",
                },
            },
        ],
    )
    original_post = transport.post

    def fail_after_script(*args: object, **kwargs: object) -> JsonResponse:
        if transport.calls >= len(transport.decisions):
            raise OSError("simulated provider transport failure")
        return original_post(*args, **kwargs)

    monkeypatch.setattr(transport, "post", fail_after_script)

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        return ApprovalDecision.ALLOW_ONCE

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Create a file, then review it.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=CancellationToken(),
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )
    assert result.status == "failed"
    assert result.failure is not None
    assert result.failure.kind == "runtime"
    assert (source.parent / "provider-failed.txt").read_text(encoding="utf-8") == "kept"
    assert result.changed_files[0].path == "provider-failed.txt"
    assert result.tool_calls[0].status == "ok"
    assert len(result.provider_attempt_ids) == 3
    assert len(result.provider_call_ids) == 2
    assert result.as_json()["providerAttemptId"] == result.provider_attempt_ids[-1]
    assert result.as_json()["callId"] == result.provider_call_ids[-1]
    assert "changed-file evidence is retained" in result.output
    assert runner.state.get_session(result.session_id).status == "failed"
    assert len(runner.state.provider_call_receipts(result.session_id)) == 2
    provider_request_events = [
        event
        for event in runner.state.lineage_events(result.session_id)
        if event.event_type.value == "provider.requested"
    ]
    assert [event.event_id for event in provider_request_events] == list(
        result.provider_attempt_ids
    )
    tool_events = [
        event
        for event in runner.state.lineage_events(result.session_id)
        if event.event_type.value == "tool.result"
    ]
    assert [event.payload["callId"] for event in tool_events] == [
        "process:before-provider-failure"
    ]


def test_cancelled_browser_screenshot_returns_and_persists_exact_partial_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner, source, _ = _runner(
        tmp_path,
        [
            {"kind": "plan", "content": "Capture the requested proof image."},
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {"path": "proof.png"},
                    "callId": "browser:cancelled-screenshot",
                    "name": "browser.screenshot",
                },
            },
        ],
    )
    token = CancellationToken()
    session = _FakeBrowserSession(source.parent)
    original_screenshot = session.screenshot

    def screenshot_then_cancel(relative_path: str) -> BrowserActionResult:
        result = original_screenshot(relative_path)
        token.cancel()
        return result

    monkeypatch.setattr(session, "screenshot", screenshot_then_cancel)
    monkeypatch.setattr(
        coding_module,
        "BrowserSession",
        lambda *_args, **_kwargs: session,
    )

    async def approve(_request: dict[str, object]) -> ApprovalDecision:
        return ApprovalDecision.ALLOW_ONCE

    result = _run(
        runner.run(
            provider_name="local",
            prompt="Capture proof.png, then stop if cancellation is requested.",
            allow_network=True,
            timeout=20,
            max_output_tokens=512,
            cancellation=token,
            approval_handler=approve,
            memory_mode="off",
        ),
        monkeypatch,
    )

    assert result.status == "cancelled"
    assert (source.parent / "proof.png").read_bytes().startswith(b"\x89PNG")
    assert result.changed_files[0].path == "proof.png"
    assert result.changed_files[0].operation == "add"
    assert result.tool_calls[0].call_id == "browser:cancelled-screenshot"
    assert result.tool_calls[0].status == "ok"
    tool_events = [
        event
        for event in runner.state.lineage_events(result.session_id)
        if event.event_type.value == "tool.result"
    ]
    assert [event.payload["callId"] for event in tool_events] == [
        "browser:cancelled-screenshot"
    ]


def test_snapshot_walk_errors_and_links_never_claim_complete_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)

    def failed_walk(start: Path, *, followlinks: bool, onerror: object) -> object:
        del followlinks
        assert callable(onerror)
        onerror(PermissionError("denied"))
        yield str(start), [], []

    monkeypatch.setattr(coding_module.os, "walk", failed_walk)
    snapshot, paths_complete, evidence_complete, incomplete_scopes = (
        coding_module._workspace_file_snapshot(workspace)
    )
    assert snapshot == {}
    assert paths_complete is False
    assert evidence_complete is False
    assert incomplete_scopes == frozenset({""})


def test_snapshot_records_symlink_identity_without_following_it_when_supported(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    (root / "real.txt").write_text("real", encoding="utf-8")
    try:
        (root / "link.txt").symlink_to("real.txt")
    except OSError:
        pytest.skip("File symlinks are unavailable on this host.")
    snapshot, paths_complete, evidence_complete, incomplete_scopes = (
        coding_module._workspace_file_snapshot(workspace)
    )
    assert "real.txt" in snapshot
    assert snapshot["link.txt"].exists is True
    assert snapshot["link.txt"].sha256 is None
    assert paths_complete is True
    assert evidence_complete is False
    assert incomplete_scopes == frozenset()


def test_unchanged_symlink_does_not_hide_unrelated_add_or_delete(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    (root / "real.txt").write_text("real", encoding="utf-8")
    (root / "removed.txt").write_text("remove", encoding="utf-8")
    try:
        (root / "link.txt").symlink_to("real.txt")
    except OSError:
        pytest.skip("File symlinks are unavailable on this host.")

    before, before_complete, _, before_scopes = coding_module._workspace_file_snapshot(
        workspace
    )
    (root / "created.txt").write_text("created", encoding="utf-8")
    (root / "removed.txt").unlink()
    after, after_complete, _, after_scopes = coding_module._workspace_file_snapshot(
        workspace
    )

    assert coding_module._measured_mutation_paths(
        before,
        after,
        before_complete=before_complete,
        after_complete=after_complete,
        before_incomplete_scopes=before_scopes,
        after_incomplete_scopes=after_scopes,
    ) == ["created.txt", "removed.txt"]


def test_directory_symlink_placeholders_respect_snapshot_entry_cap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    target = root / "target"
    target.mkdir()
    try:
        for index in range(3):
            (root / f"link-{index}").symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("Directory symlinks are unavailable on this host.")
    monkeypatch.setattr(coding_module, "_MAX_MUTATION_SCAN_FILES", 2)

    snapshot, paths_complete, evidence_complete, incomplete_scopes = (
        coding_module._workspace_file_snapshot(workspace)
    )

    assert len(snapshot) == 2
    assert paths_complete is False
    assert evidence_complete is False
    assert incomplete_scopes == frozenset({""})


def test_git_dirty_source_path_is_snapshotted_before_the_global_entry_cap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    crowded = root / "aaa"
    source = root / "later-project" / "src" / "main.py"
    crowded.mkdir(parents=True)
    source.parent.mkdir(parents=True)
    for index in range(3):
        (crowded / f"artifact-{index}.txt").write_text("crowd", encoding="utf-8")
    source.write_text("authored", encoding="utf-8")
    workspace, _ = initialize_workspace(root)
    monkeypatch.setattr(coding_module, "_MAX_MUTATION_SCAN_FILES", 2)
    view = coding_module._GitWorktreeView(
        available=True,
        complete=True,
        head_oid="a" * 40,
        paths=(Path("later-project/src/main.py"),),
        baseline_oids={"later-project/src/main.py": "b" * 40},
    )
    monkeypatch.setattr(
        coding_module,
        "_git_worktree_view",
        lambda _root: view,
    )

    before, paths_complete, evidence_complete, before_incomplete_scopes = (
        coding_module._workspace_file_snapshot(workspace)
    )
    source.write_text("changed", encoding="utf-8")
    after, after_complete, _, after_incomplete_scopes = (
        coding_module._workspace_file_snapshot(workspace)
    )

    assert "later-project/src/main.py" in before
    assert len(before) == 2
    assert paths_complete is False
    assert evidence_complete is False
    assert before_incomplete_scopes == frozenset({""})
    assert coding_module._measured_mutation_paths(
        before,
        after,
        before_complete=paths_complete,
        after_complete=after_complete,
        before_incomplete_scopes=before_incomplete_scopes,
        after_incomplete_scopes=after_incomplete_scopes,
    ) == ["later-project/src/main.py"]


def test_git_priority_query_uses_trusted_resolution_and_a_minimal_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / ".git").mkdir()
    trusted_git = (tmp_path / "trusted" / "git").resolve()
    captured: dict[str, object] = {}
    monkeypatch.setenv("FIKEYA_SNAPSHOT_SECRET", "must-not-leak")
    monkeypatch.setattr(
        coding_module,
        "_resolve_trusted_executable",
        lambda command, *, workspace_root: str(trusted_git),
    )

    status_output = (
        b"# branch.oid "
        + (b"a" * 40)
        + b"\0? build/generated.bin\0? project/src/main.py\0"
    )

    class FakeProcess:
        def __init__(self, output: bytes) -> None:
            self.stdout = io.BytesIO(output)
            self.stdin = None
            self.returncode = 0

        def poll(self) -> int:
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -1

        def kill(self) -> None:
            self.returncode = -9

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return self.returncode

    def fake_popen(argv: list[str], **kwargs: object) -> FakeProcess:
        captured["argv"] = argv
        captured.update(kwargs)
        return FakeProcess(status_output)

    monkeypatch.setattr(coding_module.subprocess, "Popen", fake_popen)

    view = coding_module._git_worktree_view(root)

    assert view.available is True
    assert view.complete is True
    assert view.paths == (Path("project/src/main.py"),)
    assert captured["argv"][0] == str(trusted_git)  # type: ignore[index]
    environment = captured["env"]
    assert isinstance(environment, dict)
    assert "FIKEYA_SNAPSHOT_SECRET" not in environment
    assert environment["GIT_CONFIG_NOSYSTEM"] == "1"
    assert environment["GIT_OPTIONAL_LOCKS"] == "0"


def test_git_priority_query_rejects_output_above_its_actual_reader_cap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / ".git").mkdir()
    monkeypatch.setattr(
        coding_module,
        "_resolve_trusted_executable",
        lambda command, *, workspace_root: str(tmp_path / "trusted-git"),
    )

    class OverflowProcess:
        def __init__(self) -> None:
            self.stdout = io.BytesIO(
                b"x" * (coding_module._MAX_GIT_PRIORITY_OUTPUT_BYTES + 1)
            )
            self.stdin = None
            self.returncode = 0

        def poll(self) -> int:
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -1

        def kill(self) -> None:
            self.returncode = -9

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return self.returncode

    monkeypatch.setattr(
        coding_module.subprocess,
        "Popen",
        lambda *args, **kwargs: OverflowProcess(),
    )

    assert (
        coding_module._run_bounded_git(
            root,
            ["status"],
            maximum_output_bytes=coding_module._MAX_GIT_PRIORITY_OUTPUT_BYTES,
        )
        is None
    )


def test_clean_tracked_source_beyond_cap_is_reconciled_after_edit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    crowded = root / "aaa"
    source = root / "later-project" / "src" / "main.py"
    crowded.mkdir(parents=True)
    source.parent.mkdir(parents=True)
    (root / ".gitignore").write_text(".fikeya/\n", encoding="utf-8")
    for index in range(3):
        (crowded / f"tracked-{index}.txt").write_text("crowd", encoding="utf-8")
    source.write_text("before\n", encoding="utf-8")
    baseline_payload = source.read_bytes()
    try:
        for arguments in (
            ["init", "-q"],
            ["config", "user.email", "tests@fikeya.invalid"],
            ["config", "user.name", "Fikeya Tests"],
            ["config", "core.autocrlf", "false"],
            ["add", "."],
            ["commit", "-qm", "baseline"],
        ):
            subprocess.run(
                ["git", *arguments],
                cwd=root,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
    except (FileNotFoundError, subprocess.SubprocessError):
        pytest.skip("Git is unavailable for the tracked-baseline regression.")

    workspace, _ = initialize_workspace(root)
    monkeypatch.setattr(coding_module, "_MAX_MUTATION_SCAN_FILES", 2)
    before, before_complete, _, before_scopes = coding_module._workspace_file_snapshot(
        workspace
    )
    assert "later-project/src/main.py" not in before

    source.write_text("after\n", encoding="utf-8")
    after, after_complete, _, after_scopes = coding_module._workspace_file_snapshot(
        workspace
    )
    assert "later-project/src/main.py" in after
    coding_module._reconcile_git_snapshot_boundaries(root, before, after)

    assert before["later-project/src/main.py"].sha256 == (
        __import__("hashlib").sha256(baseline_payload).hexdigest()
    )
    assert coding_module._measured_mutation_paths(
        before,
        after,
        before_complete=before_complete,
        after_complete=after_complete,
        before_incomplete_scopes=before_scopes,
        after_incomplete_scopes=after_scopes,
    ) == ["later-project/src/main.py"]

    untracked = root / "later-project" / "src" / "scratch.py"
    untracked.write_text("temporary\n", encoding="utf-8")
    before_delete, before_delete_complete, _, before_delete_scopes = (
        coding_module._workspace_file_snapshot(workspace)
    )
    assert "later-project/src/scratch.py" in before_delete
    untracked.unlink()
    after_delete, after_delete_complete, _, after_delete_scopes = (
        coding_module._workspace_file_snapshot(workspace)
    )
    assert "later-project/src/scratch.py" not in after_delete
    coding_module._reconcile_git_snapshot_boundaries(root, before_delete, after_delete)
    assert coding_module._measured_mutation_paths(
        before_delete,
        after_delete,
        before_complete=before_delete_complete,
        after_complete=after_delete_complete,
        before_incomplete_scopes=before_delete_scopes,
        after_incomplete_scopes=after_delete_scopes,
    ) == ["later-project/src/scratch.py"]


def test_dirty_tracked_source_beyond_cap_is_reconciled_after_restore(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    crowded = root / "aaa"
    source = root / "later-project" / "src" / "main.py"
    crowded.mkdir(parents=True)
    source.parent.mkdir(parents=True)
    (root / ".gitignore").write_text(".fikeya/\n", encoding="utf-8")
    for index in range(3):
        (crowded / f"tracked-{index}.txt").write_text("crowd", encoding="utf-8")
    source.write_text("head\n", encoding="utf-8")
    head_payload = source.read_bytes()
    try:
        for arguments in (
            ["init", "-q"],
            ["config", "user.email", "tests@fikeya.invalid"],
            ["config", "user.name", "Fikeya Tests"],
            ["config", "core.autocrlf", "false"],
            ["add", "."],
            ["commit", "-qm", "baseline"],
        ):
            subprocess.run(
                ["git", *arguments],
                cwd=root,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
    except (FileNotFoundError, subprocess.SubprocessError):
        pytest.skip("Git is unavailable for the tracked-restore regression.")

    workspace, _ = initialize_workspace(root)
    monkeypatch.setattr(coding_module, "_MAX_MUTATION_SCAN_FILES", 2)
    source.write_text("dirty\n", encoding="utf-8")
    dirty_payload = source.read_bytes()
    before, before_complete, _, before_scopes = coding_module._workspace_file_snapshot(
        workspace
    )
    assert before["later-project/src/main.py"].sha256 == (
        __import__("hashlib").sha256(dirty_payload).hexdigest()
    )

    subprocess.run(
        ["git", "checkout", "--", "later-project/src/main.py"],
        cwd=root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    after, after_complete, _, after_scopes = coding_module._workspace_file_snapshot(
        workspace
    )
    assert "later-project/src/main.py" not in after
    coding_module._reconcile_git_snapshot_boundaries(root, before, after)

    assert after["later-project/src/main.py"].sha256 == (
        __import__("hashlib").sha256(head_payload).hexdigest()
    )
    assert coding_module._measured_mutation_paths(
        before,
        after,
        before_complete=before_complete,
        after_complete=after_complete,
        before_incomplete_scopes=before_scopes,
        after_incomplete_scopes=after_scopes,
    ) == ["later-project/src/main.py"]


def test_process_receipt_declares_ignored_tree_scope_without_hiding_regular_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )
    result = _run(
        broker.execute(
            ToolCall(
                "process:ignored-scope",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        (
                            "from pathlib import Path; "
                            "Path('node_modules/pkg').mkdir(parents=True); "
                            "Path('node_modules/pkg/index.js').write_text('ignored'); "
                            "Path('visible.txt').write_text('measured')"
                        ),
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="ignored-scope",
        ),
        monkeypatch,
    )

    mutations = json.loads(result.output)["workspaceMutations"]
    assert mutations["scope"] == "regular-project-files-v1"
    assert mutations["paths"] == ["visible.txt"]
    assert "node_modules/pkg/index.js" not in broker.state.changed_files


def test_generated_build_flood_cannot_hide_later_source_content_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    source = root / "src" / "main.py"
    generated = root / "build" / "cache"
    source.parent.mkdir(parents=True)
    generated.mkdir(parents=True)
    source.write_text("value = 1\n", encoding="utf-8")
    for index in range(coding_module._MAX_MUTATION_SCAN_FILES + 1):
        (generated / f"artifact-{index:05d}.bin").write_bytes(b"")

    workspace, _ = initialize_workspace(root)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )
    result = _run(
        broker.execute(
            ToolCall(
                "process:source-after-build-flood",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        "from pathlib import Path; Path('src/main.py').write_text('value = 2\\n')",
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="source-after-build-flood",
        ),
        monkeypatch,
    )

    mutations = json.loads(result.output)["workspaceMutations"]
    assert mutations["complete"] is True
    assert mutations["truncated"] is False
    assert mutations["paths"] == ["src/main.py"]
    assert mutations["changes"][0]["operation"] == "edit"
    assert set(broker.state.changed_files) == {"src/main.py"}


def test_sparse_file_above_one_gigabyte_retains_safe_integer_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )
    result = _run(
        broker.execute(
            ToolCall(
                "process:sparse",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        "with open('huge.bin','wb') as stream: stream.truncate(1000000001)",
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="b" * 64,
        ),
        monkeypatch,
    )
    change = json.loads(result.output)["workspaceMutations"]["changes"][0]
    assert change["path"] == "huge.bin"
    assert change["operation"] == "add"
    assert change["beforeExists"] is False
    assert change["afterExists"] is True
    assert change["afterBytes"] == 1_000_000_001
    assert change["afterSha256"] is None
    assert change["lineDeltaStatus"] == "too-large"
    assert broker.state.changed_files_truncated is True


def test_sparse_file_above_one_gigabyte_edit_and_delete_are_measured(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    with (root / "huge.bin").open("wb") as stream:
        stream.truncate(1_000_000_001)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )

    edited = _run(
        broker.execute(
            ToolCall(
                "process:sparse-edit",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        "with open('huge.bin','r+b') as stream: stream.truncate(1000000002)",
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="sparse-edit",
        ),
        monkeypatch,
    )
    edited_change = json.loads(edited.output)["workspaceMutations"]["changes"][0]
    assert edited_change["operation"] == "edit"
    assert edited_change["beforeBytes"] == 1_000_000_001
    assert edited_change["afterBytes"] == 1_000_000_002

    deleted = _run(
        broker.execute(
            ToolCall(
                "process:sparse-delete",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        "from pathlib import Path; Path('huge.bin').unlink()",
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="sparse-delete",
        ),
        monkeypatch,
    )
    deleted_change = json.loads(deleted.output)["workspaceMutations"]["changes"][0]
    assert deleted_change["operation"] == "delete"
    assert deleted_change["beforeBytes"] == 1_000_000_002
    assert deleted_change["afterBytes"] is None


def test_final_changed_file_receipts_fit_the_one_line_protocol_budget() -> None:
    receipts = [
        ChangedFileReceipt(
            path=f"src/{index:04d}-{'a' * 4000}",
            before_exists=False,
            after_exists=True,
            before_sha256=None,
            after_sha256=f"sha256:{'a' * 64}",
            operation="add",
            before_bytes=None,
            after_bytes=1,
            lines_added=1,
            lines_deleted=0,
            line_delta_status="exact",
        )
        for index in range(1_000)
    ]
    bounded, truncated = coding_module._bound_changed_file_receipts(receipts)
    payload = {
        "changedFiles": [item.as_json() for item in bounded],
        "outcome": {
            "changedFiles": [item.as_json() for item in bounded],
            "plan": "p" * (128 * 1024),
            "summary": "s" * (128 * 1024),
            "toolCalls": [],
        },
    }
    assert truncated is True
    assert len(json.dumps(payload, separators=(",", ":")).encode("utf-8")) < 1_048_576


def test_control_heavy_file_read_is_truncated_as_serialized_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    (root / "controls.txt").write_bytes(b"\x01" * 1_048_576)
    broker = WorkspaceExecutionBroker(workspace)

    result = _run(
        broker.execute(
            ToolCall("read:controls", "workspace.read_file", {"path": "controls.txt"}),
            CancellationToken(),
            idempotency_key="control-heavy-read",
        ),
        monkeypatch,
    )

    assert result.status == "ok"
    assert 260_000 < len(result.output.encode("utf-8")) <= 262_144
    parsed = json.loads(result.output)
    assert parsed["truncated"] is True
    assert parsed["content"].startswith("\x01")
    assert parsed["content"].endswith(
        "[Fikeya truncated tool output to fit the agent limit.]"
    )
    assert (
        parsed["sha256"]
        == "sha256:" + __import__("hashlib").sha256(b"\x01" * 1_048_576).hexdigest()
    )


def test_control_heavy_process_result_retains_mutation_evidence_within_agent_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    executable = Path(sys.executable).name
    broker = WorkspaceExecutionBroker(
        workspace, allowed_executables=frozenset({executable})
    )
    result = _run(
        broker.execute(
            ToolCall(
                "process:controls",
                "process.run",
                {
                    "arguments": [
                        "-c",
                        (
                            "from pathlib import Path; import sys; "
                            "Path('control-proof.txt').write_text('kept', encoding='utf-8'); "
                            "sys.stdout.write(chr(1) * 131072)"
                        ),
                    ],
                    "cwd": ".",
                    "executable": executable,
                    "timeoutSeconds": 15,
                },
            ),
            CancellationToken(),
            idempotency_key="control-heavy-process",
        ),
        monkeypatch,
    )

    assert result.status == "ok"
    assert 260_000 < len(result.output.encode("utf-8")) <= 262_144
    parsed = json.loads(result.output)
    assert parsed["truncated"] is True
    assert parsed["stdout"].startswith("\x01")
    assert parsed["stdout"].endswith(
        "[Fikeya truncated tool output to fit the agent limit.]"
    )
    assert parsed["workspaceMutations"]["paths"] == ["control-proof.txt"]
    assert parsed["workspaceMutations"]["changes"][0]["operation"] == "add"
    assert (root / "control-proof.txt").read_text(encoding="utf-8") == "kept"
    assert broker.state.receipts[0].output_sha256 == (
        "sha256:"
        + __import__("hashlib").sha256(result.output.encode("utf-8")).hexdigest()
    )


def test_control_heavy_final_result_fits_jsonl_without_losing_its_envelope() -> None:
    changes = tuple(
        ChangedFileReceipt(
            path=f"src/{index:02d}-" + ("\x03" * 1_000),
            before_exists=False,
            after_exists=True,
            before_sha256=None,
            after_sha256="sha256:" + ("a" * 64),
            operation="add",
            before_bytes=None,
            after_bytes=1,
            lines_added=1,
            lines_deleted=0,
            line_delta_status="exact",
        )
        for index in range(30)
    )
    unbounded = CodingRunResult(
        session_id="session:controls",
        status="completed",
        output="\x01" * 200_000,
        plan="\x02" * 200_000,
        steps=1,
        memory=MemoryPreparation(status="off"),
        provider_call_ids=("call:controls",),
        usage={
            "cachedInputTokens": None,
            "inputTokens": None,
            "measurement": "unavailable",
            "outputTokens": None,
        },
        tool_calls=(),
        changed_files=changes,
        changed_files_truncated=False,
        provider_attempt_ids=("evt:controls",),
    )

    assert coding_module._coding_protocol_byte_count(unbounded) > 1_048_576
    bounded = coding_module._bound_coding_run_result(unbounded)
    line = json.dumps(
        {"type": "result", **bounded.as_json()},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    parsed = json.loads(line)

    assert len(line) <= 1_048_576
    assert parsed["type"] == "result"
    assert parsed["sessionId"] == "session:controls"
    assert parsed["callId"] == "call:controls"
    assert parsed["providerAttemptId"] == "evt:controls"
    assert parsed["output"] == parsed["outcome"]["summary"]
    assert len(parsed["changedFiles"]) == len(changes)
    assert parsed["changedFiles"] == parsed["outcome"]["changedFiles"]
    assert parsed["changedFilesTruncated"] is False
    assert parsed["output"].startswith("\x01")
    assert parsed["output"].endswith(
        "[Fikeya truncated the answer to fit the JSONL transport limit.]"
    )
    assert parsed["outcome"]["plan"].endswith(
        "[Fikeya truncated the plan to fit the JSONL transport limit.]"
    )


@pytest.mark.parametrize(
    ("executable", "arguments", "expected"),
    [
        ("vitest", ["run"], True),
        ("jest", ["--runInBand"], True),
        ("ctest", [], True),
        ("pytest", ["-q"], True),
        ("npm", ["test"], True),
        ("npm", ["run", "test:unit"], True),
        ("npm", ["run", "contest"], False),
        ("npm", ["install", "test"], False),
        ("pnpm", ["add", "test"], False),
        ("yarn", ["add", "test"], False),
        ("bun", ["install", "test"], False),
        ("npx", ["vitest", "run"], True),
        ("npx", ["playwright", "test"], True),
        ("npx", ["playwright", "show-report"], False),
        ("npx", ["--package", "vitest"], False),
        ("go", ["test", "./..."], True),
        ("go", ["test", "-list", ".", "./..."], False),
        ("go", ["test", "-list=Foo", "./..."], False),
        ("go", ["build", "./..."], False),
        ("cargo", ["test", "--workspace"], True),
        ("cargo", ["test", "--no-run"], False),
        ("cargo", ["test", "--", "--list"], False),
        ("cargo", ["test", "--", "--nocapture"], True),
        ("cargo", ["build"], False),
        ("gradlew", [":app:test"], True),
        ("gradlew", [":app:test", "--dry-run"], False),
        ("mvn", ["verify"], True),
        ("mvn", ["test", "-DskipTests"], False),
        ("mvn", ["test", "-DskipTests=true"], False),
        ("mvn", ["test", "-DskipTests=false"], True),
        ("pytest", ["--collect-only"], False),
        ("pytest", ["--fixtures"], False),
        ("pytest", ["--fixtures-per-test"], False),
        ("pytest", ["--markers"], False),
        ("pytest", ["--trace-config"], False),
        ("pytest", ["--setup-plan"], False),
        ("pytest", ["--setup-only"], False),
        ("jest", ["--listTests"], False),
        ("ctest", ["--print-labels"], False),
        ("ctest", ["--show-only=json-v1"], False),
        ("python", ["-c", "assert value == 1"], False),
        ("python", ["-m", "pytest", "-q"], True),
        ("python", ["-m", "pytest", "--collect-only"], False),
        ("python", ["-m", "unittest"], True),
        ("python", ["-m", "unittest", "discover"], True),
        (
            "python",
            ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
            True,
        ),
        (
            "python",
            ["-m", "unittest", "tests.test_api.ApiTests.test_success"],
            True,
        ),
        ("python", ["-m", "unittest", "-q", "tests.test_api"], True),
        ("python", ["-m", "unittest", "--help"], False),
        ("python", ["-m", "unittest", "discover", "--help"], False),
        ("python", ["-m", "unittest", "--list-tests"], False),
        ("python", ["-m", "unittest", "--dry-run"], False),
        ("python", ["-m", "unittest", "discover", "-s"], False),
        ("python", ["-m", "unittest", "-k"], False),
        ("python", ["-c", "def check(): assert False"], False),
        ("python", ["-c", "if False: assert False"], False),
        ("python", ["-c", "print('assert')"], False),
        ("python", ["-c", "print('contest')"], False),
        ("uv", ["run", "pytest", "-q"], True),
        ("uv", ["run", "python", "-m", "pytest", "-q"], True),
        ("uv", ["pip", "install", "pytest"], False),
    ],
)
def test_test_command_classification_is_command_aware(
    executable: str,
    arguments: list[str],
    expected: bool,
) -> None:
    assert coding_module._is_test_command(executable, arguments) is expected
