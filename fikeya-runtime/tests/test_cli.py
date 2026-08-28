# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import io
import json
import socket
from pathlib import Path
from types import SimpleNamespace

import pytest
from fikeya_agent_core import AgentNoProgressError

from fikeya_runtime.cli import _parser, main
from fikeya_runtime.errors import ProviderConnectivityError, SecretStoreUnavailable
from fikeya_runtime.util import sha256_text

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def test_cli_reports_the_installed_version(capsys: object) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out == "fikeya 0.1.0b5\n"


def test_agent_execute_mode_defaults_to_build_and_private_browser_is_opt_in() -> None:
    parser = _parser()
    default = parser.parse_args(
        [
            "agent",
            "execute",
            ".",
            "--provider",
            "local",
            "--protocol-stdin",
            "--json-lines",
        ]
    )
    review = parser.parse_args(
        [
            "agent",
            "execute",
            ".",
            "--provider",
            "local",
            "--protocol-stdin",
            "--mode",
            "review",
            "--allow-private-browser",
            "--json-lines",
        ]
    )
    assert default.mode == "build"
    assert default.allow_private_browser is False
    assert review.mode == "review"
    assert review.allow_private_browser is True


class _ProtocolInput:
    def __init__(self, messages: list[dict[str, object]]) -> None:
        payload = b"".join(
            json.dumps(message, separators=(",", ":")).encode() + b"\n"
            for message in messages
        )
        self.buffer = io.BytesIO(payload)

    def isatty(self) -> bool:
        return False


class _FakeAutonomyRecord:
    def __init__(
        self,
        *,
        goal: str,
        stage: str,
        stop_reason: str | None = None,
        can_resume: bool = False,
    ) -> None:
        self.run_id = "aut_test"
        self.plan_id = "plan_test"
        self.goal_sha256 = sha256_text(goal)
        self.stage = SimpleNamespace(value=stage)
        self.revision = 1
        self.stop_reason = stop_reason
        self.can_resume = can_resume

    def as_json(self) -> dict[str, object]:
        return {
            "goalSha256": self.goal_sha256,
            "planId": self.plan_id,
            "runId": self.run_id,
            "stage": self.stage.value,
            "stopReason": self.stop_reason,
        }


class _FakeAutonomyLoop:
    def __init__(self, goal: str) -> None:
        self.goal = goal
        self.started: tuple[str, tuple[str, ...]] | None = None
        self.resumed = False
        self.cancelled = False
        self.store = SimpleNamespace(
            history=lambda run_id: (
                {
                    "createdAt": "2026-08-28T00:00:00Z",
                    "documentSha256": "sha256:" + ("a" * 64),
                    "revision": 1,
                    "stage": "stopped",
                },
            )
        )

    def start(
        self, goal: str, *, completion_criteria: tuple[str, ...]
    ) -> _FakeAutonomyRecord:
        self.started = (goal, completion_criteria)
        return _FakeAutonomyRecord(goal=goal, stage="plan")

    def load(self, run_id: str) -> _FakeAutonomyRecord:
        assert run_id == "aut_test"
        return _FakeAutonomyRecord(
            goal=self.goal,
            stage="stopped",
            stop_reason="plan_review_required",
            can_resume=True,
        )

    def resume(self, run_id: str) -> _FakeAutonomyRecord:
        assert run_id == "aut_test"
        self.resumed = True
        return _FakeAutonomyRecord(goal=self.goal, stage="execute")

    def cancel(self, run_id: str) -> _FakeAutonomyRecord:
        assert run_id == "aut_test"
        self.cancelled = True
        return _FakeAutonomyRecord(
            goal=self.goal,
            stage="stopped",
            stop_reason="person cancelled",
        )

    async def advance(self, run_id: str, **values: object) -> _FakeAutonomyRecord:
        assert run_id == "aut_test"
        assert values["goal"] == self.goal
        approval = values["approval_handler"]
        decision = await approval(
            {
                "requestId": "approval_test",
                "toolName": "workspace.read_file",
                "type": "approval_request",
            }
        )
        assert decision.value == "allow_once"
        return _FakeAutonomyRecord(
            goal=self.goal,
            stage="stopped",
            stop_reason="plan_review_required",
            can_resume=True,
        )


def test_project_start_keeps_goal_off_argv_and_emits_durable_ids(
    tmp_path: Path,
    capsys: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import fikeya_runtime.cli as cli_module

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    loop = _FakeAutonomyLoop("Build the star animation")
    monkeypatch.setattr(cli_module, "_build_project_loop", lambda *args, **kwargs: loop)
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    monkeypatch.setattr(
        "sys.stdin",
        _ProtocolInput(
            [
                {
                    "type": "start",
                    "goal": "Build the star animation",
                    "completionCriteria": ["The animation renders"],
                },
                {
                    "type": "approval",
                    "requestId": "approval_test",
                    "decision": "allow_once",
                },
            ]
        ),
    )

    assert (
        main(
            [
                "project",
                "start",
                str(workspace),
                "--provider",
                "local",
                "--protocol-stdin",
                "--json-lines",
            ]
        )
        == 0
    )
    output = capsys.readouterr().out
    lines = [json.loads(line) for line in output.splitlines()]
    assert lines[0] == {
        "type": "project_started",
        "runId": "aut_test",
        "stage": "plan",
        "revision": 1,
    }
    assert lines[1]["requestId"] == "approval_test"
    assert lines[2]["type"] == "project_result"
    assert lines[2]["runId"] == "aut_test"
    assert lines[2]["planId"] == "plan_test"
    assert lines[2]["stage"] == "stopped"
    assert lines[2]["nextAction"] == {
        "action": "review_plan",
        "planId": "plan_test",
    }
    assert "Build the star animation" not in output
    assert loop.started == (
        "Build the star animation",
        ("The animation renders",),
    )


def test_project_resume_rejects_a_different_goal_before_mutating_state(
    tmp_path: Path,
    capsys: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import fikeya_runtime.cli as cli_module

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    loop = _FakeAutonomyLoop("Original exact goal")
    monkeypatch.setattr(cli_module, "_build_project_loop", lambda *args, **kwargs: loop)
    monkeypatch.setattr(
        "sys.stdin",
        _ProtocolInput(
            [{"type": "resume", "runId": "aut_test", "goal": "Changed goal"}]
        ),
    )

    assert (
        main(
            [
                "project",
                "resume",
                "aut_test",
                "--workspace",
                str(workspace),
                "--provider",
                "local",
                "--protocol-stdin",
                "--json-lines",
            ]
        )
        == 2
    )
    assert loop.resumed is False
    assert "does not match" in capsys.readouterr().err


def test_project_show_and_cancel_expose_the_durable_record(
    tmp_path: Path,
    capsys: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import fikeya_runtime.cli as cli_module

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    loop = _FakeAutonomyLoop("Original exact goal")
    monkeypatch.setattr(cli_module, "_build_project_loop", lambda *args, **kwargs: loop)

    assert (
        main(
            [
                "project",
                "show",
                "aut_test",
                "--workspace",
                str(workspace),
                "--json",
            ]
        )
        == 0
    )
    shown = json.loads(capsys.readouterr().out)
    assert shown["record"]["goalSha256"] == sha256_text("Original exact goal")
    assert shown["history"][0]["revision"] == 1

    assert (
        main(
            [
                "project",
                "cancel",
                "aut_test",
                "--workspace",
                str(workspace),
                "--json",
            ]
        )
        == 0
    )
    cancelled = json.loads(capsys.readouterr().out)
    assert cancelled["record"]["stopReason"] == "person cancelled"
    assert loop.cancelled is True


def test_project_loop_wires_the_existing_planner_and_coding_runner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import fikeya_runtime.cli as cli_module

    workspace_path = tmp_path / "workspace"
    workspace_path.mkdir()
    workspace, _ = cli_module.initialize_workspace(workspace_path)
    provider_store = cli_module.ProviderStore(tmp_path / "home")
    agent = object()
    planner = object()
    coding_runner = object()
    loop = object()
    monkeypatch.setattr(cli_module, "AgentRunner", lambda *args: agent)
    monkeypatch.setattr(
        cli_module,
        "PlanProposalRunner",
        lambda received: planner if received is agent else None,
    )
    monkeypatch.setattr(
        cli_module,
        "CodingAgentRunner",
        lambda received_workspace, received_store: (
            coding_runner
            if received_workspace is workspace and received_store is provider_store
            else None
        ),
    )

    def autonomy(
        received_workspace: object,
        received_planner: object,
        received_coding_runner: object,
    ) -> object:
        assert received_workspace is workspace
        assert received_planner is planner
        assert received_coding_runner is coding_runner
        return loop

    monkeypatch.setattr(cli_module, "AutonomousProjectLoop", autonomy)

    assert (
        cli_module._build_project_loop(
            workspace,
            provider_store,
            memory_mode="off",
        )
        is loop
    )


def test_cli_init_and_provider_listing_make_no_network_calls(
    tmp_path: Path,
    capsys: object,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    initialized = json.loads(capsys.readouterr().out)
    assert initialized["created"] is True

    assert (
        main(
            [
                "--home",
                str(home),
                "provider",
                "configure",
                "local",
                "--kind",
                "ollama",
                "--model",
                "qwen",
                "--json",
            ]
        )
        == 0
    )
    configured = json.loads(capsys.readouterr().out)
    assert configured == {
        "kind": "ollama",
        "message": "Provider configured without persisting credential bytes.",
        "name": "local",
        "ok": True,
        "secretConfigured": False,
    }

    assert main(["--home", str(home), "provider", "list", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed["providers"][0]["name"] == "local"

    assert main(["--home", str(home), "provider", "test", "local", "--json"]) == 2
    denied = json.loads(capsys.readouterr().out)
    assert "Network probe denied" in denied["error"]

    assert (
        main(["--home", str(home), "stats", "--workspace", str(workspace), "--json"])
        == 0
    )
    statistics = json.loads(capsys.readouterr().out)
    assert statistics == {
        "breakdown": [],
        "cachedInputTokens": None,
        "generatedAt": statistics["generatedAt"],
        "inputTokens": None,
        "lastActivity": None,
        "matchedComparison": None,
        "measurement": "unavailable",
        "measuredProviderCalls": 0,
        "ok": True,
        "outputTokens": None,
        "providerCalls": 0,
        "qarinahContextReceipts": 0,
        "sessions": 0,
        "source": "local-runtime-sqlite",
    }


def test_cli_stats_exposes_only_a_valid_matched_comparison(
    tmp_path: Path,
    capsys: object,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    report = {
        "reportVersion": "1.0.0",
        "status": "matched",
        "pairCount": 2,
        "matchedFields": ["task.promptSha256", "model.name"],
        "baseline": {
            "verifiedSolveRate": 1.0,
            "billedTokens": {"totalBilled": 1_000},
        },
        "fikeya": {
            "verifiedSolveRate": 1.0,
            "billedTokens": {"totalBilled": 600},
        },
        "delta": {"billedTokens": -400},
    }
    report_path = workspace / ".fikeya" / "matched-efficiency.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")

    assert main(["stats", "--workspace", str(workspace), "--json"]) == 0
    statistics = json.loads(capsys.readouterr().out)
    comparison = statistics["matchedComparison"]
    assert comparison["status"] == "matched"
    assert comparison["pairCount"] == 2
    assert comparison["baselineBilledTokens"] == 1_000
    assert comparison["fikeyaBilledTokens"] == 600
    assert comparison["billedTokenReductionPercent"] == 40.0
    assert comparison["reportSha256"].startswith("sha256:")

    report["status"] = "unmatched"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert main(["stats", "--workspace", str(workspace), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["matchedComparison"] is None


def test_cli_agent_requires_stdin_and_explicit_network_opt_in(
    tmp_path: Path,
    capsys: object,
    monkeypatch: object,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    assert (
        main(
            [
                "--home",
                str(home),
                "provider",
                "configure",
                "local",
                "--kind",
                "ollama",
                "--model",
                "qwen",
                "--json",
            ]
        )
        == 0
    )
    capsys.readouterr()

    assert (
        main(
            [
                "--home",
                str(home),
                "agent",
                "run",
                str(workspace),
                "--provider",
                "local",
                "--json",
            ]
        )
        == 2
    )
    missing_stdin = json.loads(capsys.readouterr().out)
    assert "--prompt-stdin" in missing_stdin["error"]

    monkeypatch.setattr("sys.stdin", io.StringIO("content stays on stdin"))
    assert (
        main(
            [
                "--home",
                str(home),
                "agent",
                "run",
                str(workspace),
                "--provider",
                "local",
                "--prompt-stdin",
                "--json",
            ]
        )
        == 2
    )
    denied = json.loads(capsys.readouterr().out)
    assert "Model execution denied" in denied["error"]


def test_cli_plan_proposal_requires_stdin_and_explicit_network_opt_in(
    tmp_path: Path,
    capsys: object,
    monkeypatch: object,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    assert (
        main(
            [
                "--home",
                str(home),
                "provider",
                "configure",
                "local",
                "--kind",
                "ollama",
                "--model",
                "qwen",
                "--json",
            ]
        )
        == 0
    )
    capsys.readouterr()

    assert (
        main(
            [
                "--home",
                str(home),
                "plan",
                "propose",
                str(workspace),
                "--provider",
                "local",
                "--json",
            ]
        )
        == 2
    )
    missing_stdin = json.loads(capsys.readouterr().out)
    assert "--request-stdin" in missing_stdin["error"]

    monkeypatch.setattr(
        "sys.stdin",
        _ProtocolInput(
            [
                {
                    "protocol": "fikeya.plan-request.v1",
                    "prompt": "plan this request",
                }
            ]
        ),
    )
    assert (
        main(
            [
                "--home",
                str(home),
                "plan",
                "propose",
                str(workspace),
                "--provider",
                "local",
                "--request-stdin",
                "--json",
            ]
        )
        == 2
    )
    denied = json.loads(capsys.readouterr().out)
    assert "Model execution denied" in denied["error"]


def test_cli_coding_protocol_streams_progress_approval_and_structured_result(
    tmp_path: Path,
    capsys: object,
    monkeypatch: object,
) -> None:
    from fikeya_agent_core import ApprovalDecision

    from fikeya_runtime import coding

    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    assert (
        main(
            [
                "--home",
                str(home),
                "provider",
                "configure",
                "local",
                "--kind",
                "ollama",
                "--model",
                "qwen",
                "--json",
            ]
        )
        == 0
    )
    capsys.readouterr()

    class FakeResult:
        status = "completed"

        @staticmethod
        def as_json() -> dict[str, object]:
            return {
                "callId": "call_final",
                "changedFiles": [],
                "memory": {
                    "coverage": None,
                    "evidenceCount": None,
                    "receiptId": None,
                    "responseSha256": None,
                    "status": "off",
                },
                "ok": True,
                "outcome": {
                    "changedFiles": [],
                    "plan": "Inspect and answer.",
                    "steps": 1,
                    "summary": "The reviewed result.",
                    "tests": [],
                    "toolCalls": [],
                },
                "output": "The reviewed result.",
                "providerCallIds": ["call_final"],
                "sessionId": "ses_protocol",
                "status": "completed",
                "usage": {
                    "cachedInputTokens": 1,
                    "inputTokens": 10,
                    "measurement": "provider-reported",
                    "outputTokens": 4,
                },
            }

    class FakeCodingRunner:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run(self, **kwargs: object) -> FakeResult:
            history = kwargs["history"]
            assert [(turn.role, turn.content) for turn in history] == [
                ("user", "Inspect the existing implementation."),
                ("assistant", "The implementation uses bounded receipts."),
            ]
            progress = kwargs["progress_handler"]
            approval = kwargs["approval_handler"]
            progress(
                {
                    "event": "planned",
                    "sequence": 1,
                    "stage": "acting",
                    "type": "progress",
                }
            )
            decision = await approval(
                {
                    "arguments": {"path": "README.md"},
                    "argumentsSha256": "a" * 64,
                    "callId": "tool_read",
                    "expectedRevision": 1,
                    "requestId": "approval_read",
                    "sessionId": "ses_protocol",
                    "summary": "Read README.md",
                    "toolName": "workspace.read_file",
                    "type": "approval",
                }
            )
            assert decision is ApprovalDecision.ALLOW_ONCE
            return FakeResult()

    monkeypatch.setattr(coding, "CodingAgentRunner", FakeCodingRunner)
    # Windows asyncio creates a loopback self-pipe; provider transport remains replaced above.
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    monkeypatch.setattr(
        "sys.stdin",
        _ProtocolInput(
            [
                {
                    "type": "start",
                    "prompt": "Inspect the project.",
                    "history": [
                        {
                            "role": "user",
                            "content": "Inspect the existing implementation.",
                        },
                        {
                            "role": "assistant",
                            "content": "The implementation uses bounded receipts.",
                        },
                    ],
                },
                {
                    "type": "approval",
                    "requestId": "approval_read",
                    "decision": "allow_once",
                },
            ]
        ),
    )
    arguments = [
        "--home",
        str(home),
        "agent",
        "execute",
        str(workspace),
        "--provider",
        "local",
        "--protocol-stdin",
        "--allow-network",
        "--memory",
        "off",
        "--json-lines",
    ]
    assert "Inspect the project." not in arguments
    assert main(arguments) == 0
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [message["type"] for message in messages] == [
        "progress",
        "approval",
        "result",
    ]
    assert messages[1]["argumentsSha256"] == "a" * 64
    assert messages[2]["outcome"]["summary"] == "The reviewed result."


@pytest.mark.parametrize(
    ("raised", "expected"),
    [
        pytest.param(
            ProviderConnectivityError(),
            {
                "kind": "connectivity",
                "message": (
                    "Provider endpoint could not be reached before a response was received."
                ),
                "retryable": True,
                "type": "error",
            },
            id="provider-connectivity",
        ),
        pytest.param(
            AgentNoProgressError("unchanged state"),
            {
                "kind": "agent_no_progress",
                "message": (
                    "Fikeya stopped before repeating an unchanged provider request."
                ),
                "retryable": False,
                "type": "error",
            },
            id="agent-no-progress",
        ),
    ],
)
def test_cli_coding_protocol_emits_typed_pre_provider_failure(
    tmp_path: Path,
    capsys: object,
    monkeypatch: pytest.MonkeyPatch,
    raised: Exception,
    expected: dict[str, object],
) -> None:
    from fikeya_runtime import coding

    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    assert (
        main(
            [
                "--home",
                str(home),
                "provider",
                "configure",
                "local",
                "--kind",
                "ollama",
                "--model",
                "qwen",
                "--json",
            ]
        )
        == 0
    )
    capsys.readouterr()

    class FailingCodingRunner:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run(self, **_kwargs: object) -> object:
            raise raised

    monkeypatch.setattr(coding, "CodingAgentRunner", FailingCodingRunner)
    # Windows asyncio creates a loopback self-pipe; the fake runner makes no provider call.
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    monkeypatch.setattr(
        "sys.stdin",
        _ProtocolInput([{"type": "start", "prompt": "Inspect the project."}]),
    )

    assert (
        main(
            [
                "--home",
                str(home),
                "agent",
                "execute",
                str(workspace),
                "--provider",
                "local",
                "--protocol-stdin",
                "--allow-network",
                "--memory",
                "off",
                "--json-lines",
            ]
        )
        == 2
    )
    assert [json.loads(line) for line in capsys.readouterr().out.splitlines()] == [expected]


def test_cli_doctor_reports_headless_keyring_without_blocking_runtime(
    tmp_path: Path,
    capsys: object,
    monkeypatch: object,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    capsys.readouterr()

    def unavailable_keyring(_self: object) -> None:
        raise SecretStoreUnavailable("No desktop keyring is available.")

    monkeypatch.setattr(
        "fikeya_runtime.cli.OSKeyringSecretStore._keyring",
        unavailable_keyring,
    )

    assert main(["--home", str(home), "doctor", str(workspace), "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    keyring_check = next(
        check for check in report["checks"] if check["name"] == "os-keyring"
    )
    assert report["ok"] is True
    assert keyring_check == {
        "detail": "No desktop keyring is available.",
        "name": "os-keyring",
        "ok": False,
        "optional": True,
    }
