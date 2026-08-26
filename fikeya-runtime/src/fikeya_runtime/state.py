# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""SQLite-backed sessions, event streams, usage, and content-free receipts."""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .errors import StateError
from .events import EventEnvelope, EventType, SessionRecord, StreamPage, encode_payload
from .util import utc_now, validate_identifier

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
    parent_session_id TEXT REFERENCES sessions(session_id),
    fork_sequence INTEGER,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((parent_session_id IS NULL AND fork_sequence IS NULL)
        OR (parent_session_id IS NOT NULL AND fork_sequence IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS events (
    stream_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    causation_id TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (stream_id, sequence)
);

CREATE TABLE IF NOT EXISTS usage_records (
    usage_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    provider_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
    cost_micro_usd INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_receipts (
    receipt_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    adapter TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
    coverage TEXT,
    evidence_count INTEGER CHECK (evidence_count IS NULL OR evidence_count >= 0),
    exit_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_call_receipts (
    call_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    provider_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_mode TEXT NOT NULL CHECK (api_mode IN ('responses', 'chat-completions', 'native')),
    request_sha256 TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    request_bytes INTEGER NOT NULL CHECK (request_bytes >= 0),
    response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
    status_code INTEGER NOT NULL CHECK (status_code >= 100 AND status_code <= 599),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    usage_measurement TEXT NOT NULL
        CHECK (usage_measurement IN ('provider-reported', 'unavailable')),
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cached_input_tokens INTEGER
        CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    request_sha256 TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL,
    expires_at_epoch REAL NOT NULL,
    consumed_at TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'consumed'))
);

CREATE TABLE IF NOT EXISTS tool_enablements (
    preset_id TEXT PRIMARY KEY,
    preset_sha256 TEXT NOT NULL,
    enabled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_plans (
    plan_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN (
        'draft', 'reviewed', 'awaiting_approval', 'executing', 'verifying',
        'succeeded', 'failed', 'cancelled'
    )),
    document_json TEXT NOT NULL,
    document_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS usage_by_session ON usage_records(session_id, created_at);
CREATE INDEX IF NOT EXISTS receipts_by_session ON context_receipts(session_id, created_at);
CREATE INDEX IF NOT EXISTS provider_calls_by_session
    ON provider_call_receipts(session_id, created_at);
CREATE INDEX IF NOT EXISTS execution_plans_by_updated_at
    ON execution_plans(updated_at);
PRAGMA user_version = 5;
"""

_PROVIDER_RECEIPT_V4 = """
CREATE TABLE provider_call_receipts (
    call_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    provider_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_mode TEXT NOT NULL CHECK (api_mode IN ('responses', 'chat-completions', 'native')),
    request_sha256 TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    request_bytes INTEGER NOT NULL CHECK (request_bytes >= 0),
    response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
    status_code INTEGER NOT NULL CHECK (status_code >= 100 AND status_code <= 599),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    usage_measurement TEXT NOT NULL
        CHECK (usage_measurement IN ('provider-reported', 'unavailable')),
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cached_input_tokens INTEGER
        CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
    created_at TEXT NOT NULL
);
"""


class StateStore:
    """Durable local state with explicit stream and transaction boundaries."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve(strict=False)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        """Create or verify the versioned local schema."""

        with self._connect() as connection:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version not in (0, 1, 2, 3, 4, 5):
                raise StateError(f"Unsupported state schema version: {version}")
            # Schema v2 introduced provider_call_receipts with the original two-mode
            # CHECK constraint. Schema v3 added tool enablements but retained that table.
            # Both versions therefore require the same lossless table rebuild.
            if version in (2, 3):
                self._migrate_provider_receipts_v4(connection)
            connection.executescript(_SCHEMA)
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    @staticmethod
    def _migrate_provider_receipts_v4(connection: sqlite3.Connection) -> None:
        """Add Anthropic's native API mode without discarding existing receipts."""

        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "ALTER TABLE provider_call_receipts RENAME TO provider_call_receipts_v3"
            )
            connection.execute(_PROVIDER_RECEIPT_V4)
            connection.execute(
                """
                INSERT INTO provider_call_receipts
                SELECT * FROM provider_call_receipts_v3
                """
            )
            connection.execute("DROP TABLE provider_call_receipts_v3")
            connection.execute("PRAGMA user_version = 4")
            connection.commit()
        except sqlite3.Error as error:
            connection.rollback()
            raise StateError(
                "Could not migrate provider receipts to schema version 4."
            ) from error

    def create_session(
        self,
        *,
        session_id: str | None = None,
        metadata: dict[str, object] | None = None,
        parent_session_id: str | None = None,
        fork_sequence: int | None = None,
    ) -> SessionRecord:
        """Create a stream and its first typed event atomically."""

        self.initialize()
        identifier = session_id or f"ses_{uuid.uuid4().hex}"
        validate_identifier(identifier, "session_id")
        metadata_value = metadata or {}
        metadata_json, _ = encode_payload(metadata_value)
        now = utc_now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if parent_session_id is not None:
                validate_identifier(parent_session_id, "parent_session_id")
                if fork_sequence is None or fork_sequence < 1:
                    raise StateError("A fork requires a positive parent sequence.")
                parent = connection.execute(
                    "SELECT MAX(sequence) AS maximum FROM events WHERE stream_id = ?",
                    (parent_session_id,),
                ).fetchone()
                if parent is None or parent["maximum"] is None:
                    raise StateError(
                        f"Parent session does not exist: {parent_session_id}"
                    )
                if fork_sequence > int(parent["maximum"]):
                    raise StateError("Fork sequence is beyond the parent stream.")
            elif fork_sequence is not None:
                raise StateError("fork_sequence requires parent_session_id.")
            connection.execute(
                """
                INSERT INTO sessions (
                    session_id, status, parent_session_id, fork_sequence,
                    metadata_json, created_at, updated_at
                ) VALUES (?, 'active', ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    parent_session_id,
                    fork_sequence,
                    metadata_json,
                    now,
                    now,
                ),
            )
            event_type = (
                EventType.SESSION_FORKED
                if parent_session_id is not None
                else EventType.SESSION_STARTED
            )
            event_payload: dict[str, object] = (
                {"forkSequence": fork_sequence, "parentSessionId": parent_session_id}
                if parent_session_id is not None
                else {"metadata": metadata_value}
            )
            self._insert_event(connection, identifier, event_type, event_payload)
        return self.get_session(identifier)

    def fork_session(
        self,
        parent_session_id: str,
        at_sequence: int,
        *,
        metadata: dict[str, object] | None = None,
        session_id: str | None = None,
    ) -> SessionRecord:
        """Create a new stream rooted at an immutable parent position."""

        return self.create_session(
            session_id=session_id,
            metadata=metadata,
            parent_session_id=parent_session_id,
            fork_sequence=at_sequence,
        )

    def get_session(self, session_id: str) -> SessionRecord:
        """Return a session or fail with a domain error."""

        validate_identifier(session_id, "session_id")
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT session_id, status, parent_session_id, fork_sequence,
                       created_at, updated_at
                FROM sessions WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
        if row is None:
            raise StateError(f"Unknown session: {session_id}")
        return self._session_from_row(row)

    def append_event(
        self,
        session_id: str,
        event_type: EventType,
        payload: dict[str, object],
        *,
        causation_id: str | None = None,
        correlation_id: str | None = None,
    ) -> EventEnvelope:
        """Append to an active session and allocate its sequence atomically."""

        validate_identifier(session_id, "session_id")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                raise StateError(f"Unknown session: {session_id}")
            if row["status"] != "active":
                raise StateError(f"Cannot append to a {row['status']} session.")
            return self._insert_event(
                connection,
                session_id,
                event_type,
                payload,
                causation_id=causation_id,
                correlation_id=correlation_id,
            )

    def resume_session(
        self,
        session_id: str,
        *,
        after_sequence: int = 0,
        limit: int = 100,
    ) -> StreamPage:
        """Read an ordered resumable event page without changing session state."""

        if after_sequence < 0:
            raise StateError("after_sequence cannot be negative.")
        if limit < 1 or limit > 1_000:
            raise StateError("limit must be between 1 and 1000.")
        session = self.get_session(session_id)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM events
                WHERE stream_id = ? AND sequence > ?
                ORDER BY sequence ASC LIMIT ?
                """,
                (session_id, after_sequence, limit + 1),
            ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        events = tuple(self._event_from_row(row) for row in page_rows)
        next_sequence = events[-1].sequence if events else after_sequence
        return StreamPage(
            session=session,
            events=events,
            next_sequence=next_sequence,
            has_more=has_more,
        )

    def lineage_events(self, session_id: str) -> tuple[EventEnvelope, ...]:
        """Reconstruct the immutable event lineage for a forked session."""

        return self._lineage_events(session_id, maximum_local_sequence=None)

    def _lineage_events(
        self,
        session_id: str,
        maximum_local_sequence: int | None,
    ) -> tuple[EventEnvelope, ...]:
        session = self.get_session(session_id)
        inherited: tuple[EventEnvelope, ...] = ()
        if session.parent_session_id is not None and session.fork_sequence is not None:
            inherited = self._lineage_events(
                session.parent_session_id,
                maximum_local_sequence=session.fork_sequence,
            )
        page = self.resume_session(session_id, limit=1_000)
        current = list(page.events)
        while page.has_more:
            page = self.resume_session(
                session_id,
                after_sequence=page.next_sequence,
                limit=1_000,
            )
            current.extend(page.events)
        if maximum_local_sequence is not None:
            current = [
                event for event in current if event.sequence <= maximum_local_sequence
            ]
        return (*inherited, *current)

    def cancel_session(self, session_id: str, reason: str) -> EventEnvelope:
        """Cancel a session and emit the terminal event atomically."""

        return self._finish_session(
            session_id,
            "cancelled",
            EventType.SESSION_CANCELLED,
            {"reason": reason[:512]},
        )

    def complete_session(self, session_id: str, outcome: str) -> EventEnvelope:
        """Complete a session and emit the terminal event atomically."""

        return self._finish_session(
            session_id,
            "completed",
            EventType.SESSION_COMPLETED,
            {"outcome": outcome[:512]},
        )

    def record_usage(
        self,
        session_id: str,
        *,
        provider_name: str,
        model_name: str,
        input_tokens: int,
        output_tokens: int,
        cached_input_tokens: int = 0,
        cost_micro_usd: int | None = None,
    ) -> str:
        """Store exact provider-reported usage without prompts or responses."""

        for label, value in (
            ("input_tokens", input_tokens),
            ("output_tokens", output_tokens),
            ("cached_input_tokens", cached_input_tokens),
        ):
            if value < 0:
                raise StateError(f"{label} cannot be negative.")
        if cost_micro_usd is not None and cost_micro_usd < 0:
            raise StateError("cost_micro_usd cannot be negative.")
        self.get_session(session_id)
        usage_id = f"use_{uuid.uuid4().hex}"
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    usage_id,
                    session_id,
                    provider_name,
                    model_name,
                    input_tokens,
                    output_tokens,
                    cached_input_tokens,
                    cost_micro_usd,
                    utc_now(),
                ),
            )
        return usage_id

    def record_context_receipt(
        self,
        session_id: str,
        *,
        adapter: str,
        request_sha256: str,
        response_sha256: str,
        response_bytes: int,
        exit_code: int,
        duration_ms: int,
        coverage: str | None = None,
        evidence_count: int | None = None,
    ) -> str:
        """Store content-free provenance for a context retrieval."""

        self.get_session(session_id)
        if response_bytes < 0 or duration_ms < 0:
            raise StateError("Receipt sizes and durations cannot be negative.")
        if evidence_count is not None and evidence_count < 0:
            raise StateError("evidence_count cannot be negative.")
        if coverage is not None and coverage not in {
            "any",
            "none",
            "partial",
            "direct",
        }:
            raise StateError("coverage is not a recognized retrieval status.")
        receipt_id = f"ctx_{uuid.uuid4().hex}"
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO context_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    receipt_id,
                    session_id,
                    adapter,
                    request_sha256,
                    response_sha256,
                    response_bytes,
                    coverage,
                    evidence_count,
                    exit_code,
                    duration_ms,
                    utc_now(),
                ),
            )
        return receipt_id

    def record_provider_call(
        self,
        session_id: str,
        *,
        provider_name: str,
        model_name: str,
        api_mode: str,
        request_sha256: str,
        response_sha256: str,
        request_bytes: int,
        response_bytes: int,
        status_code: int,
        duration_ms: int,
        usage_measurement: str,
        input_tokens: int | None,
        output_tokens: int | None,
        cached_input_tokens: int | None,
    ) -> str:
        """Persist one content-free provider receipt and optional exact usage."""

        self.get_session(session_id)
        if api_mode not in {"responses", "chat-completions", "native"}:
            raise StateError("Provider receipt API mode is unsupported.")
        if usage_measurement not in {"provider-reported", "unavailable"}:
            raise StateError("Provider receipt usage measurement is unsupported.")
        metrics = (input_tokens, output_tokens, cached_input_tokens)
        if usage_measurement == "provider-reported" and any(
            value is None for value in metrics
        ):
            raise StateError("Provider-reported usage requires all token fields.")
        if usage_measurement == "unavailable" and any(
            value is not None for value in metrics
        ):
            raise StateError("Unavailable usage cannot contain token fields.")
        if any(value is not None and value < 0 for value in metrics):
            raise StateError("Provider receipt token values cannot be negative.")
        if request_bytes < 0 or response_bytes < 0 or duration_ms < 0:
            raise StateError("Provider receipt sizes and duration cannot be negative.")
        if not 100 <= status_code <= 599:
            raise StateError("Provider receipt status code is outside the HTTP range.")
        call_id = f"call_{uuid.uuid4().hex}"
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO provider_call_receipts VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    call_id,
                    session_id,
                    provider_name,
                    model_name,
                    api_mode,
                    request_sha256,
                    response_sha256,
                    request_bytes,
                    response_bytes,
                    status_code,
                    duration_ms,
                    usage_measurement,
                    input_tokens,
                    output_tokens,
                    cached_input_tokens,
                    utc_now(),
                ),
            )
        return call_id

    def provider_call_receipts(self, session_id: str) -> tuple[dict[str, object], ...]:
        """Return content-free receipts in deterministic creation order."""

        self.get_session(session_id)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM provider_call_receipts
                WHERE session_id = ? ORDER BY created_at, call_id
                """,
                (session_id,),
            ).fetchall()
        return tuple(
            {
                "apiMode": row["api_mode"],
                "cachedInputTokens": row["cached_input_tokens"],
                "callId": row["call_id"],
                "createdAt": row["created_at"],
                "durationMs": row["duration_ms"],
                "inputTokens": row["input_tokens"],
                "model": row["model_name"],
                "outputTokens": row["output_tokens"],
                "provider": row["provider_name"],
                "requestBytes": row["request_bytes"],
                "requestSha256": row["request_sha256"],
                "responseBytes": row["response_bytes"],
                "responseSha256": row["response_sha256"],
                "statusCode": row["status_code"],
                "usageMeasurement": row["usage_measurement"],
            }
            for row in rows
        )

    def usage_totals(self, session_id: str) -> dict[str, int | None]:
        """Aggregate provider-reported usage for one session."""

        self.get_session(session_id)
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                       CASE WHEN COUNT(cost_micro_usd) = COUNT(*)
                            THEN COALESCE(SUM(cost_micro_usd), 0) ELSE NULL END AS cost_micro_usd
                FROM usage_records WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
        assert row is not None
        return {
            "cachedInputTokens": int(row["cached_input_tokens"]),
            "costMicroUsd": (
                int(row["cost_micro_usd"])
                if row["cost_micro_usd"] is not None
                else None
            ),
            "inputTokens": int(row["input_tokens"]),
            "outputTokens": int(row["output_tokens"]),
        }

    def workspace_statistics(self) -> dict[str, object]:
        """Return local, content-free usage statistics for this workspace.

        Token totals include only calls whose provider returned exact usage. Calls
        without provider usage remain visible in the call counters and are never
        estimated from prompt or response content.
        """

        self.initialize()
        with self._connect() as connection:
            totals = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM sessions) AS sessions,
                    COUNT(*) AS provider_calls,
                    COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                      THEN 1 ELSE 0 END), 0) AS measured_calls,
                    COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                      THEN input_tokens ELSE 0 END), 0) AS input_tokens,
                    COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                      THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
                    COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                      THEN output_tokens ELSE 0 END), 0) AS output_tokens,
                    (SELECT COUNT(*) FROM context_receipts) AS context_receipts,
                    (SELECT MAX(updated_at) FROM sessions) AS last_activity
                FROM provider_call_receipts
                """
            ).fetchone()
            rows = connection.execute(
                """
                SELECT provider_name, model_name, COUNT(*) AS calls,
                       COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                         THEN 1 ELSE 0 END), 0) AS measured_calls,
                       COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                         THEN input_tokens ELSE 0 END), 0) AS input_tokens,
                       COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                         THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
                       COALESCE(SUM(CASE WHEN usage_measurement = 'provider-reported'
                                         THEN output_tokens ELSE 0 END), 0) AS output_tokens,
                       MAX(created_at) AS last_activity
                FROM provider_call_receipts
                GROUP BY provider_name, model_name
                ORDER BY calls DESC, provider_name ASC, model_name ASC
                """
            ).fetchall()
        assert totals is not None
        return {
            "sessions": int(totals["sessions"]),
            "providerCalls": int(totals["provider_calls"]),
            "measuredProviderCalls": int(totals["measured_calls"]),
            "inputTokens": int(totals["input_tokens"]),
            "cachedInputTokens": int(totals["cached_input_tokens"]),
            "outputTokens": int(totals["output_tokens"]),
            "qarinahContextReceipts": int(totals["context_receipts"]),
            "lastActivity": totals["last_activity"],
            "breakdown": [
                {
                    "provider": row["provider_name"],
                    "model": row["model_name"],
                    "calls": int(row["calls"]),
                    "measuredCalls": int(row["measured_calls"]),
                    "inputTokens": int(row["input_tokens"]),
                    "cachedInputTokens": int(row["cached_input_tokens"]),
                    "outputTokens": int(row["output_tokens"]),
                    "lastActivity": row["last_activity"],
                }
                for row in rows
            ],
        }

    def _finish_session(
        self,
        session_id: str,
        status: str,
        event_type: EventType,
        payload: dict[str, object],
    ) -> EventEnvelope:
        validate_identifier(session_id, "session_id")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                raise StateError(f"Unknown session: {session_id}")
            if row["status"] != "active":
                raise StateError(f"Session is already {row['status']}.")
            event = self._insert_event(connection, session_id, event_type, payload)
            connection.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?",
                (status, event.created_at, session_id),
            )
            return event

    @staticmethod
    def _insert_event(
        connection: sqlite3.Connection,
        session_id: str,
        event_type: EventType,
        payload: dict[str, object],
        *,
        causation_id: str | None = None,
        correlation_id: str | None = None,
    ) -> EventEnvelope:
        payload_json, payload_sha256 = encode_payload(payload)
        row = connection.execute(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE stream_id = ?",
            (session_id,),
        ).fetchone()
        assert row is not None
        event = EventEnvelope(
            stream_id=session_id,
            sequence=int(row["next"]),
            event_type=event_type,
            payload=payload,
            causation_id=causation_id,
            correlation_id=correlation_id,
            payload_sha256=payload_sha256,
        )
        connection.execute(
            """
            INSERT INTO events (
                stream_id, sequence, event_id, event_type, payload_json,
                payload_sha256, causation_id, correlation_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.stream_id,
                event.sequence,
                event.event_id,
                event.event_type.value,
                payload_json,
                event.payload_sha256,
                event.causation_id,
                event.correlation_id,
                event.created_at,
            ),
        )
        connection.execute(
            "UPDATE sessions SET updated_at = ? WHERE session_id = ?",
            (event.created_at, session_id),
        )
        return event

    @staticmethod
    def _event_from_row(row: sqlite3.Row) -> EventEnvelope:
        payload = json.loads(row["payload_json"])
        if not isinstance(payload, dict):
            raise StateError("Persisted event payload is not an object.")
        return EventEnvelope(
            stream_id=row["stream_id"],
            sequence=int(row["sequence"]),
            event_id=row["event_id"],
            event_type=EventType(row["event_type"]),
            payload=payload,
            payload_sha256=row["payload_sha256"],
            causation_id=row["causation_id"],
            correlation_id=row["correlation_id"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _session_from_row(row: sqlite3.Row) -> SessionRecord:
        return SessionRecord(
            session_id=row["session_id"],
            status=row["status"],
            parent_session_id=row["parent_session_id"],
            fork_sequence=(
                int(row["fork_sequence"]) if row["fork_sequence"] is not None else None
            ),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
