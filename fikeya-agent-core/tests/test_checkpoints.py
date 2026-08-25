# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from fikeya_agent_core import (
    EvidenceCitation,
    EvidenceContext,
    InMemoryCheckpointStore,
    ProtocolError,
    SessionState,
    SqliteCheckpointStore,
    Stage,
    StateConflictError,
    ToolResult,
)
from fikeya_agent_core.checkpoints import decode_state, encode_state


def populated_state() -> SessionState:
    evidence = EvidenceContext.from_content(
        "evidence payload",
        (EvidenceCitation("event:abc", "a" * 64, "qarinah:event:abc"),),
    )
    return SessionState(
        session_id="session:checkpoint",
        prompt="repair the parser",
        stage=Stage.REVIEW,
        plan="inspect and test",
        observations=[ToolResult("call:1", "ok", "three tests passed")],
        evidence=evidence,
        step_count=3,
    )


def test_in_memory_store_is_copy_safe_and_revision_checked() -> None:
    store = InMemoryCheckpointStore()
    created = store.create(populated_state())
    created.plan = "changed only in caller"

    loaded = store.load(created.session_id)
    saved = store.save(loaded, expected_revision=0)

    assert (loaded.plan, saved.revision, store.load(loaded.session_id).revision) == (
        "inspect and test",
        1,
        1,
    )
    with pytest.raises(StateConflictError, match="revision conflict"):
        store.save(loaded, expected_revision=0)


def test_sqlite_store_resumes_across_instances_without_pickle(tmp_path: Path) -> None:
    path = tmp_path / "agent-checkpoints.sqlite3"
    first = SqliteCheckpointStore(path)
    state = first.create(populated_state())
    state.review_notes = "continue after a fresh process"
    first.save(state, expected_revision=0)

    resumed = SqliteCheckpointStore(path).load(state.session_id)

    assert (
        resumed.stage,
        resumed.review_notes,
        resumed.evidence.content_sha256 if resumed.evidence else None,
        resumed.revision,
    ) == (Stage.REVIEW, "continue after a fresh process", resumed.evidence.content_sha256, 1)
    assert b"pickle" not in path.read_bytes()


def test_checkpoint_json_and_sqlite_row_revision_fail_closed_on_tampering(tmp_path: Path) -> None:
    encoded = json.loads(encode_state(populated_state()))
    encoded["unknownField"] = "ignored-by-lenient-decoders"
    with pytest.raises(ProtocolError, match="fields are not exact"):
        decode_state(json.dumps(encoded).encode())

    path = tmp_path / "revision-tamper.sqlite3"
    store = SqliteCheckpointStore(path)
    state = store.create(populated_state())
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE agent_checkpoints SET revision = ? WHERE session_id = ?",
            (state.revision + 7, state.session_id),
        )
    with pytest.raises(ProtocolError, match="revisions do not match"):
        store.load(state.session_id)
