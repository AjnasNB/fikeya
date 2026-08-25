# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Typed, hash-addressed event envelopes used by every runtime adapter."""

from __future__ import annotations

import enum
import re
import uuid
from dataclasses import dataclass, field

from .errors import StateError
from .util import sha256_text, stable_json, utc_now, validate_identifier

MAX_EVENT_BYTES = 1_048_576
_SENSITIVE_KEY = re.compile(
    r"(^|[_-])(api[_-]?key|password|secret|authorization|access[_-]?token|refresh[_-]?token|bearer)($|[_-])",
    re.IGNORECASE,
)


class EventType(str, enum.Enum):
    """Stable event names shared by desktop, CLI, and provider adapters."""

    SESSION_STARTED = "session.started"
    SESSION_CANCELLED = "session.cancelled"
    SESSION_COMPLETED = "session.completed"
    SESSION_FORKED = "session.forked"
    MESSAGE = "message"
    TOOL_REQUESTED = "tool.requested"
    TOOL_APPROVED = "tool.approved"
    TOOL_RESULT = "tool.result"
    PROVIDER_REQUESTED = "provider.requested"
    PROVIDER_RESULT = "provider.result"
    CONTEXT_RECEIPT = "context.receipt"


def _reject_sensitive_keys(value: object, path: str = "payload") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise StateError(f"{path} contains a non-string JSON key.")
            if _SENSITIVE_KEY.search(key):
                raise StateError(
                    f"{path}.{key} looks like credential material and cannot be stored."
                )
            _reject_sensitive_keys(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_sensitive_keys(child, f"{path}[{index}]")
    elif value is not None and not isinstance(value, (bool, int, float, str)):
        raise StateError(f"{path} is not JSON serializable.")


def encode_payload(payload: dict[str, object]) -> tuple[str, str]:
    """Validate, serialize, and hash an event payload."""

    _reject_sensitive_keys(payload)
    serialized = stable_json(payload)
    if len(serialized.encode("utf-8")) > MAX_EVENT_BYTES:
        raise StateError(f"Event payload exceeds {MAX_EVENT_BYTES} bytes.")
    return serialized, sha256_text(serialized)


@dataclass(frozen=True, slots=True)
class EventEnvelope:
    """An immutable event with per-stream ordering and integrity metadata."""

    stream_id: str
    sequence: int
    event_type: EventType
    payload: dict[str, object]
    event_id: str = field(default_factory=lambda: f"evt_{uuid.uuid4().hex}")
    created_at: str = field(default_factory=utc_now)
    causation_id: str | None = None
    correlation_id: str | None = None
    payload_sha256: str = ""

    def __post_init__(self) -> None:
        validate_identifier(self.stream_id, "stream_id")
        validate_identifier(self.event_id, "event_id")
        if self.sequence < 1:
            raise StateError("Event sequence must be positive.")
        if self.causation_id is not None:
            validate_identifier(self.causation_id, "causation_id")
        if self.correlation_id is not None:
            validate_identifier(self.correlation_id, "correlation_id")
        _, calculated = encode_payload(self.payload)
        if self.payload_sha256 and self.payload_sha256 != calculated:
            raise StateError("Event payload digest does not match its payload.")
        object.__setattr__(self, "payload_sha256", calculated)

    def as_json(self) -> dict[str, object]:
        """Return a protocol-safe JSON object."""

        return {
            "causationId": self.causation_id,
            "correlationId": self.correlation_id,
            "createdAt": self.created_at,
            "eventId": self.event_id,
            "eventType": self.event_type.value,
            "payload": self.payload,
            "payloadSha256": self.payload_sha256,
            "sequence": self.sequence,
            "streamId": self.stream_id,
        }


@dataclass(frozen=True, slots=True)
class SessionRecord:
    """A durable session and optional fork relationship."""

    session_id: str
    status: str
    created_at: str
    updated_at: str
    parent_session_id: str | None = None
    fork_sequence: int | None = None


@dataclass(frozen=True, slots=True)
class StreamPage:
    """A resumable page of stream events."""

    session: SessionRecord
    events: tuple[EventEnvelope, ...]
    next_sequence: int
    has_more: bool
