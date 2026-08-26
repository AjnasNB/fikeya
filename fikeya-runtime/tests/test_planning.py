# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from fikeya_runtime.agent import AgentRunner
from fikeya_runtime.credentials import CredentialResolver
from fikeya_runtime.inference import CancellationToken, JsonResponse, ProviderExecutor
from fikeya_runtime.planning import (
    PLAN_PROPOSAL_PROTOCOL,
    PlanProposalError,
    PlanProposalRunner,
    decode_plan_proposal,
)
from fikeya_runtime.plans import PlanStatus
from fikeya_runtime.providers import ProviderKind, ProviderStore, build_profile
from fikeya_runtime.workspace import initialize_workspace


class MemorySecrets:
    def set(self, account: str, secret: str) -> str:
        raise AssertionError("local provider must not write a secret")

    def get(self, reference: str) -> str:
        raise AssertionError("local provider must not read a secret")

    def delete(self, reference: str) -> None:
        raise AssertionError("local provider must not delete a secret")


class PlanningTransport:
    def __init__(self, output: str) -> None:
        self.output = output
        self.calls = 0
        self.payloads: list[bytes] = []

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
        self.payloads.append(payload)
        body = {
            "choices": [{"message": {"content": self.output}}],
            "usage": {
                "completion_tokens": 37,
                "prompt_tokens": 81,
                "prompt_tokens_details": {"cached_tokens": 11},
            },
        }
        raw = json.dumps(body, separators=(",", ":")).encode()
        return JsonResponse(200, body, raw)


def _specification() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "title": "Inspect the authorized workspace",
        "steps": [
            {
                "stepId": "inspect-workspace",
                "title": "List project files",
                "dependsOn": [],
                "toolCall": {
                    "callId": "inspect:workspace",
                    "name": "workspace.list_files",
                    "arguments": {"path": "."},
                },
                "verify": {"expectedStatus": "ok"},
            }
        ],
    }


def _envelope(specification: dict[str, object] | None = None) -> str:
    return json.dumps(
        {
            "protocol": PLAN_PROPOSAL_PROTOCOL,
            "plan": specification or _specification(),
        },
        separators=(",", ":"),
    )


def _runner(
    tmp_path: Path, output: str
) -> tuple[PlanProposalRunner, PlanningTransport]:
    root = tmp_path / "workspace"
    home = tmp_path / "home"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    providers = ProviderStore(home, MemorySecrets())
    providers.configure(
        build_profile(name="local", kind=ProviderKind.OLLAMA, model="qwen"),
        None,
    )
    transport = PlanningTransport(output)
    agent = AgentRunner(
        workspace,
        providers,
        executor=ProviderExecutor(transport),
        credentials=CredentialResolver(providers),
    )
    return PlanProposalRunner(agent), transport


def test_planning_call_persists_only_a_strict_draft_and_receipts(
    tmp_path: Path,
) -> None:
    runner, transport = _runner(tmp_path, _envelope())

    # The planning-only turn may persist metadata, but it cannot mutate project files.
    sentinel = runner.agent.workspace.root / "sentinel.txt"
    sentinel.write_text("unchanged", encoding="utf-8")

    result = runner.propose(
        provider_name="local",
        prompt="private request to inspect this repository",
        allow_network=True,
        timeout=10,
        max_output_tokens=1_024,
        cancellation=CancellationToken(),
        memory_mode="off",
    )

    assert result.plan.status is PlanStatus.DRAFT
    assert sentinel.read_text(encoding="utf-8") == "unchanged"
    assert sorted(path.name for path in runner.agent.workspace.root.iterdir()) == [
        ".fikeya",
        "sentinel.txt",
    ]
    assert result.plan.steps[0].tool_call.name == "workspace.list_files"
    assert result.agent.provider_call.usage.input_tokens == 81
    assert transport.calls == 1
    request = json.loads(transport.payloads[0])
    assert request["messages"][0]["role"] == "system"
    assert PLAN_PROPOSAL_PROTOCOL in request["messages"][0]["content"]
    assert request["messages"][1] == {
        "content": "private request to inspect this repository",
        "role": "user",
    }
    assert runner.agent.state.get_session(result.agent.session_id).status == "completed"
    assert runner.agent.state.usage_totals(result.agent.session_id) == {
        "cachedInputTokens": 11,
        "costMicroUsd": None,
        "inputTokens": 81,
        "outputTokens": 37,
    }
    persisted = b"".join(
        path.read_bytes()
        for path in runner.agent.workspace.metadata_directory.glob("state.sqlite3*")
    )
    assert b"private request to inspect this repository" not in persisted
    assert PLAN_PROPOSAL_PROTOCOL.encode() not in persisted


def test_planning_call_rejects_narrative_without_persisting_a_plan(
    tmp_path: Path,
) -> None:
    runner, transport = _runner(tmp_path, "First, I would inspect the repository.")

    with pytest.raises(PlanProposalError, match="no plan was created"):
        runner.propose(
            provider_name="local",
            prompt="build a release",
            allow_network=True,
            timeout=10,
            max_output_tokens=1_024,
            cancellation=CancellationToken(),
            memory_mode="off",
        )

    assert transport.calls == 1
    with sqlite3.connect(runner.agent.workspace.state_path) as connection:
        session = connection.execute(
            "SELECT session_id, status FROM sessions"
        ).fetchone()
        plan_count = connection.execute(
            "SELECT COUNT(*) FROM execution_plans"
        ).fetchone()
    assert session is not None and session[1] == "cancelled"
    assert plan_count is not None and plan_count[0] == 0
    assert len(runner.agent.state.provider_call_receipts(session[0])) == 1


@pytest.mark.parametrize(
    "output",
    [
        "```json\n{}\n```",
        json.dumps({"protocol": PLAN_PROPOSAL_PROTOCOL}),
        json.dumps({"protocol": "fikeya.plan-proposal.v2", "plan": {}}),
        json.dumps(
            {
                "protocol": PLAN_PROPOSAL_PROTOCOL,
                "plan": {**_specification(), "schemaVersion": True},
            }
        ),
        json.dumps(
            {
                "protocol": PLAN_PROPOSAL_PROTOCOL,
                "plan": {
                    key: value
                    for key, value in _specification().items()
                    if key != "schemaVersion"
                },
            }
        ),
        (
            '{"protocol":"fikeya.plan-proposal.v1",'
            '"protocol":"fikeya.plan-proposal.v1","plan":{}}'
        ),
        (
            '{"protocol":"fikeya.plan-proposal.v1","plan":'
            '{"schemaVersion":1,"title":"finite only","steps":['
            '{"stepId":"inspect","title":"inspect","toolCall":'
            '{"callId":"inspect:call","name":"workspace.list_files",'
            '"arguments":{"path":NaN}}}]}}'
        ),
        json.dumps(
            {
                "protocol": PLAN_PROPOSAL_PROTOCOL,
                "plan": _specification(),
                "narrative": "also run it",
            }
        ),
    ],
)
def test_plan_proposal_envelope_is_exact_and_versioned(output: str) -> None:
    with pytest.raises(PlanProposalError, match=PLAN_PROPOSAL_PROTOCOL):
        decode_plan_proposal(output)


def test_planning_call_rejects_an_invalid_plan_schema(tmp_path: Path) -> None:
    specification = _specification()
    steps = specification["steps"]
    assert isinstance(steps, list)
    step = steps[0]
    assert isinstance(step, dict)
    tool_call = step["toolCall"]
    assert isinstance(tool_call, dict)
    tool_call["name"] = "workspace.erase_everything"
    runner, _ = _runner(tmp_path, _envelope(specification))

    with pytest.raises(PlanProposalError, match="invalid fikeya.plan-proposal.v1"):
        runner.propose(
            provider_name="local",
            prompt="delete everything",
            allow_network=True,
            timeout=10,
            max_output_tokens=1_024,
            cancellation=CancellationToken(),
            memory_mode="off",
        )

    with sqlite3.connect(runner.agent.workspace.state_path) as connection:
        count = connection.execute("SELECT COUNT(*) FROM execution_plans").fetchone()
    assert count is not None and count[0] == 0
