# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fikeya_agent_core import ApprovalDecision

from fikeya_runtime.autonomy import (
    AUTONOMY_REVIEW_PROTOCOL,
    AutonomousProjectLoop,
    AutonomyStore,
    AutonomyLimits,
    AutonomyProtocolError,
    AutonomyStage,
    ProviderOptions,
    decode_audit_result,
)
from fikeya_runtime.errors import CancellationError, StateError
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


class _BlockingPlanner:
    def __init__(self, acknowledgement_gate: threading.Event | None = None) -> None:
        self.entered = threading.Event()
        self.cancel_observed = threading.Event()
        self.acknowledgement_gate = acknowledgement_gate
        self.calls = 0

    def propose(self, **kwargs: object) -> object:
        cancellation = kwargs["cancellation"]
        assert isinstance(cancellation, CancellationToken)
        self.calls += 1
        self.entered.set()
        while not cancellation.cancelled:
            time.sleep(0.01)
        self.cancel_observed.set()
        if self.acknowledgement_gate is not None:
            assert self.acknowledgement_gate.wait(5)
        raise CancellationError("planning cancelled")


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


def test_active_lease_rejects_concurrent_advance_without_duplicate_provider_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    planner = _BlockingPlanner()
    coding = _FakeCodingRunner([])
    first = AutonomousProjectLoop(
        workspace,
        planner,
        coding,
        plans=plans,
        lease_seconds=2,
        heartbeat_seconds=0.05,
    )
    second = AutonomousProjectLoop(
        workspace,
        planner,
        coding,
        plans=PlanService(workspace),
        lease_seconds=2,
        heartbeat_seconds=0.05,
    )
    started = first.start("Keep exactly one provider owner.")
    results: list[object] = []
    failures: list[BaseException] = []
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)

    def run_first() -> None:
        try:
            results.append(
                asyncio.run(
                    first.advance(
                        started.run_id,
                        goal="Keep exactly one provider owner.",
                        provider=_options(),
                        cancellation=CancellationToken(),
                        approval_handler=_approve,
                    )
                )
            )
        except BaseException as error:  # noqa: BLE001 - asserted below.
            failures.append(error)

    thread = threading.Thread(target=run_first, daemon=True)
    thread.start()
    assert planner.entered.wait(5)
    with pytest.raises(StateError, match="already active"):
        asyncio.run(
            second.advance(
                started.run_id,
                goal="Keep exactly one provider owner.",
                provider=_options(),
                cancellation=CancellationToken(),
                approval_handler=_approve,
            )
        )

    pending = second.cancel(started.run_id, "concurrency test cleanup")
    assert pending.stage is AutonomyStage.PLAN
    thread.join(timeout=8)
    assert not thread.is_alive()
    assert failures == []
    assert planner.calls == 1
    assert len(results) == 1
    assert results[0].stage is AutonomyStage.STOPPED
    control = first.store.control(started.run_id)
    assert control.cancellation_acknowledged_at is not None
    assert control.lease_owner is None


def test_separate_process_cancel_waits_for_active_provider_acknowledgement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    acknowledgement_gate = threading.Event()
    planner = _BlockingPlanner(acknowledgement_gate)
    coding = _FakeCodingRunner([])
    loop = AutonomousProjectLoop(
        workspace,
        planner,
        coding,
        plans=plans,
        lease_seconds=2,
        heartbeat_seconds=0.05,
    )
    started = loop.start("Cancel from a separate coordinator process.")
    results: list[object] = []
    failures: list[BaseException] = []
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)

    def run_active() -> None:
        try:
            results.append(
                asyncio.run(
                    loop.advance(
                        started.run_id,
                        goal="Cancel from a separate coordinator process.",
                        provider=_options(),
                        cancellation=CancellationToken(),
                        approval_handler=_approve,
                    )
                )
            )
        except BaseException as error:  # noqa: BLE001 - asserted below.
            failures.append(error)

    thread = threading.Thread(target=run_active, daemon=True)
    thread.start()
    assert planner.entered.wait(5)
    script = """
import sys
from pathlib import Path
from fikeya_runtime.autonomy import AutonomousProjectLoop
from fikeya_runtime.workspace import Workspace

class Stub:
    pass

loop = AutonomousProjectLoop(Workspace.load(Path(sys.argv[1])), Stub(), Stub())
record = loop.cancel(sys.argv[2], "external process cancelled")
print(record.stage.value)
"""
    cancelled = subprocess.run(
        [sys.executable, "-c", script, str(workspace.root), started.run_id],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert cancelled.stdout.strip() == AutonomyStage.PLAN.value
    assert planner.cancel_observed.wait(5)
    pending = loop.store.control(started.run_id)
    assert pending.cancellation_pending
    assert pending.cancellation_acknowledged_at is None
    assert loop.load(started.run_id).stage is AutonomyStage.PLAN

    acknowledgement_gate.set()
    thread.join(timeout=8)
    assert not thread.is_alive()
    assert failures == []
    assert len(results) == 1
    assert results[0].stage is AutonomyStage.STOPPED
    assert results[0].stop_reason == "external process cancelled"
    acknowledged = loop.store.control(started.run_id)
    assert not acknowledged.cancellation_pending
    assert acknowledged.cancellation_acknowledged_at is not None


def test_stale_lease_takeover_replaces_owner_and_fences_old_heartbeat(
    tmp_path: Path,
) -> None:
    workspace, plans = _workspace(tmp_path)
    loop = AutonomousProjectLoop(
        workspace,
        _FakePlanner(plans, []),
        _FakeCodingRunner([]),
        plans=plans,
    )
    started = loop.start("Recover a run after its owner disappears.")
    current = [100.0]
    store = AutonomyStore(workspace, clock=lambda: current[0])
    first = store.acquire_lease(started.run_id, "lease_first", lease_seconds=5)
    assert first.lease_owner == "lease_first"
    with pytest.raises(StateError, match="already active"):
        store.acquire_lease(started.run_id, "lease_second", lease_seconds=5)

    current[0] += 6
    recovered = store.acquire_lease(
        started.run_id, "lease_second", lease_seconds=5
    )
    assert recovered.lease_owner == "lease_second"
    with pytest.raises(StateError, match="lease was lost"):
        store.heartbeat(started.run_id, "lease_first", lease_seconds=5)


def test_durable_cancel_terminates_approved_process_tree_before_stopped(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace, plans = _workspace(tmp_path)
    child_code = (
        "import time; from pathlib import Path; time.sleep(1.5); "
        "Path('child-survived.txt').write_text('unsafe', encoding='utf-8')"
    )
    parent_code = (
        "import subprocess, sys, time; from pathlib import Path; "
        "Path('process-started.txt').write_text('started', encoding='utf-8'); "
        f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
        "time.sleep(30)"
    )
    specification = {
        "schemaVersion": 1,
        "title": "Run a cancellable process tree",
        "steps": [
            {
                "stepId": "process-tree",
                "title": "Start a bounded process tree",
                "toolCall": {
                    "arguments": {
                        "arguments": ["-c", parent_code],
                        "cwd": ".",
                        "executable": "python",
                        "timeoutSeconds": 60,
                    },
                    "callId": "process:tree",
                    "name": "process.run",
                },
                "verify": {"expectedStatus": "ok"},
            }
        ],
    }
    plan = plans.create(specification)
    plans.review(plan.plan_id)
    plans.approve(plan.plan_id, approve_all=True)
    planner = _FakePlanner(plans, [])
    coding = _FakeCodingRunner([])
    loop = AutonomousProjectLoop(
        workspace,
        planner,
        coding,
        plans=plans,
        lease_seconds=2,
        heartbeat_seconds=0.05,
    )
    started = loop.start("Terminate the approved process tree on cancel.")
    executing = loop.store.save(
        replace(
            started,
            stage=AutonomyStage.EXECUTE,
            plan_id=plan.plan_id,
            plan_spec_sha256=plan.spec_sha256,
            plan_history=(plan.spec_sha256,),
        )
    )
    results: list[object] = []
    failures: list[BaseException] = []
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)

    def run_active() -> None:
        try:
            results.append(
                asyncio.run(
                    loop.advance(
                        executing.run_id,
                        goal="Terminate the approved process tree on cancel.",
                        provider=_options(),
                        cancellation=CancellationToken(),
                        approval_handler=_approve,
                    )
                )
            )
        except BaseException as error:  # noqa: BLE001 - asserted below.
            failures.append(error)

    thread = threading.Thread(target=run_active, daemon=True)
    thread.start()
    started_marker = workspace.root / "process-started.txt"
    deadline = time.monotonic() + 8
    while not started_marker.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert started_marker.exists()

    pending = AutonomousProjectLoop(
        workspace,
        planner,
        coding,
        plans=PlanService(workspace),
    ).cancel(executing.run_id, "terminate process tree")
    assert pending.stage is AutonomyStage.EXECUTE
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert failures == []
    assert len(results) == 1
    assert results[0].stage is AutonomyStage.STOPPED
    assert loop.store.control(executing.run_id).cancellation_acknowledged_at is not None
    time.sleep(1.7)
    assert not (workspace.root / "child-survived.txt").exists()


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
