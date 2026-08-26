# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import re
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from fikeya_runtime.cli import main
from fikeya_runtime.errors import ConfigurationError, StateError
from fikeya_runtime.plans import (
    PlanService,
    PlanStatus,
    PlanStepStatus,
    VerificationStatus,
)
from fikeya_runtime.workspace import initialize_workspace

_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


class _JsonInput:
    def __init__(self, value: dict[str, object]) -> None:
        self.buffer = io.BytesIO(json.dumps(value, separators=(",", ":")).encode())

    def isatty(self) -> bool:
        return False


class _TestClock:
    def __init__(self, current: datetime) -> None:
        self.current = current

    def __call__(self) -> datetime:
        return self.current

    def advance(self, *, seconds: int) -> None:
        self.current += timedelta(seconds=seconds)


def _sha256(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


def _run(coroutine: object, monkeypatch: pytest.MonkeyPatch) -> object:
    """Permit only asyncio's Windows self-pipe; the plan uses no network adapter."""

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    return asyncio.run(coroutine)  # type: ignore[arg-type]


def _two_step_specification(content: str = "proof\n") -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "title": "Create and inspect one deterministic proof file",
        "steps": [
            {
                "stepId": "write-proof",
                "title": "Write the proof file",
                "toolCall": {
                    "arguments": {
                        "content": content,
                        "expectedSha256": None,
                        "path": "proof.txt",
                    },
                    "callId": "write:proof",
                    "name": "workspace.write_file",
                },
                "verify": {
                    "expectedStatus": "ok",
                    "files": [{"path": "proof.txt", "sha256": _sha256(content)}],
                },
            },
            {
                "stepId": "read-proof",
                "title": "Read the verified proof file",
                "dependsOn": ["write-proof"],
                "toolCall": {
                    "arguments": {"path": "proof.txt"},
                    "callId": "read:proof",
                    "name": "workspace.read_file",
                },
                "verify": {"expectedStatus": "ok"},
            },
        ],
    }


def test_plan_pauses_for_exact_approvals_then_resumes_to_verified_proof(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    service = PlanService(workspace)
    draft = service.create(_two_step_specification())

    assert draft.status is PlanStatus.DRAFT
    assert [step.order for step in draft.steps] == [1, 2]
    assert draft.steps[1].depends_on == ("write-proof",)
    with pytest.raises(StateError, match="already exists"):
        service.create(_two_step_specification())

    reviewed = service.review(draft.plan_id)
    waiting = _run(service.run(reviewed.plan_id), monkeypatch)
    assert hasattr(waiting, "status")
    assert waiting.status is PlanStatus.AWAITING_APPROVAL
    assert waiting.steps[0].status is PlanStepStatus.AWAITING_APPROVAL
    assert not (root / "proof.txt").exists()

    approved, references = service.approve(
        draft.plan_id, step_ids=("write-proof",)
    )
    assert approved.steps[0].approval == references[0]
    assert references[0].consumed_at is None
    with pytest.raises(StateError, match="not awaiting a new approval"):
        service.approve(draft.plan_id, step_ids=("write-proof",))

    paused = _run(service.run(draft.plan_id), monkeypatch)
    assert hasattr(paused, "status")
    assert paused.status is PlanStatus.AWAITING_APPROVAL
    assert paused.steps[0].status is PlanStepStatus.SUCCEEDED
    assert paused.steps[0].approval is not None
    assert paused.steps[0].approval.consumed_at is not None
    assert paused.steps[0].verification is not None
    assert paused.steps[0].verification.status is VerificationStatus.PASSED
    assert paused.steps[1].status is PlanStepStatus.AWAITING_APPROVAL
    assert (root / "proof.txt").read_text(encoding="utf-8") == "proof\n"

    service.approve(draft.plan_id, step_ids=("read-proof",))
    completed = _run(service.run(draft.plan_id, resume=True), monkeypatch)
    assert hasattr(completed, "status")
    assert completed.status is PlanStatus.SUCCEEDED
    assert all(step.status is PlanStepStatus.SUCCEEDED for step in completed.steps)

    view = service.view(completed)
    receipt = view["receipt"]
    assert isinstance(receipt, dict)
    serialized_receipt = json.dumps(receipt, separators=(",", ":"))
    assert "proof\n" not in serialized_receipt
    assert _DIGEST.fullmatch(str(view["recordSha256"]))
    assert _DIGEST.fullmatch(str(receipt["steps"][0]["toolCallSha256"]))
    assert _DIGEST.fullmatch(str(receipt["steps"][0]["resultSha256"]))
    assert _DIGEST.fullmatch(str(receipt["steps"][0]["verificationSha256"]))


def test_expired_plan_approval_is_rejected_before_execution_and_can_be_reissued(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    clock = _TestClock(datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc))
    service = PlanService(workspace, clock=clock)
    draft = service.create(_two_step_specification())
    service.review(draft.plan_id)

    approved, references = service.approve(
        draft.plan_id,
        step_ids=("write-proof",),
    )
    reference = references[0]
    assert reference.as_json() == {
        "consumedAt": None,
        "expiresAt": "2026-08-26T12:05:00.000Z",
        "issuedAt": "2026-08-26T12:00:00.000Z",
        "referenceId": reference.reference_id,
        "toolCallSha256": approved.steps[0].tool_call_sha256,
    }
    assert service.store.load(draft.plan_id).steps[0].approval == reference

    clock.advance(seconds=300)
    waiting = _run(service.run(draft.plan_id), monkeypatch)
    assert hasattr(waiting, "status")
    assert waiting.status is PlanStatus.AWAITING_APPROVAL
    assert waiting.steps[0].status is PlanStepStatus.AWAITING_APPROVAL
    assert waiting.steps[0].approval == reference
    assert waiting.steps[0].approval.consumed_at is None
    assert not (root / "proof.txt").exists()

    reapproved, replacements = service.approve(
        draft.plan_id,
        step_ids=("write-proof",),
        ttl_seconds=60,
    )
    replacement = replacements[0]
    assert replacement.reference_id != reference.reference_id
    assert replacement.tool_call_sha256 == reference.tool_call_sha256
    assert replacement.expires_at == "2026-08-26T12:06:00.000Z"
    assert reapproved.steps[0].approval == replacement

    resumed = _run(service.run(draft.plan_id), monkeypatch)
    assert hasattr(resumed, "status")
    assert resumed.steps[0].status is PlanStepStatus.SUCCEEDED
    assert resumed.steps[0].approval is not None
    assert resumed.steps[0].approval.consumed_at is not None
    assert (root / "proof.txt").read_text(encoding="utf-8") == "proof\n"


@pytest.mark.parametrize("ttl_seconds", [True, 0, 601, 1.5])
def test_plan_approval_rejects_invalid_lifetimes(
    tmp_path: Path,
    ttl_seconds: object,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    service = PlanService(workspace)
    plan = service.create(_two_step_specification())
    service.review(plan.plan_id)

    with pytest.raises(ConfigurationError, match="between 1 and 600 seconds"):
        service.approve(
            plan.plan_id,
            approve_all=True,
            ttl_seconds=ttl_seconds,  # type: ignore[arg-type]
        )


def test_plan_fails_closed_when_file_verification_disagrees(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    service = PlanService(workspace)
    specification = _two_step_specification()
    first_step = specification["steps"][0]
    assert isinstance(first_step, dict)
    verification = first_step["verify"]
    assert isinstance(verification, dict)
    verification["files"] = [{"path": "proof.txt", "sha256": "0" * 64}]

    plan = service.create(specification)
    service.review(plan.plan_id)
    service.approve(plan.plan_id, approve_all=True)
    failed = _run(service.run(plan.plan_id), monkeypatch)
    assert hasattr(failed, "status")

    assert failed.status is PlanStatus.FAILED
    assert failed.failure_reason == "Verification failed for write-proof."
    assert failed.steps[0].status is PlanStepStatus.FAILED
    assert failed.steps[0].verification is not None
    assert failed.steps[0].verification.status is VerificationStatus.FAILED
    assert failed.steps[1].status is PlanStepStatus.APPROVED


@pytest.mark.parametrize(
    ("path", "exit_code"),
    [
        (".fikeya/state.sqlite3", 0),
        ("nested\\proof.txt", 0),
        ("C:/proof.txt", 0),
        ("proof.txt", 2_147_483_648),
    ],
)
def test_plan_rejects_nonportable_verification_paths_and_exit_codes(
    tmp_path: Path,
    path: str,
    exit_code: int,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    service = PlanService(workspace)
    specification = _two_step_specification()
    first_step = specification["steps"][0]
    assert isinstance(first_step, dict)
    verification = first_step["verify"]
    assert isinstance(verification, dict)
    verification["files"] = [{"path": path, "sha256": _sha256("proof\n")}]
    verification["expectedExitCode"] = exit_code

    with pytest.raises(ConfigurationError):
        service.create(specification)


def test_cli_create_review_approve_run_and_show_plan(
    tmp_path: Path,
    capsys: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["init", str(workspace), "--json"]) == 0
    capsys.readouterr()

    monkeypatch.setattr("sys.stdin", _JsonInput(_two_step_specification("cli proof\n")))
    assert (
        main(["plan", "create", str(workspace), "--spec-stdin", "--json"])
        == 0
    )
    created = json.loads(capsys.readouterr().out)
    plan_id = created["plan"]["planId"]
    assert created["plan"]["status"] == "draft"

    assert main(["plan", "review", plan_id, "--workspace", str(workspace), "--json"]) == 0
    capsys.readouterr()
    assert main(["plan", "approve", plan_id, "--workspace", str(workspace), "--all", "--json"]) == 0
    approved = json.loads(capsys.readouterr().out)
    assert len(approved["approvalReferences"]) == 2

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    assert main(["plan", "run", plan_id, "--workspace", str(workspace), "--json"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["plan"]["status"] == "succeeded"
    assert (workspace / "proof.txt").read_text(encoding="utf-8") == "cli proof\n"

    assert main(["plan", "show", plan_id, "--workspace", str(workspace), "--json"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["recordSha256"] == result["recordSha256"]
    assert shown["receipt"]["status"] == "succeeded"
