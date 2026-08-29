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


def test_workspace_statistics_count_unmeasured_calls_without_estimating_tokens(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    measured = store.create_session(session_id="ses_measured")
    unmeasured = store.create_session(session_id="ses_unmeasured")
    store.record_provider_call(
        measured.session_id,
        provider_name="azure",
        model_name="gpt-test",
        api_mode="responses",
        request_sha256="sha256:request-one",
        response_sha256="sha256:response-one",
        request_bytes=120,
        response_bytes=80,
        status_code=200,
        duration_ms=42,
        usage_measurement="provider-reported",
        input_tokens=30,
        output_tokens=10,
        cached_input_tokens=4,
    )
    store.record_provider_call(
        unmeasured.session_id,
        provider_name="local",
        model_name="offline-test",
        api_mode="chat-completions",
        request_sha256="sha256:request-two",
        response_sha256="sha256:response-two",
        request_bytes=90,
        response_bytes=50,
        status_code=200,
        duration_ms=25,
        usage_measurement="unavailable",
        input_tokens=None,
        output_tokens=None,
        cached_input_tokens=None,
    )
    store.record_context_receipt(
        measured.session_id,
        adapter="qarinah-cli",
        request_sha256="sha256:context-request",
        response_sha256="sha256:context-response",
        response_bytes=256,
        coverage="direct",
        evidence_count=2,
        exit_code=0,
        duration_ms=15,
    )

    statistics = store.workspace_statistics()

    assert statistics == {
        "sessions": 2,
        "providerCalls": 2,
        "measuredProviderCalls": 1,
        "inputTokens": 30,
        "cachedInputTokens": 4,
        "outputTokens": 10,
        "qarinahContextReceipts": 1,
        "lastActivity": statistics["lastActivity"],
        "breakdown": [
            {
                "provider": "azure",
                "model": "gpt-test",
                "calls": 1,
                "measuredCalls": 1,
                "inputTokens": 30,
                "cachedInputTokens": 4,
                "outputTokens": 10,
                "lastActivity": statistics["breakdown"][0]["lastActivity"],
            },
            {
                "provider": "local",
                "model": "offline-test",
                "calls": 1,
                "measuredCalls": 0,
                "inputTokens": 0,
                "cachedInputTokens": 0,
                "outputTokens": 0,
                "lastActivity": statistics["breakdown"][1]["lastActivity"],
            },
        ],
    }


@pytest.mark.parametrize("legacy_version", (2, 3))
def test_provider_call_receipt_is_content_free_and_migrates_schema(
    tmp_path: Path,
    legacy_version: int,
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

    # Recreate the exact provider receipt constraint shared by schemas v2 and v3.
    # Version 2 predates tool_enablements, so remove it to exercise a direct v2 fixture.
    with store._connect() as connection:
        schema = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_call_receipts'"
        ).fetchone()[0]
        legacy_schema = schema.replace(", 'native'", "")
        connection.execute(
            "ALTER TABLE provider_call_receipts RENAME TO provider_call_receipts_v4_fixture"
        )
        connection.execute(legacy_schema)
        connection.execute(
            "INSERT INTO provider_call_receipts SELECT * FROM provider_call_receipts_v4_fixture"
        )
        connection.execute("DROP TABLE provider_call_receipts_v4_fixture")
        if legacy_version == 2:
            connection.execute("DROP TABLE tool_enablements")
        connection.execute(f"PRAGMA user_version = {legacy_version}")

    store.initialize()

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
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 6
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tool_enablements'"
            ).fetchone()[0]
            == 1
        )

    native_call_id = store.record_provider_call(
        session.session_id,
        provider_name="anthropic",
        model_name="claude",
        api_mode="native",
        request_sha256="sha256:native-request",
        response_sha256="sha256:native-response",
        request_bytes=100,
        response_bytes=70,
        status_code=200,
        duration_ms=30,
        usage_measurement="unavailable",
        input_tokens=None,
        output_tokens=None,
        cached_input_tokens=None,
    )
    assert (
        store.provider_call_receipts(session.session_id)[1]["callId"] == native_call_id
    )
