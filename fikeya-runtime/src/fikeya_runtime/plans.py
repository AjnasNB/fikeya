# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Durable, approval-gated plan-to-proof orchestration for local workspaces."""

from __future__ import annotations

import enum
import hashlib
import json
import re
import sqlite3
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import cast

from fikeya_agent_core import CancellationToken, ToolCall

from .coding import ToolExecutionReceipt, WorkspaceExecutionBroker
from .errors import ConfigurationError, FikeyaError, StateError
from .state import StateStore
from .util import sha256_text, stable_json, utc_now, validate_identifier
from .workspace import Workspace

_PLAN_SCHEMA_VERSION = 1
_MAX_PLAN_BYTES = 1_048_576
_MAX_STEPS = 64
_MAX_TITLE_BYTES = 4_096
_MAX_VERIFICATION_FILE_BYTES = 33_554_432
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_SUPPORTED_TOOLS = frozenset(
    {
        "process.run",
        "workspace.list_files",
        "workspace.read_file",
        "workspace.replace_text",
        "workspace.search_text",
        "workspace.write_file",
    }
)


class PlanStatus(str, enum.Enum):
    """Durable plan states exposed to CLI, desktop, and receipt consumers."""

    DRAFT = "draft"
    REVIEWED = "reviewed"
    AWAITING_APPROVAL = "awaiting_approval"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PlanStepStatus(str, enum.Enum):
    """A step's durable progress without retaining execution output."""

    PENDING = "pending"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class VerificationStatus(str, enum.Enum):
    """Result of independently checking a completed tool operation."""

    PENDING = "pending"
    PASSED = "passed"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class FileHashExpectation:
    """Expected identity of one project-relative file after a step."""

    path: str
    sha256: str

    def as_json(self) -> dict[str, object]:
        return {"path": self.path, "sha256": self.sha256}

    @classmethod
    def from_json(cls, value: object) -> FileHashExpectation:
        item = _object(value, "file verification")
        _exact_keys(item, {"path", "sha256"}, "file verification")
        path = _string(item, "path", "file verification")
        path_parts = Path(path).parts
        if (
            Path(path).is_absolute()
            or path in {"", "."}
            or ".." in path_parts
            or any(part.casefold() == ".fikeya" for part in path_parts)
        ):
            raise ConfigurationError("Verification file paths must be project-relative files.")
        return cls(path=path, sha256=_digest(_string(item, "sha256", "file verification")))


@dataclass(frozen=True, slots=True)
class VerificationSpec:
    """Content-free assertions evaluated after one tool operation."""

    expected_status: str = "ok"
    expected_exit_code: int | None = None
    expected_output_sha256: str | None = None
    files: tuple[FileHashExpectation, ...] = ()

    def __post_init__(self) -> None:
        if self.expected_status not in {"ok", "denied", "error"}:
            raise ConfigurationError("expectedStatus must be ok, denied, or error.")
        if self.expected_exit_code is not None and (
            isinstance(self.expected_exit_code, bool)
            or not isinstance(self.expected_exit_code, int)
        ):
            raise ConfigurationError("expectedExitCode must be an integer or null.")
        if self.expected_output_sha256 is not None:
            _digest(self.expected_output_sha256)
        paths = [item.path for item in self.files]
        if len(paths) != len(set(paths)):
            raise ConfigurationError("Verification file paths must be unique.")

    def as_json(self) -> dict[str, object]:
        return {
            "expectedExitCode": self.expected_exit_code,
            "expectedOutputSha256": self.expected_output_sha256,
            "expectedStatus": self.expected_status,
            "files": [item.as_json() for item in self.files],
        }

    @classmethod
    def from_json(cls, value: object | None) -> VerificationSpec:
        if value is None:
            return cls()
        item = _object(value, "verification")
        _exact_keys(
            item,
            {"expectedExitCode", "expectedOutputSha256", "expectedStatus", "files"},
            "verification",
            optional={"expectedExitCode", "expectedOutputSha256", "expectedStatus", "files"},
        )
        exit_code = item.get("expectedExitCode")
        if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
            raise ConfigurationError("expectedExitCode must be an integer or null.")
        output_sha256 = item.get("expectedOutputSha256")
        if output_sha256 is not None and not isinstance(output_sha256, str):
            raise ConfigurationError("expectedOutputSha256 must be a SHA-256 string or null.")
        files_value = item.get("files", [])
        if not isinstance(files_value, list) or len(files_value) > _MAX_STEPS:
            raise ConfigurationError("Verification files must be an array with at most 64 entries.")
        return cls(
            expected_status=_optional_string(item, "expectedStatus", "ok"),
            expected_exit_code=exit_code,
            expected_output_sha256=(
                _digest(output_sha256) if isinstance(output_sha256, str) else None
            ),
            files=tuple(FileHashExpectation.from_json(entry) for entry in files_value),
        )


@dataclass(frozen=True, slots=True)
class VerificationCheck:
    """One safe comparison supporting a final verification outcome."""

    kind: str
    subject: str
    expected: str
    actual: str
    passed: bool

    def as_json(self) -> dict[str, object]:
        return {
            "actual": self.actual,
            "expected": self.expected,
            "kind": self.kind,
            "passed": self.passed,
            "subject": self.subject,
        }

    @classmethod
    def from_json(cls, value: object) -> VerificationCheck:
        item = _object(value, "verification check")
        _exact_keys(
            item,
            {"actual", "expected", "kind", "passed", "subject"},
            "verification check",
        )
        passed = item["passed"]
        if not isinstance(passed, bool):
            raise ConfigurationError("Verification check passed must be boolean.")
        return cls(
            kind=_string(item, "kind", "verification check"),
            subject=_string(item, "subject", "verification check"),
            expected=_string(item, "expected", "verification check", allow_empty=True),
            actual=_string(item, "actual", "verification check", allow_empty=True),
            passed=passed,
        )


@dataclass(frozen=True, slots=True)
class VerificationOutcome:
    """Hash-addressed verification result suitable for proof receipts."""

    status: VerificationStatus
    checks: tuple[VerificationCheck, ...]
    verified_at: str
    outcome_sha256: str

    def as_json(self) -> dict[str, object]:
        return {
            "checks": [item.as_json() for item in self.checks],
            "outcomeSha256": self.outcome_sha256,
            "status": self.status.value,
            "verifiedAt": self.verified_at,
        }

    @classmethod
    def create(cls, checks: tuple[VerificationCheck, ...]) -> VerificationOutcome:
        status = (
            VerificationStatus.PASSED
            if checks and all(item.passed for item in checks)
            else VerificationStatus.FAILED
        )
        verified_at = utc_now()
        payload = {
            "checks": [item.as_json() for item in checks],
            "status": status.value,
            "verifiedAt": verified_at,
        }
        return cls(status, checks, verified_at, sha256_text(stable_json(payload)))

    @classmethod
    def from_json(cls, value: object) -> VerificationOutcome:
        item = _object(value, "verification outcome")
        _exact_keys(
            item,
            {"checks", "outcomeSha256", "status", "verifiedAt"},
            "verification outcome",
        )
        checks_value = item["checks"]
        if not isinstance(checks_value, list):
            raise ConfigurationError("Verification outcome checks must be an array.")
        outcome = cls(
            status=VerificationStatus(_string(item, "status", "verification outcome")),
            checks=tuple(VerificationCheck.from_json(entry) for entry in checks_value),
            verified_at=_string(item, "verifiedAt", "verification outcome"),
            outcome_sha256=_digest(_string(item, "outcomeSha256", "verification outcome")),
        )
        expected = cls.create_from_values(outcome.status, outcome.checks, outcome.verified_at)
        if outcome.outcome_sha256 != expected:
            raise StateError("Verification outcome digest does not match its checks.")
        return outcome

    @staticmethod
    def create_from_values(
        status: VerificationStatus,
        checks: tuple[VerificationCheck, ...],
        verified_at: str,
    ) -> str:
        return sha256_text(
            stable_json(
                {
                    "checks": [item.as_json() for item in checks],
                    "status": status.value,
                    "verifiedAt": verified_at,
                }
            )
        )


@dataclass(frozen=True, slots=True)
class PlanApprovalReference:
    """Durable reference to one exact, single-use tool approval."""

    reference_id: str
    tool_call_sha256: str
    issued_at: str
    consumed_at: str | None = None

    def as_json(self) -> dict[str, object]:
        return {
            "consumedAt": self.consumed_at,
            "issuedAt": self.issued_at,
            "referenceId": self.reference_id,
            "toolCallSha256": self.tool_call_sha256,
        }

    @classmethod
    def from_json(cls, value: object) -> PlanApprovalReference:
        item = _object(value, "approval reference")
        _exact_keys(
            item,
            {"consumedAt", "issuedAt", "referenceId", "toolCallSha256"},
            "approval reference",
        )
        consumed = item["consumedAt"]
        if consumed is not None and not isinstance(consumed, str):
            raise ConfigurationError("Approval consumedAt must be a string or null.")
        reference_id = _string(item, "referenceId", "approval reference")
        validate_identifier(reference_id, "approval reference")
        return cls(
            reference_id=reference_id,
            tool_call_sha256=_digest(
                _string(item, "toolCallSha256", "approval reference")
            ),
            issued_at=_string(item, "issuedAt", "approval reference"),
            consumed_at=consumed,
        )


@dataclass(frozen=True, slots=True)
class StepExecutionOutcome:
    """Content-free identity and timing for one broker result."""

    tool_call_sha256: str
    result_sha256: str
    execution_sha256: str
    status: str
    started_at: str
    finished_at: str
    duration_ms: int | None
    exit_code: int | None

    def as_json(self) -> dict[str, object]:
        return {
            "durationMs": self.duration_ms,
            "executionSha256": self.execution_sha256,
            "exitCode": self.exit_code,
            "finishedAt": self.finished_at,
            "resultSha256": self.result_sha256,
            "startedAt": self.started_at,
            "status": self.status,
            "toolCallSha256": self.tool_call_sha256,
        }

    @classmethod
    def create(
        cls,
        receipt: ToolExecutionReceipt,
        *,
        tool_call_sha256: str,
        started_at: str,
    ) -> StepExecutionOutcome:
        finished_at = utc_now()
        payload = {
            "durationMs": receipt.duration_ms,
            "exitCode": receipt.exit_code,
            "finishedAt": finished_at,
            "resultSha256": receipt.output_sha256,
            "startedAt": started_at,
            "status": receipt.status,
            "toolCallSha256": tool_call_sha256,
        }
        return cls(
            tool_call_sha256=tool_call_sha256,
            result_sha256=receipt.output_sha256,
            execution_sha256=sha256_text(stable_json(payload)),
            status=receipt.status,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=receipt.duration_ms,
            exit_code=receipt.exit_code,
        )

    @classmethod
    def from_json(cls, value: object) -> StepExecutionOutcome:
        item = _object(value, "execution outcome")
        _exact_keys(
            item,
            {
                "durationMs",
                "executionSha256",
                "exitCode",
                "finishedAt",
                "resultSha256",
                "startedAt",
                "status",
                "toolCallSha256",
            },
            "execution outcome",
        )
        duration = item["durationMs"]
        exit_code = item["exitCode"]
        if duration is not None and (isinstance(duration, bool) or not isinstance(duration, int)):
            raise ConfigurationError("Execution durationMs must be an integer or null.")
        if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
            raise ConfigurationError("Execution exitCode must be an integer or null.")
        outcome = cls(
            tool_call_sha256=_digest(
                _string(item, "toolCallSha256", "execution outcome")
            ),
            result_sha256=_digest(_string(item, "resultSha256", "execution outcome")),
            execution_sha256=_digest(
                _string(item, "executionSha256", "execution outcome")
            ),
            status=_string(item, "status", "execution outcome"),
            started_at=_string(item, "startedAt", "execution outcome"),
            finished_at=_string(item, "finishedAt", "execution outcome"),
            duration_ms=duration,
            exit_code=exit_code,
        )
        payload = outcome.as_json()
        payload.pop("executionSha256")
        if outcome.execution_sha256 != sha256_text(stable_json(payload)):
            raise StateError("Execution outcome digest does not match its receipt fields.")
        return outcome


@dataclass(frozen=True, slots=True)
class PlanStep:
    """One ordered, dependency-aware, approval-gated tool operation."""

    step_id: str
    order: int
    title: str
    depends_on: tuple[str, ...]
    tool_call: ToolCall
    tool_call_sha256: str
    verification_spec: VerificationSpec
    status: PlanStepStatus = PlanStepStatus.PENDING
    approval: PlanApprovalReference | None = None
    execution: StepExecutionOutcome | None = None
    verification: VerificationOutcome | None = None

    def as_json(self) -> dict[str, object]:
        return {
            "approval": self.approval.as_json() if self.approval else None,
            "dependsOn": list(self.depends_on),
            "execution": self.execution.as_json() if self.execution else None,
            "order": self.order,
            "status": self.status.value,
            "stepId": self.step_id,
            "title": self.title,
            "toolCall": _tool_call_json(self.tool_call),
            "toolCallSha256": self.tool_call_sha256,
            "verification": self.verification.as_json() if self.verification else None,
            "verificationSpec": self.verification_spec.as_json(),
        }

    @classmethod
    def from_json(cls, value: object) -> PlanStep:
        item = _object(value, "plan step")
        _exact_keys(
            item,
            {
                "approval",
                "dependsOn",
                "execution",
                "order",
                "status",
                "stepId",
                "title",
                "toolCall",
                "toolCallSha256",
                "verification",
                "verificationSpec",
            },
            "plan step",
        )
        order = item["order"]
        if isinstance(order, bool) or not isinstance(order, int) or order < 1:
            raise ConfigurationError("Plan step order must be a positive integer.")
        dependencies = item["dependsOn"]
        if not isinstance(dependencies, list) or any(
            not isinstance(entry, str) for entry in dependencies
        ):
            raise ConfigurationError("Plan step dependsOn must be a string array.")
        call = _tool_call(item["toolCall"])
        digest = _digest(_string(item, "toolCallSha256", "plan step"))
        if digest != _tool_call_sha256(call):
            raise StateError("Plan step tool-call digest does not match its exact call.")
        approval_value = item["approval"]
        execution_value = item["execution"]
        verification_value = item["verification"]
        step = cls(
            step_id=_validated_identifier(_string(item, "stepId", "plan step"), "stepId"),
            order=order,
            title=_bounded_title(_string(item, "title", "plan step")),
            depends_on=tuple(dependencies),
            tool_call=call,
            tool_call_sha256=digest,
            verification_spec=VerificationSpec.from_json(item["verificationSpec"]),
            status=PlanStepStatus(_string(item, "status", "plan step")),
            approval=(
                PlanApprovalReference.from_json(approval_value)
                if approval_value is not None
                else None
            ),
            execution=(
                StepExecutionOutcome.from_json(execution_value)
                if execution_value is not None
                else None
            ),
            verification=(
                VerificationOutcome.from_json(verification_value)
                if verification_value is not None
                else None
            ),
        )
        if step.approval is not None and step.approval.tool_call_sha256 != digest:
            raise StateError("Plan approval does not match its exact tool call.")
        if step.execution is not None and step.execution.tool_call_sha256 != digest:
            raise StateError("Plan execution does not match its exact tool call.")
        if step.verification is not None and step.execution is None:
            raise StateError("Plan verification requires an execution outcome.")
        return step


@dataclass(frozen=True, slots=True)
class PlanRecord:
    """One immutable-spec, revisioned execution plan."""

    plan_id: str
    workspace_id: str
    title: str
    status: PlanStatus
    revision: int
    spec_sha256: str
    created_at: str
    updated_at: str
    steps: tuple[PlanStep, ...]
    failure_reason: str | None = None

    def as_json(self) -> dict[str, object]:
        return {
            "createdAt": self.created_at,
            "failureReason": self.failure_reason,
            "planId": self.plan_id,
            "revision": self.revision,
            "schemaVersion": _PLAN_SCHEMA_VERSION,
            "specSha256": self.spec_sha256,
            "status": self.status.value,
            "steps": [step.as_json() for step in self.steps],
            "title": self.title,
            "updatedAt": self.updated_at,
            "workspaceId": self.workspace_id,
        }

    @classmethod
    def from_json(cls, value: object) -> PlanRecord:
        item = _object(value, "plan record")
        _exact_keys(
            item,
            {
                "createdAt",
                "failureReason",
                "planId",
                "revision",
                "schemaVersion",
                "specSha256",
                "status",
                "steps",
                "title",
                "updatedAt",
                "workspaceId",
            },
            "plan record",
        )
        if item["schemaVersion"] != _PLAN_SCHEMA_VERSION:
            raise ConfigurationError("Unsupported plan schema version.")
        revision = item["revision"]
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ConfigurationError("Plan revision must be a positive integer.")
        steps_value = item["steps"]
        if not isinstance(steps_value, list):
            raise ConfigurationError("Plan steps must be an array.")
        failure = item["failureReason"]
        if failure is not None and not isinstance(failure, str):
            raise ConfigurationError("Plan failureReason must be a string or null.")
        record = cls(
            plan_id=_validated_identifier(_string(item, "planId", "plan record"), "planId"),
            workspace_id=_validated_identifier(
                _string(item, "workspaceId", "plan record"), "workspaceId"
            ),
            title=_bounded_title(_string(item, "title", "plan record")),
            status=PlanStatus(_string(item, "status", "plan record")),
            revision=revision,
            spec_sha256=_digest(_string(item, "specSha256", "plan record")),
            created_at=_string(item, "createdAt", "plan record"),
            updated_at=_string(item, "updatedAt", "plan record"),
            steps=tuple(PlanStep.from_json(entry) for entry in steps_value),
            failure_reason=failure,
        )
        _validate_steps(record.steps)
        if record.spec_sha256 != _spec_sha256(record.title, record.steps):
            raise StateError("Plan specification digest does not match its immutable steps.")
        return record

    def receipt(self, record_sha256: str) -> dict[str, object]:
        """Return a content-free Qarinah/UI receipt projection."""

        return {
            "kind": "fikeya.plan.receipt",
            "planId": self.plan_id,
            "recordSha256": record_sha256,
            "revision": self.revision,
            "schemaVersion": _PLAN_SCHEMA_VERSION,
            "specSha256": self.spec_sha256,
            "status": self.status.value,
            "steps": [
                {
                    "approvalConsumedAt": (
                        step.approval.consumed_at if step.approval else None
                    ),
                    "approvalReference": (
                        step.approval.reference_id if step.approval else None
                    ),
                    "executionSha256": (
                        step.execution.execution_sha256 if step.execution else None
                    ),
                    "order": step.order,
                    "resultSha256": (
                        step.execution.result_sha256 if step.execution else None
                    ),
                    "status": step.status.value,
                    "stepId": step.step_id,
                    "toolCallSha256": step.tool_call_sha256,
                    "toolName": step.tool_call.name,
                    "verificationSha256": (
                        step.verification.outcome_sha256 if step.verification else None
                    ),
                    "verificationStatus": (
                        step.verification.status.value if step.verification else None
                    ),
                }
                for step in self.steps
            ],
            "workspaceId": self.workspace_id,
        }


class PlanStore:
    """Persist integrity-checked plan documents in the workspace SQLite database."""

    def __init__(self, workspace: Workspace) -> None:
        self.workspace = workspace
        self.state = StateStore(workspace.state_path)
        self.state.initialize()

    def create(self, plan: PlanRecord) -> PlanRecord:
        document = stable_json(plan.as_json())
        digest = sha256_text(document)
        with self.state._connect() as connection:
            try:
                connection.execute(
                    """
                    INSERT INTO execution_plans (
                        plan_id, revision, status, document_json, document_sha256,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        plan.plan_id,
                        plan.revision,
                        plan.status.value,
                        document,
                        digest,
                        plan.created_at,
                        plan.updated_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "UNIQUE constraint failed" in str(error):
                    raise StateError(f"Plan already exists: {plan.plan_id}") from error
                raise
        return plan

    def load(self, plan_id: str) -> PlanRecord:
        validate_identifier(plan_id, "planId")
        with self.state._connect() as connection:
            row = connection.execute(
                """
                SELECT revision, status, document_json, document_sha256
                FROM execution_plans WHERE plan_id = ?
                """,
                (plan_id,),
            ).fetchone()
        if row is None:
            raise StateError(f"Unknown plan: {plan_id}")
        document = str(row["document_json"])
        if str(row["document_sha256"]) != sha256_text(document):
            raise StateError("Persisted plan document failed its integrity check.")
        try:
            value = json.loads(document)
        except json.JSONDecodeError as error:
            raise StateError("Persisted plan document is not valid JSON.") from error
        plan = PlanRecord.from_json(value)
        if plan.revision != int(row["revision"]) or plan.status.value != row["status"]:
            raise StateError("Persisted plan index does not match its document.")
        return plan

    def save(self, plan: PlanRecord) -> PlanRecord:
        updated = replace(plan, revision=plan.revision + 1, updated_at=utc_now())
        document = stable_json(updated.as_json())
        digest = sha256_text(document)
        with self.state._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                """
                UPDATE execution_plans
                SET revision = ?, status = ?, document_json = ?, document_sha256 = ?,
                    updated_at = ?
                WHERE plan_id = ? AND revision = ?
                """,
                (
                    updated.revision,
                    updated.status.value,
                    document,
                    digest,
                    updated.updated_at,
                    updated.plan_id,
                    plan.revision,
                ),
            )
            if cursor.rowcount != 1:
                raise StateError("Plan changed concurrently; reload it before continuing.")
        return updated

    @staticmethod
    def record_sha256(plan: PlanRecord) -> str:
        return sha256_text(stable_json(plan.as_json()))


class PlanService:
    """Create, approve, execute, verify, and resume deterministic local plans."""

    def __init__(self, workspace: Workspace) -> None:
        self.workspace = workspace
        self.store = PlanStore(workspace)

    def create(self, specification: dict[str, object]) -> PlanRecord:
        title, steps = _parse_specification(specification)
        spec_sha256 = _spec_sha256(title, steps)
        now = utc_now()
        plan = PlanRecord(
            plan_id=f"pln_{spec_sha256.removeprefix('sha256:')[:24]}",
            workspace_id=self.workspace.config.workspace_id,
            title=title,
            status=PlanStatus.DRAFT,
            revision=1,
            spec_sha256=spec_sha256,
            created_at=now,
            updated_at=now,
            steps=steps,
        )
        return self.store.create(plan)

    def show(self, plan_id: str) -> dict[str, object]:
        return self.view(self.store.load(plan_id))

    def review(self, plan_id: str) -> PlanRecord:
        plan = self.store.load(plan_id)
        if plan.status is not PlanStatus.DRAFT:
            raise StateError("Only a draft plan can be reviewed.")
        return self.store.save(replace(plan, status=PlanStatus.REVIEWED))

    def approve(
        self,
        plan_id: str,
        *,
        step_ids: tuple[str, ...] = (),
        approve_all: bool = False,
    ) -> tuple[PlanRecord, tuple[PlanApprovalReference, ...]]:
        plan = self.store.load(plan_id)
        if plan.status not in {PlanStatus.REVIEWED, PlanStatus.AWAITING_APPROVAL}:
            raise StateError("Plan approvals require a reviewed or awaiting-approval plan.")
        if approve_all == bool(step_ids):
            raise ConfigurationError("Choose either --step or --all for plan approval.")
        requested = set(step_ids)
        if len(requested) != len(step_ids):
            raise ConfigurationError("Each plan step can be approved only once per request.")
        selected: list[PlanStep] = []
        references: list[PlanApprovalReference] = []
        for step in plan.steps:
            should_approve = approve_all or step.step_id in requested
            if not should_approve:
                selected.append(step)
                continue
            if step.status not in {
                PlanStepStatus.PENDING,
                PlanStepStatus.AWAITING_APPROVAL,
            } or step.approval is not None:
                raise StateError(f"Step is not awaiting a new approval: {step.step_id}")
            reference = PlanApprovalReference(
                reference_id=f"apr_{uuid.uuid4().hex}",
                tool_call_sha256=step.tool_call_sha256,
                issued_at=utc_now(),
            )
            references.append(reference)
            selected.append(
                replace(
                    step,
                    approval=reference,
                    status=PlanStepStatus.APPROVED,
                )
            )
            requested.discard(step.step_id)
        if requested:
            raise StateError(f"Unknown plan step: {sorted(requested)[0]}")
        if not references:
            raise StateError("No pending plan steps were selected for approval.")
        updated = self.store.save(
            replace(
                plan,
                status=PlanStatus.AWAITING_APPROVAL,
                steps=tuple(selected),
            )
        )
        return updated, tuple(references)

    async def run(
        self,
        plan_id: str,
        *,
        allowed_executables: frozenset[str] | None = None,
        resume: bool = False,
        cancellation: CancellationToken | None = None,
    ) -> PlanRecord:
        plan = self.store.load(plan_id)
        if plan.status is PlanStatus.DRAFT:
            raise StateError("Review the draft plan before running it.")
        if plan.status in {PlanStatus.FAILED, PlanStatus.CANCELLED}:
            raise StateError(f"A {plan.status.value} plan cannot run.")
        if plan.status is PlanStatus.SUCCEEDED:
            return plan
        token = cancellation or CancellationToken()
        broker = (
            WorkspaceExecutionBroker(self.workspace)
            if allowed_executables is None
            else WorkspaceExecutionBroker(
                self.workspace, allowed_executables=allowed_executables
            )
        )
        while True:
            current = _first_incomplete(plan.steps)
            if current is None:
                return self.store.save(replace(plan, status=PlanStatus.SUCCEEDED))
            if not _dependencies_succeeded(current, plan.steps):
                return self.store.save(
                    replace(
                        plan,
                        status=PlanStatus.FAILED,
                        failure_reason=f"Dependencies did not succeed for {current.step_id}.",
                        steps=_replace_step(
                            plan.steps,
                            replace(current, status=PlanStepStatus.FAILED),
                        ),
                    )
                )
            if current.status is PlanStepStatus.VERIFYING:
                if current.execution is None:
                    return self._fail_uncertain(plan, current)
                plan = self._verify(plan, current)
                if plan.status is PlanStatus.FAILED:
                    return plan
                continue
            if current.status is PlanStepStatus.EXECUTING:
                return self._fail_uncertain(plan, current)
            approval = current.approval
            if (
                current.status is not PlanStepStatus.APPROVED
                or approval is None
                or approval.consumed_at is not None
            ):
                waiting = replace(current, status=PlanStepStatus.AWAITING_APPROVAL)
                return self.store.save(
                    replace(
                        plan,
                        status=PlanStatus.AWAITING_APPROVAL,
                        steps=_replace_step(plan.steps, waiting),
                    )
                )
            if approval.tool_call_sha256 != current.tool_call_sha256:
                raise StateError("Approval does not match the exact planned tool call.")
            token.raise_if_cancelled()
            started_at = utc_now()
            executing = replace(
                current,
                status=PlanStepStatus.EXECUTING,
                approval=replace(approval, consumed_at=started_at),
            )
            plan = self.store.save(
                replace(
                    plan,
                    status=PlanStatus.EXECUTING,
                    steps=_replace_step(plan.steps, executing),
                )
            )
            try:
                await broker.execute(
                    executing.tool_call,
                    token,
                    idempotency_key=_execution_key(plan, executing),
                )
            except Exception as error:
                failed = replace(executing, status=PlanStepStatus.FAILED)
                return self.store.save(
                    replace(
                        plan,
                        status=PlanStatus.FAILED,
                        failure_reason=f"Broker stopped safely: {type(error).__name__}.",
                        steps=_replace_step(plan.steps, failed),
                    )
                )
            receipt = next(
                (
                    item
                    for item in reversed(broker.state.receipts)
                    if item.call_id == executing.tool_call.call_id
                ),
                None,
            )
            if receipt is None:
                return self._fail_uncertain(plan, executing)
            verifying = replace(
                executing,
                status=PlanStepStatus.VERIFYING,
                execution=StepExecutionOutcome.create(
                    receipt,
                    tool_call_sha256=executing.tool_call_sha256,
                    started_at=started_at,
                ),
            )
            plan = self.store.save(
                replace(
                    plan,
                    status=PlanStatus.VERIFYING,
                    steps=_replace_step(plan.steps, verifying),
                )
            )
            plan = self._verify(plan, verifying)
            if plan.status is PlanStatus.FAILED:
                return plan
            if not resume:
                # A single call may continue across already-approved ordered steps.
                resume = True

    def cancel(self, plan_id: str, reason: str) -> PlanRecord:
        plan = self.store.load(plan_id)
        if plan.status in {
            PlanStatus.SUCCEEDED,
            PlanStatus.FAILED,
            PlanStatus.CANCELLED,
        }:
            raise StateError(f"A {plan.status.value} plan is already terminal.")
        bounded_reason = reason.strip()[:512] or "person cancelled"
        steps = tuple(
            step
            if step.status is PlanStepStatus.SUCCEEDED
            else replace(step, status=PlanStepStatus.CANCELLED)
            for step in plan.steps
        )
        return self.store.save(
            replace(
                plan,
                status=PlanStatus.CANCELLED,
                failure_reason=bounded_reason,
                steps=steps,
            )
        )

    def view(self, plan: PlanRecord) -> dict[str, object]:
        record_sha256 = self.store.record_sha256(plan)
        return {
            "plan": plan.as_json(),
            "receipt": plan.receipt(record_sha256),
            "recordSha256": record_sha256,
        }

    def _verify(self, plan: PlanRecord, step: PlanStep) -> PlanRecord:
        assert step.execution is not None
        checks = [
            VerificationCheck(
                kind="tool_status",
                subject=step.tool_call.name,
                expected=step.verification_spec.expected_status,
                actual=step.execution.status,
                passed=(
                    step.execution.status == step.verification_spec.expected_status
                ),
            )
        ]
        if step.verification_spec.expected_exit_code is not None:
            expected_exit = str(step.verification_spec.expected_exit_code)
            actual_exit = (
                "unavailable"
                if step.execution.exit_code is None
                else str(step.execution.exit_code)
            )
            checks.append(
                VerificationCheck(
                    kind="exit_code",
                    subject=step.tool_call.name,
                    expected=expected_exit,
                    actual=actual_exit,
                    passed=actual_exit == expected_exit,
                )
            )
        if step.verification_spec.expected_output_sha256 is not None:
            checks.append(
                VerificationCheck(
                    kind="result_sha256",
                    subject=step.tool_call.call_id,
                    expected=step.verification_spec.expected_output_sha256,
                    actual=step.execution.result_sha256,
                    passed=(
                        step.execution.result_sha256
                        == step.verification_spec.expected_output_sha256
                    ),
                )
            )
        for expected_file in step.verification_spec.files:
            try:
                path = self.workspace.boundary.resolve(
                    expected_file.path, must_exist=True
                )
                if not path.is_file() or path.stat().st_size > _MAX_VERIFICATION_FILE_BYTES:
                    actual = "unavailable"
                else:
                    actual = f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
            except (FikeyaError, OSError):
                actual = "unavailable"
            checks.append(
                VerificationCheck(
                    kind="file_sha256",
                    subject=expected_file.path,
                    expected=expected_file.sha256,
                    actual=actual,
                    passed=actual == expected_file.sha256,
                )
            )
        outcome = VerificationOutcome.create(tuple(checks))
        status = (
            PlanStepStatus.SUCCEEDED
            if outcome.status is VerificationStatus.PASSED
            else PlanStepStatus.FAILED
        )
        verified = replace(step, status=status, verification=outcome)
        terminal_status = (
            PlanStatus.FAILED
            if status is PlanStepStatus.FAILED
            else PlanStatus.EXECUTING
        )
        failure_reason = (
            f"Verification failed for {step.step_id}."
            if status is PlanStepStatus.FAILED
            else None
        )
        return self.store.save(
            replace(
                plan,
                status=terminal_status,
                failure_reason=failure_reason,
                steps=_replace_step(plan.steps, verified),
            )
        )

    def _fail_uncertain(self, plan: PlanRecord, step: PlanStep) -> PlanRecord:
        failed = replace(step, status=PlanStepStatus.FAILED)
        return self.store.save(
            replace(
                plan,
                status=PlanStatus.FAILED,
                failure_reason=(
                    f"Execution outcome is uncertain for {step.step_id}; "
                    "the consumed approval was not replayed."
                ),
                steps=_replace_step(plan.steps, failed),
            )
        )


def _parse_specification(
    specification: dict[str, object],
) -> tuple[str, tuple[PlanStep, ...]]:
    _exact_keys(
        specification,
        {"schemaVersion", "steps", "title"},
        "plan specification",
        optional={"schemaVersion"},
    )
    if specification.get("schemaVersion", _PLAN_SCHEMA_VERSION) != _PLAN_SCHEMA_VERSION:
        raise ConfigurationError("Unsupported plan specification schema version.")
    title = _bounded_title(_string(specification, "title", "plan specification"))
    values = specification["steps"]
    if not isinstance(values, list) or not 1 <= len(values) <= _MAX_STEPS:
        raise ConfigurationError("Plan steps must contain between 1 and 64 entries.")
    steps: list[PlanStep] = []
    for order, raw in enumerate(values, 1):
        item = _object(raw, "plan specification step")
        _exact_keys(
            item,
            {"dependsOn", "stepId", "title", "toolCall", "verify"},
            "plan specification step",
            optional={"dependsOn", "verify"},
        )
        dependencies = item.get("dependsOn", [])
        if not isinstance(dependencies, list) or any(
            not isinstance(entry, str) for entry in dependencies
        ):
            raise ConfigurationError("Plan step dependsOn must be a string array.")
        call = _tool_call(item["toolCall"])
        steps.append(
            PlanStep(
                step_id=_validated_identifier(
                    _string(item, "stepId", "plan specification step"), "stepId"
                ),
                order=order,
                title=_bounded_title(
                    _string(item, "title", "plan specification step")
                ),
                depends_on=tuple(dependencies),
                tool_call=call,
                tool_call_sha256=_tool_call_sha256(call),
                verification_spec=VerificationSpec.from_json(item.get("verify")),
            )
        )
    result = tuple(steps)
    _validate_steps(result)
    serialized = stable_json(
        {"steps": [_step_spec_json(step) for step in result], "title": title}
    )
    if len(serialized.encode("utf-8")) > _MAX_PLAN_BYTES:
        raise ConfigurationError(f"Plan specification exceeds {_MAX_PLAN_BYTES} bytes.")
    return title, result


def _validate_steps(steps: tuple[PlanStep, ...]) -> None:
    if not 1 <= len(steps) <= _MAX_STEPS:
        raise ConfigurationError("Plan must contain between 1 and 64 steps.")
    identifiers = [step.step_id for step in steps]
    call_ids = [step.tool_call.call_id for step in steps]
    if len(identifiers) != len(set(identifiers)):
        raise ConfigurationError("Plan step identifiers must be unique.")
    if len(call_ids) != len(set(call_ids)):
        raise ConfigurationError("Plan tool call identifiers must be unique.")
    seen: set[str] = set()
    for expected_order, step in enumerate(steps, 1):
        if step.order != expected_order:
            raise ConfigurationError("Plan step order must be contiguous and start at one.")
        if len(step.depends_on) != len(set(step.depends_on)):
            raise ConfigurationError("Plan step dependencies must be unique.")
        if any(dependency not in seen for dependency in step.depends_on):
            raise ConfigurationError(
                f"Step {step.step_id} may depend only on earlier ordered steps."
            )
        seen.add(step.step_id)


def _spec_sha256(title: str, steps: tuple[PlanStep, ...]) -> str:
    return sha256_text(
        stable_json(
            {"steps": [_step_spec_json(step) for step in steps], "title": title}
        )
    )


def _step_spec_json(step: PlanStep) -> dict[str, object]:
    return {
        "dependsOn": list(step.depends_on),
        "order": step.order,
        "stepId": step.step_id,
        "title": step.title,
        "toolCall": _tool_call_json(step.tool_call),
        "toolCallSha256": step.tool_call_sha256,
        "verificationSpec": step.verification_spec.as_json(),
    }


def _tool_call(value: object) -> ToolCall:
    item = _object(value, "tool call")
    _exact_keys(item, {"arguments", "callId", "name"}, "tool call")
    name = _string(item, "name", "tool call")
    if name not in _SUPPORTED_TOOLS:
        raise ConfigurationError(f"Unsupported plan tool: {name}")
    arguments = item["arguments"]
    if not isinstance(arguments, dict) or any(
        not isinstance(key, str) for key in arguments
    ):
        raise ConfigurationError("Tool-call arguments must be a JSON object.")
    try:
        encoded = stable_json(arguments)
    except (TypeError, ValueError) as error:
        raise ConfigurationError("Tool-call arguments must be finite JSON values.") from error
    if len(encoded.encode("utf-8")) > 65_536:
        raise ConfigurationError("Tool-call arguments exceed 65536 UTF-8 bytes.")
    return ToolCall(
        _validated_identifier(_string(item, "callId", "tool call"), "callId"),
        name,
        cast(dict[str, object], arguments),
    )


def _tool_call_json(call: ToolCall) -> dict[str, object]:
    return {"arguments": call.arguments, "callId": call.call_id, "name": call.name}


def _tool_call_sha256(call: ToolCall) -> str:
    return sha256_text(stable_json(_tool_call_json(call)))


def _execution_key(plan: PlanRecord, step: PlanStep) -> str:
    assert step.approval is not None
    return sha256_text(
        stable_json(
            {
                "approvalReference": step.approval.reference_id,
                "planId": plan.plan_id,
                "stepId": step.step_id,
                "toolCallSha256": step.tool_call_sha256,
            }
        )
    ).removeprefix("sha256:")


def _first_incomplete(steps: tuple[PlanStep, ...]) -> PlanStep | None:
    return next(
        (step for step in steps if step.status is not PlanStepStatus.SUCCEEDED),
        None,
    )


def _dependencies_succeeded(
    step: PlanStep, steps: tuple[PlanStep, ...]
) -> bool:
    status = {item.step_id: item.status for item in steps}
    return all(status.get(dependency) is PlanStepStatus.SUCCEEDED for dependency in step.depends_on)


def _replace_step(steps: tuple[PlanStep, ...], updated: PlanStep) -> tuple[PlanStep, ...]:
    return tuple(updated if item.step_id == updated.step_id else item for item in steps)


def _digest(value: str) -> str:
    normalized = value if value.startswith("sha256:") else f"sha256:{value}"
    if not _SHA256.fullmatch(normalized):
        raise ConfigurationError("Expected a lowercase SHA-256 digest.")
    return normalized


def _validated_identifier(value: str, label: str) -> str:
    return validate_identifier(value, label)


def _bounded_title(value: str) -> str:
    if not value.strip() or len(value.encode("utf-8")) > _MAX_TITLE_BYTES:
        raise ConfigurationError(f"Titles must contain 1-{_MAX_TITLE_BYTES} UTF-8 bytes.")
    return value.strip()


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ConfigurationError(f"{label} must be a JSON object.")
    return cast(dict[str, object], value)


def _exact_keys(
    value: dict[str, object],
    allowed: set[str],
    label: str,
    *,
    optional: set[str] | frozenset[str] = frozenset(),
) -> None:
    unknown = set(value) - allowed
    missing = allowed - optional - set(value)
    if unknown:
        raise ConfigurationError(f"{label} has unknown fields: {', '.join(sorted(unknown))}.")
    if missing:
        raise ConfigurationError(f"{label} is missing fields: {', '.join(sorted(missing))}.")


def _string(
    value: dict[str, object],
    key: str,
    label: str,
    *,
    allow_empty: bool = False,
) -> str:
    result = value.get(key)
    if not isinstance(result, str) or (not allow_empty and not result):
        raise ConfigurationError(f"{label}.{key} must be a string.")
    return result


def _optional_string(value: dict[str, object], key: str, default: str) -> str:
    result = value.get(key, default)
    if not isinstance(result, str):
        raise ConfigurationError(f"{key} must be a string.")
    return result
