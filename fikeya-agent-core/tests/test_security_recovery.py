# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import json
from collections import deque
from dataclasses import replace

import pytest

from fikeya_agent_core import (
    AgentEvent,
    AgentLimits,
    AgentOrchestrator,
    ApprovalDecision,
    ApprovalResponse,
    BrokerOutcomeUncertainError,
    CancellationToken,
    DecisionKind,
    EventKind,
    InMemoryCheckpointStore,
    ProtocolError,
    ProviderDecision,
    ProviderResult,
    RetryableBrokerError,
    RetryableProviderError,
    ReviewAction,
    Stage,
    StateConflictError,
    ToolCall,
    ToolDefinition,
    ToolResult,
)


class ScriptProvider:
    def __init__(self, *decisions: ProviderDecision) -> None:
        self.decisions = deque(decisions)
        self.calls = 0

    async def complete(self, request: object, cancellation: CancellationToken) -> ProviderResult:
        del request
        cancellation.raise_if_cancelled()
        self.calls += 1
        return ProviderResult(self.decisions.popleft(), "fake", "fake-model")


class ExactOnceBroker:
    def __init__(self, *, output: str = "tool output", failure: Exception | None = None) -> None:
        self.output = output
        self.failure = failure
        self.calls = 0
        self.keys: list[str] = []
        self.cache: dict[str, ToolResult] = {}

    async def list_tools(self, cancellation: CancellationToken) -> tuple[ToolDefinition, ...]:
        cancellation.raise_if_cancelled()
        return (ToolDefinition("repo:read", "Read a repository file", {"type": "object"}),)

    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        cancellation.raise_if_cancelled()
        if idempotency_key in self.cache:
            return self.cache[idempotency_key]
        self.calls += 1
        self.keys.append(idempotency_key)
        if self.failure is not None:
            raise self.failure
        result = ToolResult(call.call_id, "ok", self.output)
        self.cache[idempotency_key] = result
        return result


class BlockingBroker(ExactOnceBroker):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        self.started.set()
        await self.release.wait()
        return await super().execute(call, cancellation, idempotency_key=idempotency_key)


class CancelledBroker(ExactOnceBroker):
    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        del call, cancellation, idempotency_key
        self.calls += 1
        raise asyncio.CancelledError


class TimeoutProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, request: object, cancellation: CancellationToken) -> ProviderResult:
        del request, cancellation
        self.calls += 1
        await asyncio.sleep(1)
        raise AssertionError("wait_for should time out first")


def scripted_provider(*, tool_arguments: dict[str, object] | None = None, final: str = "done") -> ScriptProvider:
    return ScriptProvider(
        ProviderDecision(DecisionKind.PLAN, content="inspect then report"),
        ProviderDecision(
            DecisionKind.TOOL_CALL,
            tool_call=ToolCall("call:read", "repo:read", tool_arguments or {"path": "README.md"}),
        ),
        ProviderDecision(DecisionKind.REVIEW, content=final, review_action=ReviewAction.COMPLETE),
    )


def bound_response(
    orchestrator: AgentOrchestrator,
    session_id: str,
    decision: ApprovalDecision = ApprovalDecision.ALLOW_ONCE,
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


async def collect(stream: object) -> list[AgentEvent]:
    return [event async for event in stream]  # type: ignore[attr-defined]


async def pause(orchestrator: AgentOrchestrator, session_id: str) -> list[AgentEvent]:
    return await collect(orchestrator.stream(session_id))


@pytest.mark.asyncio
async def test_tampered_approval_responses_fail_without_mutating_the_checkpoint() -> None:
    provider = scripted_provider()
    broker = ExactOnceBroker()
    orchestrator = AgentOrchestrator(provider, broker, InMemoryCheckpointStore())
    session = orchestrator.start("inspect safely", session_id="session:approval-tamper")
    await pause(orchestrator, session.session_id)
    valid = bound_response(orchestrator, session.session_id)
    invalid = (
        replace(valid, request_id="approval:other"),
        replace(valid, tool_name="repo:write"),
        replace(valid, arguments_sha256="f" * 64),
        replace(valid, expected_revision=valid.expected_revision + 1),
    )

    for response in invalid:
        with pytest.raises(ProtocolError, match="does not match"):
            await collect(orchestrator.stream(session.session_id, approval=response))
        assert orchestrator.state(session.session_id).stage == Stage.AWAITING_APPROVAL
        assert broker.calls == 0

    await collect(orchestrator.stream(session.session_id, approval=valid))
    assert orchestrator.state(session.session_id).stage == Stage.COMPLETED
    assert broker.calls == 1


def test_checkpoint_invariants_reject_call_digest_tampering_and_forged_observe() -> None:
    provider = scripted_provider()
    store = InMemoryCheckpointStore()
    orchestrator = AgentOrchestrator(provider, ExactOnceBroker(), store)
    session = orchestrator.start("inspect safely", session_id="session:checkpoint-tamper")
    asyncio.run(pause(orchestrator, session.session_id))
    state = store.load(session.session_id)
    request = state.pending_approval
    assert request is not None
    state.pending_call = ToolCall("call:read", "repo:read", {"path": "changed.py"})
    state.pending_approval = replace(request, expected_revision=state.revision + 1)
    store.save(state, expected_revision=state.revision)

    with pytest.raises(ProtocolError, match="exact checkpointed call"):
        orchestrator.state(session.session_id)

    forged = InMemoryCheckpointStore()
    forged_orchestrator = AgentOrchestrator(scripted_provider(), ExactOnceBroker(), forged)
    forged_session = forged_orchestrator.start("inspect", session_id="session:forged-observe")
    forged_state = forged.load(forged_session.session_id)
    forged_state.stage = Stage.OBSERVE
    forged_state.pending_call = ToolCall("call:read", "repo:read", {"path": "README.md"})
    forged.save(forged_state, expected_revision=forged_state.revision)
    with pytest.raises(ProtocolError, match="durable exact-call approval grant"):
        forged_orchestrator.state(forged_session.session_id)


@pytest.mark.asyncio
async def test_checkpoint_invariants_rederive_the_grant_idempotency_key() -> None:
    store = InMemoryCheckpointStore()
    orchestrator = AgentOrchestrator(scripted_provider(), ExactOnceBroker(), store)
    session = orchestrator.start("inspect", session_id="session:grant-key-tamper")
    await pause(orchestrator, session.session_id)
    generator = orchestrator.stream(
        session.session_id,
        approval=bound_response(orchestrator, session.session_id),
    )
    async for event in generator:
        if event.kind == EventKind.APPROVAL_RESOLVED:
            break
    await generator.aclose()
    state = store.load(session.session_id)
    assert state.stage == Stage.OBSERVE and state.approval_grant is not None
    state.approval_grant = replace(state.approval_grant, idempotency_key="f" * 64)
    store.save(state, expected_revision=state.revision)

    with pytest.raises(ProtocolError, match="grant does not match"):
        orchestrator.state(session.session_id)


@pytest.mark.asyncio
async def test_execution_lease_blocks_a_second_orchestrator_before_broker_dispatch() -> None:
    store = InMemoryCheckpointStore()
    provider = scripted_provider()
    broker = BlockingBroker()
    first = AgentOrchestrator(provider, broker, store)
    session = first.start("inspect safely", session_id="session:concurrent")
    await pause(first, session.session_id)
    response = bound_response(first, session.session_id)
    first_task = asyncio.create_task(collect(first.stream(session.session_id, approval=response)))
    await broker.started.wait()

    second = AgentOrchestrator(provider, broker, store)
    with pytest.raises(StateConflictError, match="cannot cancel a leased tool call"):
        second.cancel(session.session_id)
    with pytest.raises(StateConflictError, match="execution lease"):
        await collect(second.stream(session.session_id))

    broker.release.set()
    await first_task
    assert broker.calls == 1
    assert first.state(session.session_id).stage == Stage.COMPLETED


@pytest.mark.asyncio
async def test_broker_task_cancellation_is_an_uncertain_outcome_not_a_replay() -> None:
    provider = scripted_provider()
    broker = CancelledBroker()
    orchestrator = AgentOrchestrator(provider, broker, InMemoryCheckpointStore())
    session = orchestrator.start("inspect", session_id="session:broker-task-cancelled")
    await pause(orchestrator, session.session_id)

    with pytest.raises(BrokerOutcomeUncertainError, match="cancelled after dispatch"):
        await collect(
            orchestrator.stream(
                session.session_id,
                approval=bound_response(orchestrator, session.session_id),
            )
        )
    state = orchestrator.state(session.session_id)
    assert broker.calls == 1
    assert state.failure_code == "broker_outcome_uncertain"


@pytest.mark.asyncio
async def test_broker_failure_is_never_retried_and_requires_bound_reconciliation() -> None:
    provider = scripted_provider()
    broker = ExactOnceBroker(failure=RetryableBrokerError("transport disconnected"))
    orchestrator = AgentOrchestrator(provider, broker, InMemoryCheckpointStore())
    session = orchestrator.start("inspect safely", session_id="session:uncertain")
    await pause(orchestrator, session.session_id)

    with pytest.raises(BrokerOutcomeUncertainError, match="reconcile"):
        await collect(
            orchestrator.stream(
                session.session_id,
                approval=bound_response(orchestrator, session.session_id),
            )
        )

    uncertain = orchestrator.state(session.session_id)
    assert broker.calls == 1
    assert uncertain.failure_code == "broker_outcome_uncertain"
    assert uncertain.approval_grant is not None
    key = uncertain.approval_grant.idempotency_key
    with pytest.raises(ProtocolError, match="does not match"):
        orchestrator.reconcile_tool_result(
            session.session_id,
            idempotency_key="0" * 64,
            result=ToolResult("call:read", "ok", "recovered"),
        )
    event = orchestrator.reconcile_tool_result(
        session.session_id,
        idempotency_key=key,
        result=ToolResult("call:read", "ok", "recovered"),
    )
    assert event.data["reconciled"] is True
    await collect(orchestrator.stream(session.session_id))
    assert orchestrator.state(session.session_id).stage == Stage.COMPLETED
    assert broker.calls == 1


@pytest.mark.asyncio
async def test_disconnect_reemits_pending_approval_and_replays_terminal_outbox() -> None:
    pending_provider = scripted_provider()
    pending = AgentOrchestrator(pending_provider, ExactOnceBroker(), InMemoryCheckpointStore())
    pending_session = pending.start("inspect", session_id="session:approval-replay")
    generator = pending.stream(pending_session.session_id)
    proposed: AgentEvent | None = None
    async for event in generator:
        if event.kind == EventKind.TOOL_PROPOSED:
            proposed = event
            break
    await generator.aclose()
    assert proposed is not None
    resumed_events = await collect(pending.stream(pending_session.session_id, after_sequence=proposed.sequence))
    assert resumed_events[-1].kind == EventKind.APPROVAL_REQUESTED
    assert pending.state(pending_session.session_id).stage == Stage.AWAITING_APPROVAL

    terminal_provider = ScriptProvider(
        ProviderDecision(DecisionKind.PLAN, content="answer directly"),
        ProviderDecision(DecisionKind.ANSWER, content="candidate"),
        ProviderDecision(DecisionKind.REVIEW, content="final", review_action=ReviewAction.COMPLETE),
    )
    terminal = AgentOrchestrator(terminal_provider, ExactOnceBroker(), InMemoryCheckpointStore())
    terminal_session = terminal.start("answer", session_id="session:terminal-replay")
    terminal_generator = terminal.stream(terminal_session.session_id)
    review: AgentEvent | None = None
    async for event in terminal_generator:
        if event.kind == EventKind.REVIEW_COMPLETED:
            review = event
            break
    await terminal_generator.aclose()
    assert review is not None and terminal_provider.calls == 3
    replayed = await collect(terminal.stream(terminal_session.session_id, after_sequence=review.sequence))
    assert [event.kind for event in replayed] == [EventKind.SESSION_COMPLETED]
    assert terminal_provider.calls == 3


@pytest.mark.asyncio
async def test_asyncio_timeout_is_bounded_and_checkpointed_on_python_310() -> None:
    provider = TimeoutProvider()
    orchestrator = AgentOrchestrator(
        provider,
        ExactOnceBroker(),
        InMemoryCheckpointStore(),
        AgentLimits(max_retries=1, provider_timeout_seconds=0.1),
    )
    session = orchestrator.start("timeout", session_id="session:provider-timeout")
    with pytest.raises(RetryableProviderError, match="timeout"):
        await collect(orchestrator.stream(session.session_id))
    assert provider.calls == 2
    assert orchestrator.state(session.session_id).stage == Stage.FAILED


@pytest.mark.asyncio
async def test_durable_event_receipts_do_not_retain_arguments_outputs_or_final_text() -> None:
    private_values = ("private-path-value", "private-tool-output", "private-final-answer")
    provider = scripted_provider(tool_arguments={"path": private_values[0]}, final=private_values[2])
    broker = ExactOnceBroker(output=private_values[1])
    orchestrator = AgentOrchestrator(provider, broker, InMemoryCheckpointStore())
    session = orchestrator.start("inspect", session_id="session:content-free-events")
    await pause(orchestrator, session.session_id)
    await collect(
        orchestrator.stream(
            session.session_id,
            approval=bound_response(orchestrator, session.session_id),
        )
    )
    receipts = json.dumps([event.data for event in orchestrator.state(session.session_id).events])
    assert all(value not in receipts for value in private_values)
