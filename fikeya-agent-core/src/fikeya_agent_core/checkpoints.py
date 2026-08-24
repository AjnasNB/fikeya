# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""JSON-only optimistic checkpoints for resumable agent sessions."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from typing import Protocol

from .errors import ConfigurationError, LimitExceededError, ProtocolError, SessionNotFoundError, StateConflictError
from .models import (
    AgentEvent,
    ApprovalGrant,
    ApprovalRequest,
    EventKind,
    EvidenceCitation,
    EvidenceContext,
    SessionState,
    Stage,
    ToolCall,
    ToolResult,
    canonical_json,
    strict_json_loads,
)

_SCHEMA_VERSION = 1
_SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_checkpoints (
    session_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state_json BLOB NOT NULL
);
"""


class CheckpointStore(Protocol):
    """Persist complete bounded state with optimistic revision checks."""

    def create(self, state: SessionState) -> SessionState: ...

    def load(self, session_id: str) -> SessionState: ...

    def save(self, state: SessionState, *, expected_revision: int) -> SessionState: ...


class InMemoryCheckpointStore:
    """Deterministic checkpoint store for tests and ephemeral sessions."""

    def __init__(self, *, max_checkpoint_bytes: int = 16_777_216) -> None:
        self._payloads: dict[str, bytes] = {}
        self._lock = threading.RLock()
        self._max_checkpoint_bytes = _validate_maximum(max_checkpoint_bytes)

    def create(self, state: SessionState) -> SessionState:
        payload = encode_state(state, self._max_checkpoint_bytes)
        with self._lock:
            if state.session_id in self._payloads:
                raise StateConflictError(f"session already exists: {state.session_id}")
            self._payloads[state.session_id] = payload
        return decode_state(payload)

    def load(self, session_id: str) -> SessionState:
        with self._lock:
            payload = self._payloads.get(session_id)
        if payload is None:
            raise SessionNotFoundError(f"session does not exist: {session_id}")
        return decode_state(payload)

    def save(self, state: SessionState, *, expected_revision: int) -> SessionState:
        with self._lock:
            current_payload = self._payloads.get(state.session_id)
            if current_payload is None:
                raise SessionNotFoundError(f"session does not exist: {state.session_id}")
            current = decode_state(current_payload)
            if current.revision != expected_revision:
                raise StateConflictError(
                    f"checkpoint revision conflict for {state.session_id}: "
                    f"expected {expected_revision}, found {current.revision}"
                )
            saved = replace(state, revision=expected_revision + 1)
            saved_payload = encode_state(saved, self._max_checkpoint_bytes)
            self._payloads[state.session_id] = saved_payload
        return decode_state(saved_payload)


class SqliteCheckpointStore:
    """Durable local checkpoints using SQLite transactions and JSON only."""

    def __init__(self, path: str | Path, *, max_checkpoint_bytes: int = 16_777_216) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._max_checkpoint_bytes = _validate_maximum(max_checkpoint_bytes)
        with self._connect() as connection:
            connection.execute(_SCHEMA)

    def create(self, state: SessionState) -> SessionState:
        payload = encode_state(state, self._max_checkpoint_bytes)
        try:
            with self._connect() as connection:
                connection.execute(
                    "INSERT INTO agent_checkpoints (session_id, revision, state_json) VALUES (?, ?, ?)",
                    (state.session_id, state.revision, payload),
                )
        except sqlite3.IntegrityError as error:
            raise StateConflictError(f"session already exists: {state.session_id}") from error
        return decode_state(payload)

    def load(self, session_id: str) -> SessionState:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT state_json FROM agent_checkpoints WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            raise SessionNotFoundError(f"session does not exist: {session_id}")
        return decode_state(bytes(row[0]))

    def save(self, state: SessionState, *, expected_revision: int) -> SessionState:
        saved = replace(state, revision=expected_revision + 1)
        payload = encode_state(saved, self._max_checkpoint_bytes)
        with self._connect() as connection:
            result = connection.execute(
                """
                UPDATE agent_checkpoints
                SET revision = ?, state_json = ?
                WHERE session_id = ? AND revision = ?
                """,
                (saved.revision, payload, state.session_id, expected_revision),
            )
            if result.rowcount != 1:
                exists = connection.execute(
                    "SELECT revision FROM agent_checkpoints WHERE session_id = ?",
                    (state.session_id,),
                ).fetchone()
                if exists is None:
                    raise SessionNotFoundError(f"session does not exist: {state.session_id}")
                raise StateConflictError(
                    f"checkpoint revision conflict for {state.session_id}: "
                    f"expected {expected_revision}, found {int(exists[0])}"
                )
        return decode_state(payload)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=5.0)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA busy_timeout = 5000")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()


def encode_state(state: SessionState, max_bytes: int = 16_777_216) -> bytes:
    """Encode one state as bounded deterministic JSON without pickle fallback."""

    payload = canonical_json(_state_to_value(state))
    if len(payload) > max_bytes:
        raise LimitExceededError("agent checkpoint exceeds the configured byte limit")
    return payload


def decode_state(payload: bytes) -> SessionState:
    """Decode and validate a versioned JSON checkpoint."""

    try:
        value = strict_json_loads(payload)
    except (UnicodeDecodeError, ValueError) as error:
        raise ProtocolError("agent checkpoint is not valid UTF-8 JSON") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != _SCHEMA_VERSION:
        raise ProtocolError("agent checkpoint has an unsupported schema version")
    try:
        evidence_value = value.get("evidence")
        evidence = _evidence_from_value(evidence_value) if evidence_value is not None else None
        pending_value = value.get("pendingCall")
        pending = _tool_call_from_value(pending_value) if pending_value is not None else None
        approval_value = value.get("pendingApproval")
        approval = _approval_from_value(approval_value) if approval_value is not None else None
        grant_value = value.get("approvalGrant")
        grant = _grant_from_value(grant_value) if grant_value is not None else None
        observations_value = value["observations"]
        if not isinstance(observations_value, list):
            raise TypeError("observations must be a list")
        events_value = value.get("events", [])
        if not isinstance(events_value, list):
            raise TypeError("events must be a list")
        return SessionState(
            session_id=_string(value, "sessionId"),
            prompt=_string(value, "prompt"),
            stage=Stage(_string(value, "stage")),
            plan=_string(value, "plan", allow_empty=True),
            observations=[_tool_result_from_value(item) for item in observations_value],
            review_notes=_string(value, "reviewNotes", allow_empty=True),
            candidate_answer=_string(value, "candidateAnswer", allow_empty=True),
            final_output=_optional_string(value, "finalOutput"),
            pending_call=pending,
            pending_approval=approval,
            approval_grant=grant,
            evidence=evidence,
            events=[_event_from_value(item) for item in events_value],
            execution_lease_id=_optional_string(value, "executionLeaseId"),
            execution_lease_expires_at_ms=_optional_integer(value, "executionLeaseExpiresAtMs"),
            step_count=_integer(value, "stepCount"),
            event_sequence=_integer(value, "eventSequence"),
            revision=_integer(value, "revision"),
            created_at_ms=_integer(value, "createdAtMs"),
            updated_at_ms=_integer(value, "updatedAtMs"),
            failure_code=_optional_string(value, "failureCode"),
        )
    except (ConfigurationError, KeyError, TypeError, ValueError, ProtocolError) as error:
        raise ProtocolError("agent checkpoint shape is invalid") from error


def clone_state(state: SessionState) -> SessionState:
    """Return a deep JSON-safe copy so stores never expose shared mutable state."""

    return decode_state(encode_state(deepcopy(state)))


def _state_to_value(state: SessionState) -> dict[str, object]:
    return {
        "schemaVersion": _SCHEMA_VERSION,
        "sessionId": state.session_id,
        "prompt": state.prompt,
        "stage": state.stage.value,
        "plan": state.plan,
        "observations": [_tool_result_to_value(item) for item in state.observations],
        "reviewNotes": state.review_notes,
        "candidateAnswer": state.candidate_answer,
        "finalOutput": state.final_output,
        "pendingCall": _tool_call_to_value(state.pending_call) if state.pending_call else None,
        "pendingApproval": _approval_to_value(state.pending_approval) if state.pending_approval else None,
        "approvalGrant": _grant_to_value(state.approval_grant) if state.approval_grant else None,
        "evidence": _evidence_to_value(state.evidence) if state.evidence else None,
        "events": [_event_to_value(item) for item in state.events],
        "executionLeaseId": state.execution_lease_id,
        "executionLeaseExpiresAtMs": state.execution_lease_expires_at_ms,
        "stepCount": state.step_count,
        "eventSequence": state.event_sequence,
        "revision": state.revision,
        "createdAtMs": state.created_at_ms,
        "updatedAtMs": state.updated_at_ms,
        "failureCode": state.failure_code,
    }


def _tool_call_to_value(call: ToolCall) -> dict[str, object]:
    return {"callId": call.call_id, "name": call.name, "arguments": call.arguments}


def _tool_call_from_value(value: object) -> ToolCall:
    if not isinstance(value, dict) or not isinstance(value.get("arguments"), dict):
        raise ProtocolError("checkpoint tool call is invalid")
    return ToolCall(_string(value, "callId"), _string(value, "name"), value["arguments"])


def _tool_result_to_value(result: ToolResult) -> dict[str, object]:
    return {
        "callId": result.call_id,
        "status": result.status,
        "output": result.output,
        "contentType": result.content_type,
    }


def _tool_result_from_value(value: object) -> ToolResult:
    if not isinstance(value, dict):
        raise ProtocolError("checkpoint tool result is invalid")
    return ToolResult(
        _string(value, "callId"),
        _string(value, "status"),
        _string(value, "output", allow_empty=True),
        _string(value, "contentType"),
    )


def _approval_to_value(request: ApprovalRequest) -> dict[str, object]:
    return {
        "requestId": request.request_id,
        "sessionId": request.session_id,
        "callId": request.call_id,
        "toolName": request.tool_name,
        "argumentsSha256": request.arguments_sha256,
        "expectedRevision": request.expected_revision,
        "summary": request.summary,
    }


def _approval_from_value(value: object) -> ApprovalRequest:
    if not isinstance(value, dict):
        raise ProtocolError("checkpoint approval is invalid")
    return ApprovalRequest(
        _string(value, "requestId"),
        _string(value, "sessionId"),
        _string(value, "callId"),
        _string(value, "toolName"),
        _string(value, "argumentsSha256"),
        _integer(value, "expectedRevision"),
        _string(value, "summary"),
    )


def _grant_to_value(grant: ApprovalGrant) -> dict[str, str]:
    return {
        "requestId": grant.request_id,
        "sessionId": grant.session_id,
        "callId": grant.call_id,
        "toolName": grant.tool_name,
        "argumentsSha256": grant.arguments_sha256,
        "idempotencyKey": grant.idempotency_key,
    }


def _grant_from_value(value: object) -> ApprovalGrant:
    if not isinstance(value, dict):
        raise ProtocolError("checkpoint approval grant is invalid")
    return ApprovalGrant(
        _string(value, "requestId"),
        _string(value, "sessionId"),
        _string(value, "callId"),
        _string(value, "toolName"),
        _string(value, "argumentsSha256"),
        _string(value, "idempotencyKey"),
    )


def _event_to_value(event: AgentEvent) -> dict[str, object]:
    return {
        "sessionId": event.session_id,
        "sequence": event.sequence,
        "kind": event.kind.value,
        "stage": event.stage.value,
        "data": event.data,
        "createdAtMs": event.created_at_ms,
    }


def _event_from_value(value: object) -> AgentEvent:
    if not isinstance(value, dict) or not isinstance(value.get("data"), dict):
        raise ProtocolError("checkpoint event is invalid")
    return AgentEvent(
        session_id=_string(value, "sessionId"),
        sequence=_integer(value, "sequence"),
        kind=EventKind(_string(value, "kind")),
        stage=Stage(_string(value, "stage")),
        data=value["data"],
        created_at_ms=_integer(value, "createdAtMs"),
    )


def _evidence_to_value(evidence: EvidenceContext) -> dict[str, object]:
    return {
        "content": evidence.content,
        "contentSha256": evidence.content_sha256,
        "citations": [
            {"citationId": item.citation_id, "sha256": item.sha256, "source": item.source}
            for item in evidence.citations
        ],
    }


def _evidence_from_value(value: object) -> EvidenceContext:
    if not isinstance(value, dict) or not isinstance(value.get("citations"), list):
        raise ProtocolError("checkpoint evidence is invalid")
    citations = tuple(
        EvidenceCitation(
            _string(item, "citationId"),
            _string(item, "sha256"),
            _string(item, "source"),
        )
        for item in value["citations"]
        if isinstance(item, dict)
    )
    if len(citations) != len(value["citations"]):
        raise ProtocolError("checkpoint evidence citations are invalid")
    return EvidenceContext(
        _string(value, "content"),
        citations,
        _string(value, "contentSha256"),
    )


def _string(value: dict[str, object], name: str, *, allow_empty: bool = False) -> str:
    item = value[name]
    if not isinstance(item, str) or (not allow_empty and not item):
        raise ProtocolError(f"checkpoint field must be a string: {name}")
    return item


def _optional_string(value: dict[str, object], name: str) -> str | None:
    item = value[name]
    if item is not None and not isinstance(item, str):
        raise ProtocolError(f"checkpoint field must be null or a string: {name}")
    return item


def _integer(value: dict[str, object], name: str) -> int:
    item = value[name]
    if isinstance(item, bool) or not isinstance(item, int) or item < 0:
        raise ProtocolError(f"checkpoint field must be a non-negative integer: {name}")
    return item


def _optional_integer(value: dict[str, object], name: str) -> int | None:
    item = value.get(name)
    if item is None:
        return None
    if isinstance(item, bool) or not isinstance(item, int) or item < 0:
        raise ProtocolError(f"checkpoint field must be null or a non-negative integer: {name}")
    return item


def _validate_maximum(value: int) -> int:
    if not 1_024 <= value <= 67_108_864:
        raise ValueError("max_checkpoint_bytes must be between 1024 and 67108864")
    return value
