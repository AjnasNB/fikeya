# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import socket
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from fikeya_agent_core import ApprovalDecision

from fikeya_runtime.autonomy import (
    AUTONOMY_REVIEW_PROTOCOL,
    AutonomousProjectLoop,
    AutonomyLimits,
    AutonomyProtocolError,
    AutonomyStage,
    ProviderOptions,
    decode_audit_result,
)
from fikeya_runtime.errors import StateError
from fikeya_runtime.inference import CancellationToken
from fikeya_runtime.modes import AgentMode
from fikeya_runtime.plans import PlanService, PlanStatus
from fikeya_runtime.workspace import initialize_workspace

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def _sha256(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


def _audit(
    phase: AutonomyStage,
    verdict: str = "accept",
    *,
    feedback: str = "The exact criterion is satisfied.",
) -> str:
    passed = verdict == "accept"
    return json.dumps(
        {
            "checks": [
                {
                    "criterion": (
                        "criterion-1"
                        if phase is AutonomyStage.VERIFY
                        else f"{phase.value} criterion"
                    ),
                    "evidenceSha256": _sha256(f"{phase.value}:{verdict}:{feedback}"),
                    "passed": passed,
                }
            ],
            "feedback": feedback,
            "phase": phase.value,
            "protocol": AUTONOMY_REVIEW_PROTOCOL,
            "verdict": verdict,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def _list_specification(title: str, call_id: str) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "title": title,
        "steps": [
            {
                "stepId": f"step-{call_id}",
                "title": "Inspect the workspace",
                "toolCall": {
                    "arguments": {"path": "."},
                    "callId": call_id,
                    "name": "workspace.list_files",
                },
                "verify": {"expectedStatus": "ok"},
            }
        ],
    }


def _write_specification(
    *,
    title: str,
    content: str,
    expected_before: str | None,
    expected_after: str,
    call_id: str,
) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "title": title,
        "steps": [
            {
                "stepId": f"step-{call_id}",
                "title": "Write the proof file",
                "toolCall": {
                    "arguments": {
                        "content": content,
                        "expectedSha256": expected_before,
                        "path": "proof.txt",
                    },
                    "callId": call_id,
                    "name": "workspace.write_file",
                },
                "verify": {
                    "expectedStatus": "ok",
                    "files": [{"path": "proof.txt", "sha256": expected_after}],
                },
            }
        ],
    }


class _RetryableProviderError(RuntimeError):
    retryable = True


class _FakePlanner:
    def __init__(self, service: PlanService, outcomes: list[object]) -> None:
        self.service = service
        self.outcomes = outcomes
        self.prompts: list[str] = []

    def propose(self, **kwargs: object) -> object:
        self.prompts.append(str(kwargs["prompt"]))
        if not self.outcomes:
            raise AssertionError("Unexpected planning call.")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        assert isinstance(outcome, dict)
        return SimpleNamespace(plan=self.service.create(outcome))


@dataclass(frozen=True)
class _FakeCodingResult:
    status: str
    output: str


class _FakeCodingRunner:
    def __init__(self, outputs: list[str | Exception]) -> None:
        self.outputs = outputs
        self.prompts: list[str] = []
        self.modes: list[object] = []

    async def run(self, **kwargs: object) -> object:
        prompt = str(kwargs["prompt"])
        self.prompts.append(prompt)
        self.modes.append(kwargs["mode"])
        if not self.outputs:
            raise AssertionError("Unexpected coding audit call.")
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        match = re.search(
            r'"requiredEvidenceSha256":"(sha256:[0-9a-f]{64})"', prompt
        )
        assert match is not None
        value = json.loads(output)
        for check in value["checks"]:
            check["evidenceSha256"] = match.group(1)
        output = json.dumps(value, separators=(",", ":"), sort_keys=True)
        return _FakeCodingResult(status="completed", output=output)


async def _approve(_request: dict[str, object]) -> ApprovalDecision:
    return ApprovalDecision.ALLOW_ONCE


def _options() -> ProviderOptions:
    return ProviderOptions(
        provider_name="fake",
        allow_network=False,
        timeout=30,
        max_output_tokens=2_048,
        memory_mode="off",
    )


def _run(coroutine: object, monkeypatch: pytest.MonkeyPatch) -> object:
    """Permit only asyncio's Windows self-pipe; no provider uses the network."""

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    return asyncio.run(coroutine)  # type: ignore[arg-type]


def _workspace(tmp_path: Path) -> tuple[object, PlanService]:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    return workspace, PlanService(workspace)


def test_plan_revision_stops_for_existing_approval_then_resumes_to_completion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans,
        [
            _list_specification("Initial plan", "inspect-initial"),
            _list_specification("Revised plan", "inspect-revised"),
        ],
    )
    coding = _FakeCodingRunner(
        [
            _audit(
                AutonomyStage.AUDIT_PLAN,
                "revise",
                feedback="Add a more precise workspace inspection.",
            ),
            _audit(AutonomyStage.AUDIT_PLAN),
            _audit(AutonomyStage.AUDIT_CODE),
            _audit(AutonomyStage.VERIFY),
        ]
    )
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    started = loop.start("Inspect the project safely.")

    stopped = _run(
        loop.advance(
            started.run_id,
            goal="Inspect the project safely.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(stopped, "stage")
    assert stopped.stage is AutonomyStage.STOPPED
    assert stopped.stop_reason == "plan_review_required"
    assert stopped.resume_stage is AutonomyStage.EXECUTE
    assert stopped.plan_revisions == 1
    assert len(stopped.plan_history) == 2
    assert "Add a more precise workspace inspection." in planner.prompts[1]

    assert stopped.plan_id is not None
    plans.review(stopped.plan_id)
    plans.approve(stopped.plan_id, approve_all=True)

    # Recreate the coordinator to prove that only SQLite state is needed to resume.
    resumed_loop = AutonomousProjectLoop(workspace, planner, coding, plans=PlanService(workspace))
    resumed_loop.resume(started.run_id)
    completed = _run(
        resumed_loop.advance(
            started.run_id,
            goal="Inspect the project safely.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(completed, "stage")
    assert completed.stage is AutonomyStage.COMPLETED
    assert coding.modes == [
        AgentMode.PLAN,
        AgentMode.PLAN,
        AgentMode.REVIEW,
        AgentMode.REVIEW,
    ]
    assert completed.completion_evidence_ready
    assert completed.plan_audit is not None
    assert completed.code_audit is not None
    assert completed.verification is not None
    assert {
        completed.plan_audit.plan_spec_sha256,
        completed.code_audit.plan_spec_sha256,
        completed.verification.plan_spec_sha256,
    } == {completed.plan_spec_sha256}
    history = resumed_loop.store.history(started.run_id)
    assert history[0]["stage"] == "plan"
    assert history[-1]["stage"] == "completed"
    assert [item["revision"] for item in history] == list(range(1, len(history) + 1))


def test_retryable_provider_failure_is_persisted_and_retried(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans,
        [
            _RetryableProviderError("temporary outage"),
            _list_specification("Recovered plan", "inspect-recovered"),
        ],
    )
    coding = _FakeCodingRunner(
        [
            _audit(AutonomyStage.AUDIT_PLAN),
            _audit(AutonomyStage.AUDIT_CODE),
            _audit(AutonomyStage.VERIFY),
        ]
    )
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start(
        "Recover from one provider failure.",
        limits=AutonomyLimits(max_provider_retries=1),
    )

    stopped = _run(
        loop.advance(
            record.run_id,
            goal="Recover from one provider failure.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(stopped, "provider_failures")
    assert stopped.provider_failures == 1
    assert len(planner.prompts) == 2
    assert stopped.stage is AutonomyStage.STOPPED

    assert stopped.plan_id is not None
    plans.review(stopped.plan_id)
    plans.approve(stopped.plan_id, approve_all=True)
    loop.resume(record.run_id)
    completed = _run(
        loop.advance(
            record.run_id,
            goal="Recover from one provider failure.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(completed, "stage")
    assert completed.stage is AutonomyStage.COMPLETED


def test_failed_execution_replans_within_budget_then_completes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans,
        [
            _write_specification(
                title="Plan with bad verification",
                content="first\n",
                expected_before=None,
                expected_after=_sha256("not first\n"),
                call_id="write-first",
            ),
            _write_specification(
                title="Corrected write plan",
                content="corrected\n",
                expected_before=_sha256("first\n"),
                expected_after=_sha256("corrected\n"),
                call_id="write-corrected",
            ),
        ],
    )
    coding = _FakeCodingRunner(
        [
            _audit(AutonomyStage.AUDIT_PLAN),
            _audit(AutonomyStage.AUDIT_PLAN),
            _audit(AutonomyStage.AUDIT_CODE),
            _audit(AutonomyStage.VERIFY),
        ]
    )
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start(
        "Create a verified proof file.",
        limits=AutonomyLimits(max_plan_revisions=2, max_execution_retries=1),
    )

    first_stop = _run(
        loop.advance(
            record.run_id,
            goal="Create a verified proof file.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(first_stop, "plan_id") and first_stop.plan_id is not None
    assert not (workspace.root / "proof.txt").exists()
    plans.review(first_stop.plan_id)
    plans.approve(first_stop.plan_id, approve_all=True)
    loop.resume(record.run_id)

    second_stop = _run(
        loop.advance(
            record.run_id,
            goal="Create a verified proof file.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(second_stop, "stage")
    assert second_stop.stage is AutonomyStage.STOPPED
    assert second_stop.execution_failures == 1
    assert second_stop.plan_revisions == 1
    assert second_stop.plan_id is not None
    assert "Execution of plan" in planner.prompts[1]
    assert (workspace.root / "proof.txt").read_text(encoding="utf-8") == "first\n"

    plans.review(second_stop.plan_id)
    plans.approve(second_stop.plan_id, approve_all=True)
    loop.resume(record.run_id)
    completed = _run(
        loop.advance(
            record.run_id,
            goal="Create a verified proof file.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(completed, "stage")
    assert completed.stage is AutonomyStage.COMPLETED
    assert (workspace.root / "proof.txt").read_text(encoding="utf-8") == "corrected\n"


def test_repeated_revised_plan_stops_for_no_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans,
        [
            _list_specification("Unchanged plan", "inspect-unchanged"),
            _list_specification("Unchanged plan", "inspect-unchanged"),
        ],
    )
    coding = _FakeCodingRunner(
        [
            _audit(
                AutonomyStage.AUDIT_PLAN,
                "revise",
                feedback="The plan still lacks a required criterion.",
            )
        ]
    )
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start(
        "Detect a stalled revision loop.",
        limits=AutonomyLimits(max_no_progress=1),
    )

    stopped = _run(
        loop.advance(
            record.run_id,
            goal="Detect a stalled revision loop.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(stopped, "stage")
    assert stopped.stage is AutonomyStage.STOPPED
    assert stopped.stop_reason == "no_progress_repeated_plan"
    assert stopped.no_progress_count == 1
    assert not stopped.can_resume
    with pytest.raises(StateError, match="cannot resume"):
        loop.resume(record.run_id)


def test_plan_revision_budget_exhaustion_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans,
        [
            _list_specification("First rejected plan", "inspect-first-rejected"),
            _list_specification("Second rejected plan", "inspect-second-rejected"),
        ],
    )
    coding = _FakeCodingRunner(
        [
            _audit(
                AutonomyStage.AUDIT_PLAN,
                "revise",
                feedback="The first plan is incomplete.",
            ),
            _audit(
                AutonomyStage.AUDIT_PLAN,
                "revise",
                feedback="The second plan is still incomplete.",
            ),
        ]
    )
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start(
        "Bound all plan revisions.",
        limits=AutonomyLimits(max_plan_revisions=1),
    )

    failed = _run(
        loop.advance(
            record.run_id,
            goal="Bound all plan revisions.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(failed, "stage")
    assert failed.stage is AutonomyStage.FAILED
    assert failed.failure_reason == (
        "plan_revision_budget_exhausted:audit_plan_revision"
    )
    assert failed.plan_revisions == 1
    assert len(planner.prompts) == 2


def test_cancellation_is_durable_and_does_not_call_a_provider(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans, [_list_specification("Never called", "inspect-never")]
    )
    coding = _FakeCodingRunner([])
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start("Cancel before the first provider call.")
    cancellation = CancellationToken()
    cancellation.cancel()

    stopped = _run(
        loop.advance(
            record.run_id,
            goal="Cancel before the first provider call.",
            provider=_options(),
            cancellation=cancellation,
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(stopped, "stage")
    assert stopped.stage is AutonomyStage.STOPPED
    assert stopped.stop_reason == "person cancelled"
    assert not stopped.can_resume
    assert planner.prompts == []
    assert AutonomousProjectLoop(workspace, planner, coding, plans=plans).load(
        record.run_id
    ) == stopped


def test_cancel_at_review_boundary_cancels_plan_and_removes_resume_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans, [_list_specification("Cancelable plan", "inspect-cancelable")]
    )
    coding = _FakeCodingRunner([_audit(AutonomyStage.AUDIT_PLAN)])
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start("Stop permanently at the review boundary.")
    paused = _run(
        loop.advance(
            record.run_id,
            goal="Stop permanently at the review boundary.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(paused, "can_resume") and paused.can_resume

    cancelled = loop.cancel(record.run_id, "operator cancelled")
    assert cancelled.stage is AutonomyStage.STOPPED
    assert cancelled.stop_reason == "operator cancelled"
    assert not cancelled.can_resume
    assert cancelled.plan_id is not None
    assert plans.store.load(cancelled.plan_id).status is PlanStatus.CANCELLED
    with pytest.raises(StateError, match="cannot resume"):
        loop.resume(record.run_id)


def test_explicit_audit_failure_enters_failed_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans, [_list_specification("Unsafe plan", "inspect-unsafe")]
    )
    coding = _FakeCodingRunner(
        [
            _audit(
                AutonomyStage.AUDIT_PLAN,
                "fail",
                feedback="The task cannot satisfy the mandatory safety criterion.",
            )
        ]
    )
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start("Fail closed on an unsafe plan.")

    failed = _run(
        loop.advance(
            record.run_id,
            goal="Fail closed on an unsafe plan.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(failed, "stage")
    assert failed.stage is AutonomyStage.FAILED
    assert failed.failure_reason == (
        "The task cannot satisfy the mandatory safety criterion."
    )
    assert not failed.completion_evidence_ready


def test_verify_must_cover_the_exact_persisted_completion_criteria(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _FakePlanner(
        plans, [_list_specification("Criteria plan", "inspect-criteria")]
    )
    coding = _FakeCodingRunner(
        [
            _audit(AutonomyStage.AUDIT_PLAN),
            _audit(AutonomyStage.AUDIT_CODE),
            # This contains criterion-1 only, while the run requires two criteria.
            _audit(AutonomyStage.VERIFY),
        ]
    )
    loop = AutonomousProjectLoop(workspace, planner, coding, plans=plans)
    record = loop.start(
        "Meet both completion criteria.",
        completion_criteria=("Workspace was inspected.", "No unsafe mutation occurred."),
        limits=AutonomyLimits(max_provider_retries=0),
    )
    paused = _run(
        loop.advance(
            record.run_id,
            goal="Meet both completion criteria.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(paused, "plan_id") and paused.plan_id is not None
    plans.review(paused.plan_id)
    plans.approve(paused.plan_id, approve_all=True)
    loop.resume(record.run_id)

    failed = _run(
        loop.advance(
            record.run_id,
            goal="Meet both completion criteria.",
            provider=_options(),
            cancellation=CancellationToken(),
            approval_handler=_approve,
        ),
        monkeypatch,
    )
    assert hasattr(failed, "stage")
    assert failed.stage is AutonomyStage.FAILED
    assert failed.failure_reason == "provider_retry_budget_exhausted"
    assert not failed.completion_evidence_ready


def test_audit_protocol_rejects_wrong_phase_and_false_acceptance() -> None:
    with pytest.raises(AutonomyProtocolError, match="wrong phase"):
        decode_audit_result(
            _audit(AutonomyStage.AUDIT_CODE),
            expected_phase=AutonomyStage.VERIFY,
        )

    invalid = json.loads(_audit(AutonomyStage.VERIFY))
    invalid["checks"][0]["passed"] = False
    with pytest.raises(AutonomyProtocolError, match="every check"):
        decode_audit_result(
            json.dumps(invalid),
            expected_phase=AutonomyStage.VERIFY,
        )
