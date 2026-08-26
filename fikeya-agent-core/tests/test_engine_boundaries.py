# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
from collections import deque

import pytest

from fikeya_agent_core import (
    AgentEvent,
    AgentLimits,
    AgentNoProgressError,
    AgentOrchestrator,
    ApprovalDecision,
    ApprovalResponse,
    CancellationToken,
    DecisionKind,
    EventKind,
    InMemoryCheckpointStore,
    LimitExceededError,
    ProviderDecision,
    ProviderResult,
    RetryableProviderError,
    ReviewAction,
    Stage,
    ToolCall,
    ToolDefinition,
    ToolResult,
)


class QueueProvider:
    def __init__(self, *items: ProviderResult | Exception) -> None:
        self.items = deque(items)
        self.calls = 0

    async def complete(self, request: object, cancellation: CancellationToken) -> ProviderResult:
        del request
        cancellation.raise_if_cancelled()
        self.calls += 1
        item = self.items.popleft()
        if isinstance(item, Exception):
            raise item
        return item


class Broker:
    def __init__(self, output: str = "ok") -> None:
        self.output = output
        self.calls = 0

    async def list_tools(self, cancellation: CancellationToken) -> tuple[ToolDefinition, ...]:
        cancellation.raise_if_cancelled()
        return (ToolDefinition("repo:read", "Read repository content", {"type": "object"}),)

    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        cancellation.raise_if_cancelled()
        assert len(idempotency_key) == 64
        self.calls += 1
        return ToolResult(call.call_id, "ok", self.output)


class BlockingProvider:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def complete(self, request: object, cancellation: CancellationToken) -> ProviderResult:
        del request
        self.started.set()
        await self.release.wait()
        cancellation.raise_if_cancelled()
        raise AssertionError("cancelled provider must not return")


def provider_result(decision: ProviderDecision) -> ProviderResult:
    return ProviderResult(decision, "fake", "fake-model")


async def collect(orchestrator: AgentOrchestrator, session_id: str, **kwargs: object) -> list[AgentEvent]:
    return [event async for event in orchestrator.stream(session_id, **kwargs)]  # type: ignore[arg-type]


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
async def test_active_cancellation_is_signalled_then_checkpointed_by_stream() -> None:
    provider = BlockingProvider()
    orchestrator = AgentOrchestrator(provider, Broker(), InMemoryCheckpointStore())
    session = orchestrator.start("wait for cancellation", session_id="session:cancel-active")
    stream_task = asyncio.create_task(collect(orchestrator, session.session_id))
    await provider.started.wait()

    immediate_event = orchestrator.cancel(session.session_id)
    provider.release.set()
    events = await stream_task

    assert immediate_event is None
    assert events[-1].kind == EventKind.SESSION_CANCELLED
    assert orchestrator.state(session.session_id).stage == Stage.CANCELLED


@pytest.mark.asyncio
async def test_idle_cancellation_is_immediately_durable() -> None:
    orchestrator = AgentOrchestrator(
        QueueProvider(),
        Broker(),
        InMemoryCheckpointStore(),
    )
    session = orchestrator.start("cancel before running", session_id="session:cancel-idle")

    event = orchestrator.cancel(session.session_id)

    assert event is not None and event.kind == EventKind.SESSION_CANCELLED
    assert orchestrator.state(session.session_id).stage == Stage.CANCELLED


@pytest.mark.asyncio
async def test_retry_exhaustion_fails_durably_without_unbounded_calls() -> None:
    provider = QueueProvider(
        RetryableProviderError("first"),
        RetryableProviderError("second"),
    )
    orchestrator = AgentOrchestrator(
        provider,
        Broker(),
        InMemoryCheckpointStore(),
        AgentLimits(max_retries=1),
    )
    session = orchestrator.start("retry carefully", session_id="session:retry-failed")

    with pytest.raises(RetryableProviderError):
        await collect(orchestrator, session.session_id)

    assert provider.calls == 2
    assert orchestrator.state(session.session_id).stage == Stage.FAILED


@pytest.mark.asyncio
async def test_broker_output_limit_fails_after_approval() -> None:
    provider = QueueProvider(
        provider_result(ProviderDecision(DecisionKind.PLAN, content="read then review")),
        provider_result(
            ProviderDecision(
                DecisionKind.TOOL_CALL,
                tool_call=ToolCall("call:large", "repo:read", {"path": "large.txt"}),
            )
        ),
    )
    broker = Broker(output="x" * 513)
    orchestrator = AgentOrchestrator(
        provider,
        broker,
        InMemoryCheckpointStore(),
        AgentLimits(max_tool_result_bytes=512),
    )
    session = orchestrator.start("read bounded output", session_id="session:large-result")
    await collect(orchestrator, session.session_id)

    with pytest.raises(LimitExceededError, match="broker output"):
        await collect(
            orchestrator,
            session.session_id,
            approval=approval_response(orchestrator, session.session_id, ApprovalDecision.ALLOW_ONCE),
        )

    assert broker.calls == 1
    assert orchestrator.state(session.session_id).stage == Stage.FAILED


@pytest.mark.asyncio
async def test_step_limit_stops_continue_review_loop() -> None:
    provider = QueueProvider(
        provider_result(ProviderDecision(DecisionKind.PLAN, content="plan")),
        provider_result(ProviderDecision(DecisionKind.ANSWER, content="candidate")),
        provider_result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="revise once more",
                review_action=ReviewAction.CONTINUE,
            )
        ),
    )
    orchestrator = AgentOrchestrator(
        provider,
        Broker(),
        InMemoryCheckpointStore(),
        AgentLimits(max_steps=3),
    )
    session = orchestrator.start("bounded loop", session_id="session:step-limit")

    with pytest.raises(LimitExceededError, match="step limit"):
        await collect(orchestrator, session.session_id)

    assert orchestrator.state(session.session_id).stage == Stage.FAILED


@pytest.mark.asyncio
async def test_repeated_provider_state_fails_before_another_paid_request() -> None:
    provider = QueueProvider(
        provider_result(ProviderDecision(DecisionKind.PLAN, content="plan")),
        provider_result(ProviderDecision(DecisionKind.ANSWER, content="candidate")),
        provider_result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="revise once more",
                review_action=ReviewAction.CONTINUE,
            )
        ),
        provider_result(ProviderDecision(DecisionKind.ANSWER, content="candidate")),
        provider_result(
            ProviderDecision(
                DecisionKind.REVIEW,
                content="revise once more",
                review_action=ReviewAction.CONTINUE,
            )
        ),
    )
    orchestrator = AgentOrchestrator(
        provider,
        Broker(),
        InMemoryCheckpointStore(),
        AgentLimits(max_steps=12),
    )
    session = orchestrator.start("detect a stalled loop", session_id="session:no-progress")

    with pytest.raises(AgentNoProgressError, match="identical provider request"):
        await collect(orchestrator, session.session_id)

    state = orchestrator.state(session.session_id)
    assert provider.calls == 5
    assert state.stage == Stage.FAILED
    assert state.failure_code == "agent_no_progress"
    assert state.events[-1].kind == EventKind.SESSION_FAILED
    assert state.events[-1].data == {
        "errorType": "AgentNoProgressError",
        "reason": "agent_no_progress",
    }
