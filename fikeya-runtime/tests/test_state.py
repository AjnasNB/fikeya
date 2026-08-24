# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

from pathlib import Path

import pytest

from fikeya_runtime.errors import StateError
from fikeya_runtime.events import EventType
from fikeya_runtime.state import StateStore


def _store(tmp_path: Path) -> StateStore:
    store = StateStore(tmp_path / "state.sqlite3")
    store.initialize()
    return store


def test_stream_resume_cancel_and_terminal_invariant(tmp_path: Path) -> None:
    store = _store(tmp_path)
    session = store.create_session(metadata={"mode": "agent"}, session_id="ses_main")
    first = store.append_event(
        session.session_id,
        EventType.MESSAGE,
        {"role": "user", "text": "inspect the repository"},
    )
    store.append_event(
        session.session_id,
        EventType.TOOL_REQUESTED,
        {"requestSha256": "sha256:abc"},
        causation_id=first.event_id,
    )

    first_page = store.resume_session(session.session_id, limit=2)
    second_page = store.resume_session(
        session.session_id,
        after_sequence=first_page.next_sequence,
        limit=2,
    )
    cancelled = store.cancel_session(session.session_id, "person cancelled")

    assert {
        "first_sequences": [event.sequence for event in first_page.events],
        "first_has_more": first_page.has_more,
        "second_sequences": [event.sequence for event in second_page.events],
        "terminal_type": cancelled.event_type,
        "status": store.get_session(session.session_id).status,
    } == {
        "first_sequences": [1, 2],
        "first_has_more": True,
        "second_sequences": [3],
        "terminal_type": EventType.SESSION_CANCELLED,
        "status": "cancelled",
    }
    with pytest.raises(StateError, match="cancelled"):
        store.append_event(session.session_id, EventType.MESSAGE, {"text": "late"})


def test_fork_lineage_keeps_inherited_and_local_positions_distinct(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    root = store.create_session(session_id="ses_root")
    store.append_event(root.session_id, EventType.MESSAGE, {"text": "root two"})
    store.append_event(root.session_id, EventType.MESSAGE, {"text": "root three"})
    child = store.fork_session(root.session_id, 2, session_id="ses_child")
    store.append_event(child.session_id, EventType.MESSAGE, {"text": "child two"})
    grandchild = store.fork_session(child.session_id, 2, session_id="ses_grandchild")

    lineage = store.lineage_events(grandchild.session_id)

    assert [(event.stream_id, event.sequence) for event in lineage] == [
        ("ses_root", 1),
        ("ses_root", 2),
        ("ses_child", 1),
        ("ses_child", 2),
        ("ses_grandchild", 1),
    ]


def test_event_payload_rejects_credential_shaped_fields(tmp_path: Path) -> None:
    store = _store(tmp_path)
    session = store.create_session()

    with pytest.raises(StateError, match="credential material"):
        store.append_event(
            session.session_id,
            EventType.MESSAGE,
            {"nested": {"api_key": "must-not-be-stored"}},
        )


def test_usage_and_context_receipts_store_only_metrics(tmp_path: Path) -> None:
    store = _store(tmp_path)
    session = store.create_session(session_id="ses_metrics")
    store.record_usage(
        session.session_id,
        provider_name="local",
        model_name="small",
        input_tokens=120,
        output_tokens=30,
        cached_input_tokens=20,
        cost_micro_usd=42,
    )
    receipt_id = store.record_context_receipt(
        session.session_id,
        adapter="qarinah-cli",
        request_sha256="sha256:request",
        response_sha256="sha256:response",
        response_bytes=512,
        coverage="direct",
        evidence_count=3,
        exit_code=0,
        duration_ms=18,
    )

    assert {
        "receipt_prefix": receipt_id.startswith("ctx_"),
        "totals": store.usage_totals(session.session_id),
    } == {
        "receipt_prefix": True,
        "totals": {
            "cachedInputTokens": 20,
            "costMicroUsd": 42,
            "inputTokens": 120,
            "outputTokens": 30,
        },
    }


def test_provider_call_receipt_is_content_free_and_migrates_schema(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path / "state.sqlite3")
    store.initialize()
    session = store.create_session(session_id="ses_provider")

    call_id = store.record_provider_call(
        session.session_id,
        provider_name="work",
        model_name="example",
        api_mode="responses",
        request_sha256="sha256:request",
        response_sha256="sha256:response",
        request_bytes=120,
        response_bytes=80,
        status_code=200,
        duration_ms=42,
        usage_measurement="provider-reported",
        input_tokens=30,
        output_tokens=10,
        cached_input_tokens=4,
    )

    receipts = store.provider_call_receipts(session.session_id)
    assert receipts == (
        {
            "apiMode": "responses",
            "cachedInputTokens": 4,
            "callId": call_id,
            "createdAt": receipts[0]["createdAt"],
            "durationMs": 42,
            "inputTokens": 30,
            "model": "example",
            "outputTokens": 10,
            "provider": "work",
            "requestBytes": 120,
            "requestSha256": "sha256:request",
            "responseBytes": 80,
            "responseSha256": "sha256:response",
            "statusCode": 200,
            "usageMeasurement": "provider-reported",
        },
    )

    with store._connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 3
