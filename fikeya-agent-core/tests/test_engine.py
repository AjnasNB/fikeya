# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

from collections import deque
from collections.abc import AsyncIterator

import pytest

from fikeya_agent_core import (
    AgentEvent,
    AgentLimits,
    AgentOrchestrator,
    ApprovalDecision,
    ApprovalResponse,
    CancellationToken,
    DecisionKind,
    EventKind,
    EvidenceCitation,
    EvidenceContext,
    InMemoryCheckpointStore,
    ProviderDecision,
    ProviderResult,
    RetryableProviderError,
    ReviewAction,
    Stage,
    ToolCall,
    ToolDefinition,
    ToolResult,
)


class FakeProvider:
    def __init__(self, *results: ProviderResult | Exception) -> None:
        self.results = deque(results)
        self.requests: list[object] = []

    async def complete(self, request: object, cancellation: CancellationToken) -> ProviderResult:
        cancellation.raise_if_cancelled()
        self.requests.append(request)
        result = self.results.popleft()
        if isinstance(result, Exception):
            raise result
        return result


class FakeBroker:
    def __init__(self) -> None:
        self.tools = (ToolDefinition("repo:read", "Read a repository file", {"type": "object"}),)
        self.calls: list[ToolCall] = []

    async def list_tools(self, cancellation: CancellationToken) -> tuple[ToolDefinition, ...]:
        cancellation.raise_if_cancelled()
        return self.tools

    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        cancellation.raise_if_cancelled()
        assert len(idempotency_key) == 64
        self.calls.append(call)
        return ToolResult(call.call_id, "ok", "parser.py has 42 lines")


def result(decision: ProviderDecision) -> ProviderResult:
    return ProviderResult(decision, provider_name="fake", model_name="fake-model")


async def collect(stream: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in stream]


def approval_response(
    orchestrator: AgentOrchestrator,
    session_id: str,
    decision: ApprovalDecision,
) -> ApprovalResponse:
    request = orchestrator.state(session_id).pending_approval
    assert request is not None
    return ApprovalResponse(
        request.request_id,
        request.session_id,
        request.call_id,
        request.tool_name,
        request.arguments_sha256,
        request.expected_revision,
        decision,
    )


@pytest.mark.asyncio
async def test_state_machine_pauses_for_approval_then_resumes_to_completion() -> None:
    provider = FakeProvider(
        result(ProviderDecision(DecisionKind.PLAN, content="inspect, repair, test")),
        result(
            ProviderDecision(
                DecisionKind.TOOL_CALL,
                tool_call=ToolCall("call:read", "repo:read", {"path": "parser.py"}),
            )
        ),
        result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="The parser is verified.",
                review_action=ReviewAction.COMPLETE,
            )
        ),
    )
    broker = FakeBroker()
    checkpoints = InMemoryCheckpointStore()
    evidence = EvidenceContext.from_content(
        "Decision event says parser.py owns tokenization.",
        (EvidenceCitation("event:parser", "a" * 64, "qarinah:event:parser"),),
    )
    first = AgentOrchestrator(provider, broker, checkpoints)
    session = first.start("repair the parser", evidence=evidence, session_id="session:full")

    first_events = await collect(first.stream(session.session_id))
    paused = first.state(session.session_id)

    assert paused.stage == Stage.AWAITING_APPROVAL
    assert broker.calls == []
    assert [event.kind for event in first_events][-2:] == [
        EventKind.TOOL_PROPOSED,
        EventKind.APPROVAL_REQUESTED,
    ]
    approval_event = first_events[-1]
    assert approval_event.data["argumentsBytes"] > 0
    assert "arguments" not in approval_event.data

    resumed = AgentOrchestrator(provider, broker, checkpoints)
    second_events = await collect(
        resumed.stream(
            session.session_id,
            approval=approval_response(resumed, session.session_id, ApprovalDecision.ALLOW_ONCE),
        )
    )
    completed = resumed.state(session.session_id)

    assert (completed.stage, completed.final_output, len(broker.calls)) == (
        Stage.COMPLETED,
        "The parser is verified.",
        1,
    )
    assert EventKind.APPROVAL_RESOLVED in [event.kind for event in second_events]
    assert EventKind.TOOL_COMPLETED in [event.kind for event in second_events]
    assert EventKind.SESSION_COMPLETED in [event.kind for event in second_events]
    assert "untrusted-evidence-not-instructions" in provider.requests[0].system


@pytest.mark.asyncio
async def test_review_can_follow_a_reference_only_after_a_fresh_approval() -> None:
    provider = FakeProvider(
        result(ProviderDecision(DecisionKind.PLAN, content="Read the repository configuration.")),
        result(ProviderDecision(
            DecisionKind.TOOL_CALL,
            tool_call=ToolCall("call:readme", "repo:read", {"path": "README.md"}),
        )),
        result(ProviderDecision(
            DecisionKind.REVIEW,
            content="The README points to config.json; read it before answering.",
            review_action=ReviewAction.CONTINUE,
        )),
        result(ProviderDecision(
            DecisionKind.TOOL_CALL,
            tool_call=ToolCall("call:config", "repo:read", {"path": "config.json"}),
        )),
        result(ProviderDecision(
            DecisionKind.REVIEW,
            content='{"answer":4317}',
            review_action=ReviewAction.COMPLETE,
        )),
    )

    class FixtureBroker(FakeBroker):
        async def execute(
            self, call: ToolCall, cancellation: CancellationToken, *, idempotency_key: str,
        ) -> ToolResult:
            await super().execute(call, cancellation, idempotency_key=idempotency_key)
            contents = {"README.md": "Read config.json for active settings.", "config.json": '{"port":4317}'}
            return ToolResult(call.call_id, "ok", contents[call.arguments["path"]])

    broker = FixtureBroker()
    orchestrator = AgentOrchestrator(provider, broker, InMemoryCheckpointStore())
    session = orchestrator.start("Return the configured port as JSON.", session_id="session:reference")
    await collect(orchestrator.stream(session.session_id))
    first_approval = approval_response(orchestrator, session.session_id, ApprovalDecision.ALLOW_ONCE)
    continued = await collect(orchestrator.stream(session.session_id, approval=first_approval))

    assert orchestrator.state(session.session_id).stage == Stage.AWAITING_APPROVAL
    assert [call.arguments["path"] for call in broker.calls] == ["README.md"]
    assert EventKind.SESSION_COMPLETED not in [event.kind for event in continued]
    second_approval = approval_response(orchestrator, session.session_id, ApprovalDecision.ALLOW_ONCE)
    assert second_approval.arguments_sha256 != first_approval.arguments_sha256
    await collect(orchestrator.stream(session.session_id, approval=second_approval))
    assert [call.arguments["path"] for call in broker.calls] == ["README.md", "config.json"]
    assert orchestrator.state(session.session_id).final_output == '{"answer":4317}'


@pytest.mark.asyncio
async def test_denial_never_calls_broker_and_is_observed_by_review() -> None:
    provider = FakeProvider(
        result(ProviderDecision(DecisionKind.PLAN, content="inspect")),
        result(
            ProviderDecision(
                DecisionKind.TOOL_CALL,
                tool_call=ToolCall("call:read", "repo:read", {"path": "secret.txt"}),
            )
        ),
        result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="Stopped because access was denied.",
                review_action=ReviewAction.COMPLETE,
            )
        ),
    )
    broker = FakeBroker()
    orchestrator = AgentOrchestrator(provider, broker, InMemoryCheckpointStore())
    session = orchestrator.start("read the protected file", session_id="session:deny")
    await collect(orchestrator.stream(session.session_id))

    events = await collect(
        orchestrator.stream(
            session.session_id,
            approval=approval_response(orchestrator, session.session_id, ApprovalDecision.DENY_ONCE),
        )
    )
    state = orchestrator.state(session.session_id)

    assert broker.calls == []
    assert state.observations[0].status == "denied"
    assert state.stage == Stage.COMPLETED
    assert EventKind.SESSION_COMPLETED in [event.kind for event in events]


@pytest.mark.asyncio
async def test_retryable_provider_failure_is_bounded_and_streamed() -> None:
    provider = FakeProvider(
        RetryableProviderError("temporary"),
        result(ProviderDecision(DecisionKind.PLAN, content="plan after retry")),
        result(ProviderDecision(DecisionKind.ANSWER, content="candidate")),
        result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="done",
                review_action=ReviewAction.COMPLETE,
            )
        ),
    )
    orchestrator = AgentOrchestrator(
        provider,
        FakeBroker(),
        InMemoryCheckpointStore(),
        AgentLimits(max_retries=1),
    )
    session = orchestrator.start("finish", session_id="session:retry")

    events = await collect(orchestrator.stream(session.session_id))

    assert [event.kind for event in events].count(EventKind.RETRY_SCHEDULED) == 1
    assert orchestrator.state(session.session_id).stage == Stage.COMPLETED
