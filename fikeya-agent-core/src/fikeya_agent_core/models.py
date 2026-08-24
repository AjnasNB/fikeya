# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Typed, provider-neutral orchestration contracts."""

from __future__ import annotations

import enum
import hashlib
import json
import re
import time
from dataclasses import dataclass, field

from .errors import ConfigurationError, ProtocolError

JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def canonical_json(value: object) -> bytes:
    """Return one deterministic UTF-8 JSON representation."""

    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def strict_json_loads(value: str | bytes) -> object:
    """Decode standards-compliant JSON while rejecting NaN and infinities."""

    return json.loads(value, parse_constant=_reject_json_constant)


def sha256_value(value: object) -> str:
    """Hash a deterministic JSON representation without retaining it."""

    return hashlib.sha256(canonical_json(value)).hexdigest()


class Stage(str, enum.Enum):
    """Durable stage names in the native orchestration state machine."""

    PLAN = "plan"
    ACT = "act"
    AWAITING_APPROVAL = "awaiting_approval"
    OBSERVE = "observe"
    REVIEW = "review"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class DecisionKind(str, enum.Enum):
    """Provider decisions accepted by a particular orchestration stage."""

    PLAN = "plan"
    TOOL_CALL = "tool_call"
    ANSWER = "answer"
    REVIEW = "review"


class ReviewAction(str, enum.Enum):
    """Review outcomes produced after an answer or observation."""

    COMPLETE = "complete"
    CONTINUE = "continue"


class ApprovalDecision(str, enum.Enum):
    """Explicit person or policy decision for one pending tool call."""

    ALLOW_ONCE = "allow_once"
    DENY_ONCE = "deny_once"
    CANCEL = "cancel"


class EventKind(str, enum.Enum):
    """Typed events emitted by the orchestration stream."""

    SESSION_STARTED = "session.started"
    SESSION_RESUMED = "session.resumed"
    CONTEXT_ATTACHED = "context.attached"
    STAGE_ENTERED = "stage.entered"
    PLAN_CREATED = "plan.created"
    TOOL_PROPOSED = "tool.proposed"
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_RESOLVED = "approval.resolved"
    TOOL_EXECUTION_CLAIMED = "tool.execution_claimed"
    TOOL_COMPLETED = "tool.completed"
    ANSWER_PROPOSED = "answer.proposed"
    REVIEW_COMPLETED = "review.completed"
    RETRY_SCHEDULED = "retry.scheduled"
    SESSION_COMPLETED = "session.completed"
    SESSION_CANCELLED = "session.cancelled"
    SESSION_FAILED = "session.failed"


@dataclass(frozen=True, slots=True)
class AgentLimits:
    """Hard ceilings applied before model and broker operations."""

    max_steps: int = 32
    max_retries: int = 2
    max_context_bytes: int = 65_536
    max_output_bytes: int = 262_144
    max_tool_arguments_bytes: int = 65_536
    max_tool_result_bytes: int = 262_144
    max_tools: int = 128
    max_events: int = 2_048
    provider_timeout_seconds: float = 120.0
    broker_timeout_seconds: float = 120.0

    def __post_init__(self) -> None:
        checks = (
            (1 <= self.max_steps <= 256, "max_steps must be between 1 and 256"),
            (0 <= self.max_retries <= 10, "max_retries must be between 0 and 10"),
            (1_024 <= self.max_context_bytes <= 4_194_304, "max_context_bytes is outside the safe range"),
            (256 <= self.max_output_bytes <= 4_194_304, "max_output_bytes is outside the safe range"),
            (
                256 <= self.max_tool_arguments_bytes <= 1_048_576,
                "max_tool_arguments_bytes is outside the safe range",
            ),
            (
                256 <= self.max_tool_result_bytes <= 4_194_304,
                "max_tool_result_bytes is outside the safe range",
            ),
            (1 <= self.max_tools <= 1_024, "max_tools must be between 1 and 1024"),
            (16 <= self.max_events <= 16_384, "max_events must be between 16 and 16384"),
            (0.1 <= self.provider_timeout_seconds <= 600, "provider_timeout_seconds is outside the safe range"),
            (0.1 <= self.broker_timeout_seconds <= 600, "broker_timeout_seconds is outside the safe range"),
        )
        for valid, message in checks:
            if not valid:
                raise ConfigurationError(message)


@dataclass(frozen=True, slots=True)
class EvidenceCitation:
    """A cited Qarinah event or evidence record referenced by a context pack."""

    citation_id: str
    sha256: str
    source: str

    def __post_init__(self) -> None:
        if not _IDENTIFIER.fullmatch(self.citation_id):
            raise ConfigurationError("citation_id is invalid")
        if not _SHA256.fullmatch(self.sha256):
            raise ConfigurationError("citation sha256 must be 64 lowercase hexadecimal characters")
        if not self.source or len(self.source.encode("utf-8")) > 1_024:
            raise ConfigurationError("citation source must be 1-1024 UTF-8 bytes")


@dataclass(frozen=True, slots=True)
class EvidenceContext:
    """Ephemeral Qarinah content plus durable evidence identities."""

    content: str
    citations: tuple[EvidenceCitation, ...]
    content_sha256: str

    def __post_init__(self) -> None:
        actual = hashlib.sha256(self.content.encode("utf-8")).hexdigest()
        if not self.content or self.content_sha256 != actual:
            raise ConfigurationError("evidence content_sha256 does not match its UTF-8 content")
        if len({item.citation_id for item in self.citations}) != len(self.citations):
            raise ConfigurationError("evidence citations must have unique identifiers")

    @classmethod
    def from_content(cls, content: str, citations: tuple[EvidenceCitation, ...]) -> EvidenceContext:
        """Create a pack while deriving its exact content digest."""

        return cls(content, citations, hashlib.sha256(content.encode("utf-8")).hexdigest())


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    """A broker-owned tool description exposed to the provider."""

    name: str
    description: str
    input_schema: dict[str, JsonValue]

    def __post_init__(self) -> None:
        if not _IDENTIFIER.fullmatch(self.name):
            raise ConfigurationError("tool name is invalid")
        if not self.description or len(self.description.encode("utf-8")) > 4_096:
            raise ConfigurationError("tool description must be 1-4096 UTF-8 bytes")
        try:
            canonical_json(self.input_schema)
        except (TypeError, ValueError) as error:
            raise ConfigurationError("tool input schema must be JSON serializable") from error


@dataclass(frozen=True, slots=True)
class ToolCall:
    """One provider-proposed operation that can only run through a broker."""

    call_id: str
    name: str
    arguments: dict[str, JsonValue]

    def __post_init__(self) -> None:
        if not _IDENTIFIER.fullmatch(self.call_id) or not _IDENTIFIER.fullmatch(self.name):
            raise ProtocolError("tool call identifier or name is invalid")
        try:
            canonical_json(self.arguments)
        except (TypeError, ValueError) as error:
            raise ProtocolError("tool arguments must be JSON serializable") from error


@dataclass(frozen=True, slots=True)
class ToolResult:
    """Bounded broker result returned to the review stage."""

    call_id: str
    status: str
    output: str
    content_type: str = "text/plain"

    def __post_init__(self) -> None:
        if not _IDENTIFIER.fullmatch(self.call_id):
            raise ProtocolError("tool result call_id is invalid")
        if self.status not in {"ok", "denied", "error"}:
            raise ProtocolError("tool result status is invalid")
        if not self.content_type or len(self.content_type) > 128:
            raise ProtocolError("tool result content_type is invalid")


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    """One explicit approval boundary persisted before broker execution."""

    request_id: str
    session_id: str
    call_id: str
    tool_name: str
    arguments_sha256: str
    expected_revision: int
    summary: str

    def __post_init__(self) -> None:
        identifiers = (self.request_id, self.session_id, self.call_id)
        if any(not _IDENTIFIER.fullmatch(item) for item in identifiers):
            raise ConfigurationError("approval request, session, or call identifier is invalid")
        if not _IDENTIFIER.fullmatch(self.tool_name) or not _SHA256.fullmatch(self.arguments_sha256):
            raise ConfigurationError("approval tool name or argument digest is invalid")
        if not self.summary or len(self.summary.encode("utf-8")) > 4_096:
            raise ConfigurationError("approval summary must be 1-4096 UTF-8 bytes")
        if self.expected_revision < 0:
            raise ConfigurationError("approval expected_revision cannot be negative")


@dataclass(frozen=True, slots=True)
class ApprovalResponse:
    """A UI decision bound to one exact checkpointed approval request."""

    request_id: str
    session_id: str
    call_id: str
    tool_name: str
    arguments_sha256: str
    expected_revision: int
    decision: ApprovalDecision

    def __post_init__(self) -> None:
        identifiers = (self.request_id, self.session_id, self.call_id)
        if any(not _IDENTIFIER.fullmatch(item) for item in identifiers):
            raise ConfigurationError("approval response identifiers are invalid")
        if not _IDENTIFIER.fullmatch(self.tool_name):
            raise ConfigurationError("approval response tool name is invalid")
        if not _SHA256.fullmatch(self.arguments_sha256) or self.expected_revision < 0:
            raise ConfigurationError("approval response digest or revision is invalid")


@dataclass(frozen=True, slots=True)
class ApprovalGrant:
    """Durable one-call grant required by the observe stage."""

    request_id: str
    session_id: str
    call_id: str
    tool_name: str
    arguments_sha256: str
    idempotency_key: str

    def __post_init__(self) -> None:
        identifiers = (self.request_id, self.session_id, self.call_id)
        if any(not _IDENTIFIER.fullmatch(item) for item in identifiers):
            raise ConfigurationError("approval grant identifiers are invalid")
        if not _IDENTIFIER.fullmatch(self.tool_name):
            raise ConfigurationError("approval grant tool name is invalid")
        if not _SHA256.fullmatch(self.arguments_sha256) or not _SHA256.fullmatch(self.idempotency_key):
            raise ConfigurationError("approval grant digests are invalid")


@dataclass(frozen=True, slots=True)
class ProviderDecision:
    """Structured decision returned by a model-provider adapter."""

    kind: DecisionKind
    content: str = ""
    tool_call: ToolCall | None = None
    review_action: ReviewAction | None = None

    def __post_init__(self) -> None:
        if self.kind == DecisionKind.TOOL_CALL and self.tool_call is None:
            raise ProtocolError("tool_call decisions require a tool call")
        if self.kind != DecisionKind.TOOL_CALL and self.tool_call is not None:
            raise ProtocolError("only tool_call decisions may include a tool call")
        if self.kind == DecisionKind.REVIEW and self.review_action is None:
            raise ProtocolError("review decisions require a review action")
        if self.kind != DecisionKind.REVIEW and self.review_action is not None:
            raise ProtocolError("only review decisions may include a review action")


@dataclass(frozen=True, slots=True)
class ProviderUsage:
    """Exact provider-reported counts, or unavailable values."""

    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_input_tokens: int | None = None

    def __post_init__(self) -> None:
        values = (self.input_tokens, self.output_tokens, self.cached_input_tokens)
        if any(
            value is not None
            and (isinstance(value, bool) or not isinstance(value, int) or value < 0)
            for value in values
        ):
            raise ProtocolError("provider usage counts must be non-negative integers or unavailable")


@dataclass(frozen=True, slots=True)
class ProviderResult:
    """A provider decision and content-free usage metadata."""

    decision: ProviderDecision
    provider_name: str = "unknown"
    model_name: str = "unknown"
    usage: ProviderUsage = field(default_factory=ProviderUsage)


@dataclass(frozen=True, slots=True)
class ProviderRequest:
    """A bounded stage request owned by the active provider adapter."""

    session_id: str
    stage: Stage
    prompt: str
    system: str
    plan: str
    observations: tuple[ToolResult, ...]
    review_notes: str
    candidate_answer: str
    tools: tuple[ToolDefinition, ...]
    max_output_bytes: int


@dataclass(slots=True)
class SessionState:
    """JSON-checkpointable state for one agent session."""

    session_id: str
    prompt: str
    stage: Stage = Stage.PLAN
    plan: str = ""
    observations: list[ToolResult] = field(default_factory=list)
    review_notes: str = ""
    candidate_answer: str = ""
    final_output: str | None = None
    pending_call: ToolCall | None = None
    pending_approval: ApprovalRequest | None = None
    approval_grant: ApprovalGrant | None = None
    evidence: EvidenceContext | None = None
    events: list[AgentEvent] = field(default_factory=list)
    execution_lease_id: str | None = None
    execution_lease_expires_at_ms: int | None = None
    step_count: int = 0
    event_sequence: int = 0
    revision: int = 0
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1_000))
    updated_at_ms: int = field(default_factory=lambda: int(time.time() * 1_000))
    failure_code: str | None = None

    def __post_init__(self) -> None:
        if not _IDENTIFIER.fullmatch(self.session_id):
            raise ConfigurationError("session identifier is invalid")
        if not self.prompt:
            raise ConfigurationError("session prompt cannot be empty")

    @property
    def terminal(self) -> bool:
        """Return whether no further execution is permitted."""

        return self.stage in {Stage.COMPLETED, Stage.CANCELLED, Stage.FAILED}


@dataclass(frozen=True, slots=True)
class AgentEvent:
    """Typed event yielded as the state machine advances."""

    session_id: str
    sequence: int
    kind: EventKind
    stage: Stage
    data: dict[str, JsonValue]
    created_at_ms: int


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"non-standard JSON numeric constant is forbidden: {value}")
