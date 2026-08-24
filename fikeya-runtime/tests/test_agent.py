# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fikeya_runtime.agent import AgentRunner
from fikeya_runtime.credentials import CredentialResolver
from fikeya_runtime.errors import CancellationError
from fikeya_runtime.inference import (
    CancellationToken,
    JsonResponse,
    ProviderExecutor,
)
from fikeya_runtime.providers import ProviderKind, ProviderStore, build_profile
from fikeya_runtime.workspace import initialize_workspace


class MemorySecrets:
    def set(self, account: str, secret: str) -> str:
        raise AssertionError("local provider must not write a secret")

    def get(self, reference: str) -> str:
        raise AssertionError("local provider must not read a secret")

    def delete(self, reference: str) -> None:
        raise AssertionError("local provider must not delete a secret")


class AnswerTransport:
    def __init__(self) -> None:
        self.calls = 0

    def post(
        self,
        url: str,
        headers: dict[str, str],
        payload: bytes,
        *,
        timeout: float,
        maximum_response_bytes: int,
        cancellation: CancellationToken,
    ) -> JsonResponse:
        self.calls += 1
        body = {
            "choices": [{"message": {"content": "private live answer"}}],
            "usage": {
                "completion_tokens": 5,
                "prompt_tokens": 14,
                "prompt_tokens_details": {"cached_tokens": 2},
            },
        }
        raw = json.dumps(body, separators=(",", ":")).encode()
        return JsonResponse(200, body, raw)


def _runner(tmp_path: Path) -> tuple[AgentRunner, AnswerTransport]:
    root = tmp_path / "workspace"
    home = tmp_path / "home"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    providers = ProviderStore(home, MemorySecrets())
    providers.configure(
        build_profile(name="local", kind=ProviderKind.OLLAMA, model="qwen"),
        None,
    )
    transport = AnswerTransport()
    runner = AgentRunner(
        workspace,
        providers,
        executor=ProviderExecutor(transport),
        credentials=CredentialResolver(providers),
    )
    return runner, transport


def test_agent_run_records_hashes_and_usage_but_not_content(tmp_path: Path) -> None:
    runner, transport = _runner(tmp_path)

    result = runner.run(
        provider_name="local",
        prompt="private project question",
        allow_network=True,
        timeout=10,
        max_output_tokens=100,
        cancellation=CancellationToken(),
    )

    assert result.output == "private live answer"
    assert transport.calls == 1
    assert runner.state.get_session(result.session_id).status == "completed"
    assert runner.state.usage_totals(result.session_id) == {
        "cachedInputTokens": 2,
        "costMicroUsd": None,
        "inputTokens": 14,
        "outputTokens": 5,
    }
    receipt = runner.state.provider_call_receipts(result.session_id)[0]
    assert receipt["callId"] == result.call_id
    assert receipt["usageMeasurement"] == "provider-reported"
    persisted = b"".join(
        path.read_bytes()
        for path in runner.workspace.metadata_directory.glob("state.sqlite3*")
    )
    assert b"private project question" not in persisted
    assert b"private live answer" not in persisted


def test_agent_cancellation_leaves_a_terminal_audit_event(tmp_path: Path) -> None:
    runner, transport = _runner(tmp_path)
    cancellation = CancellationToken()
    cancellation.cancel()

    with pytest.raises(CancellationError, match="cancelled"):
        runner.run(
            provider_name="local",
            prompt="cancel this request",
            allow_network=True,
            timeout=10,
            max_output_tokens=100,
            cancellation=cancellation,
        )

    assert transport.calls == 0
    with sqlite3.connect(runner.workspace.state_path) as connection:
        row = connection.execute("SELECT session_id, status FROM sessions").fetchone()
    assert row is not None
    assert row[1] == "cancelled"
    events = runner.state.resume_session(row[0], limit=20).events
    assert events[-1].event_type.value == "session.cancelled"
