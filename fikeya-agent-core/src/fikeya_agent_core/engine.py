# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Checkpointed plan-act-observe-review orchestration engine."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace
from typing import TypeVar

from .cancellation import CancellationToken
from .checkpoints import CheckpointStore
from .errors import (
    AgentNoProgressError,
    BrokerOutcomeUncertainError,
    CancellationError,
    LimitExceededError,
    ProtocolError,
    RetryableProviderError,
    StateConflictError,
)
from .models import (
    AgentEvent,
    AgentLimits,
    ApprovalDecision,
    ApprovalGrant,
    ApprovalRequest,
    ApprovalResponse,
    DecisionKind,
    EventKind,
    EvidenceContext,
    JsonValue,
    ProviderRequest,
    ProviderResult,
    ReviewAction,
    SessionState,
    Stage,
    ToolCall,
    ToolDefinition,
    ToolResult,
    canonical_json,
    sha256_value,
)
from .protocols import ExecutionBroker, Provider
from .provider import render_system_instructions

T = TypeVar("T")


class AgentOrchestrator:
    """Run one durable state machine with no direct execution capability."""

    def __init__(
        self,
        provider: Provider,
        broker: ExecutionBroker,
        checkpoints: CheckpointStore,
        limits: AgentLimits | None = None,
    ) -> None:
        self.provider = provider
        self.broker = broker
        self.checkpoints = checkpoints
        self.limits = limits or AgentLimits()
        self._active_tokens: dict[str, CancellationToken] = {}
        self._streaming: set[str] = set()

    def start(
        self,
        prompt: str,
        *,
        evidence: EvidenceContext | None = None,
        session_id: str | None = None,
    ) -> SessionState:
        """Create a checkpointed session without calling a provider or tool."""

        if not prompt or len(prompt.encode("utf-8")) > self.limits.max_context_bytes:
            raise LimitExceededError("task prompt is empty or exceeds the context byte limit")
        if evidence is not None and len(evidence.content.encode("utf-8")) > self.limits.max_context_bytes:
            raise LimitExceededError("Qarinah evidence exceeds the context byte limit")
        identifier = session_id or f"session:{uuid.uuid4().hex}"
        return self.checkpoints.create(SessionState(identifier, prompt, evidence=evidence))

    def state(self, session_id: str) -> SessionState:
        """Load and validate a copy of the latest durable state."""

        state = self.checkpoints.load(session_id)
        self._validate_state(state)
        return state

    async def stream(
        self,
        session_id: str,
        *,
        approval: ApprovalResponse | None = None,
        cancellation: CancellationToken | None = None,
        after_sequence: int | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Advance until completion, failure, cancellation, or an approval pause."""

        if session_id in self._streaming:
            raise StateConflictError(f"session already has an active stream: {session_id}")
        self._streaming.add(session_id)
        try:
            state = self.checkpoints.load(session_id)
            self._validate_state(state)
            if approval is not None and state.stage != Stage.AWAITING_APPROVAL:
                raise ProtocolError("approval supplied when no tool call is awaiting approval")
            if approval is not None:
                self._validate_approval_response(state, approval)
            if (
                state.stage == Stage.OBSERVE
                and state.execution_lease_id is not None
                and (state.execution_lease_expires_at_ms or 0) > int(time.time() * 1_000)
            ):
                raise StateConflictError("approved tool call already has an active execution lease")
        except Exception:
            self._streaming.discard(session_id)
            raise
        token = cancellation or CancellationToken()
        self._active_tokens[session_id] = token
        try:
            if after_sequence is not None:
                for event in self._replay_events(state, after_sequence):
                    yield event
            if state.terminal:
                return

            if state.stage == Stage.AWAITING_APPROVAL:
                if approval is None:
                    state, event = self._reissue_approval(state)
                    yield event
                    return
                state, approval_events = self._resolve_approval(state, approval)
                for event in approval_events:
                    yield event
                if state.terminal:
                    return
            else:
                initial_kind = EventKind.SESSION_STARTED if state.event_sequence == 0 else EventKind.SESSION_RESUMED
                initial_events: list[AgentEvent] = []
                state, event = self._record(state, initial_kind, {})
                initial_events.append(event)
                if initial_kind == EventKind.SESSION_STARTED and state.evidence is not None:
                    state, event = self._record(
                        state,
                        EventKind.CONTEXT_ATTACHED,
                        {
                            "citationCount": len(state.evidence.citations),
                            "contentBytes": len(state.evidence.content.encode("utf-8")),
                            "contentSha256": state.evidence.content_sha256,
                            "trust": "untrusted-evidence-not-instructions",
                        },
                    )
                    initial_events.append(event)
                for event in initial_events:
                    yield event

            seen_provider_requests: set[str] = set()
            while not state.terminal:
                token.raise_if_cancelled()
                if state.step_count >= self.limits.max_steps:
                    raise LimitExceededError("agent reached the configured step limit")
                state.step_count += 1
                state, event = self._record(state, EventKind.STAGE_ENTERED, {"step": state.step_count})
                yield event

                if state.stage == Stage.PLAN:
                    result, retries = await self._provider_call(state, token, seen_provider_requests)
                    state, retry_events = self._retry_events(state, "provider", retries)
                    for event in retry_events:
                        yield event
                    self._require_decision(result, Stage.PLAN)
                    state.plan = result.decision.content
                    state.stage = Stage.ACT
                    state, event = self._record(
                        state,
                        EventKind.PLAN_CREATED,
                        {
                            "planBytes": len(state.plan.encode("utf-8")),
                            "planSha256": sha256_value(state.plan),
                        },
                    )
                    yield event
                    continue

                if state.stage == Stage.ACT:
                    result, retries = await self._provider_call(state, token, seen_provider_requests)
                    state, retry_events = self._retry_events(state, "provider", retries)
                    for event in retry_events:
                        yield event
                    decision = result.decision
                    if decision.kind == DecisionKind.ANSWER:
                        self._bound_output(decision.content, "candidate answer")
                        state.candidate_answer = decision.content
                        state.stage = Stage.REVIEW
                        state, event = self._record(
                            state,
                            EventKind.ANSWER_PROPOSED,
                            {
                                "answerBytes": len(decision.content.encode("utf-8")),
                                "answerSha256": sha256_value(decision.content),
                            },
                        )
                        yield event
                        continue
                    self._require_decision(result, Stage.ACT)
                    call = decision.tool_call
                    if call is None:
                        raise ProtocolError("tool_call decision omitted its call")
                    await self._validate_tool_call(call, token)
                    digest = sha256_value(call.arguments)
                    state.pending_call = call
                    state.approval_grant = None
                    state.stage = Stage.AWAITING_APPROVAL
                    state.pending_approval = ApprovalRequest(
                        request_id=f"approval:{uuid.uuid4().hex}",
                        session_id=state.session_id,
                        call_id=call.call_id,
                        tool_name=call.name,
                        arguments_sha256=digest,
                        expected_revision=state.revision + 1,
                        summary=f"Allow one brokered call to {call.name}?",
                    )
                    state, event = self._record(
                        state,
                        EventKind.TOOL_PROPOSED,
                        {
                            "argumentsBytes": len(canonical_json(call.arguments)),
                            "argumentsSha256": digest,
                            "callId": call.call_id,
                            "toolName": call.name,
                        },
                    )
                    yield event
                    state, event = self._reissue_approval(state)
                    yield event
                    return

                if state.stage == Stage.OBSERVE:
                    call, grant = self._validated_grant(state)
                    state, lease_event = self._claim_execution(state, grant)
                    yield lease_event
                    result = await self._broker_call(call, grant, token)
                    if result.call_id != call.call_id:
                        raise ProtocolError("broker result call_id does not match the approved call")
                    self._bound_tool_result(result)
                    state.observations.append(result)
                    state.pending_call = None
                    state.pending_approval = None
                    state.approval_grant = None
                    state.execution_lease_id = None
                    state.execution_lease_expires_at_ms = None
                    state.stage = Stage.REVIEW
                    state, event = self._record(
                        state,
                        EventKind.TOOL_COMPLETED,
                        {
                            "callId": result.call_id,
                            "idempotencyKey": grant.idempotency_key,
                            "outputBytes": len(result.output.encode("utf-8")),
                            "outputSha256": sha256_value(result.output),
                            "status": result.status,
                        },
                    )
                    yield event
                    continue

                if state.stage == Stage.REVIEW:
                    result, retries = await self._provider_call(state, token, seen_provider_requests)
                    state, retry_events = self._retry_events(state, "provider", retries)
                    for event in retry_events:
                        yield event
                    self._require_decision(result, Stage.REVIEW)
                    decision = result.decision
                    self._bound_output(decision.content, "review output")
                    if decision.review_action == ReviewAction.COMPLETE:
                        state.final_output = decision.content
                        state.stage = Stage.COMPLETED
                    else:
                        state.review_notes = decision.content
                        state.candidate_answer = ""
                        state.stage = Stage.ACT
                    state, event = self._record(
                        state,
                        EventKind.REVIEW_COMPLETED,
                        {
                            "action": decision.review_action.value if decision.review_action else "invalid",
                            "reviewBytes": len(decision.content.encode("utf-8")),
                            "reviewSha256": sha256_value(decision.content),
                        },
                    )
                    review_events = [event]
                    if state.stage == Stage.COMPLETED:
                        state, event = self._record(
                            state,
                            EventKind.SESSION_COMPLETED,
                            {
                                "outputBytes": len(decision.content.encode("utf-8")),
                                "outputSha256": sha256_value(decision.content),
                            },
                        )
                        review_events.append(event)
                    for event in review_events:
                        yield event
                    if state.stage == Stage.COMPLETED:
                        return
                    continue

                raise ProtocolError(f"unsupported active stage: {state.stage.value}")
        except StateConflictError:
            raise
        except BrokerOutcomeUncertainError as error:
            state.stage = Stage.FAILED
            state.failure_code = "broker_outcome_uncertain"
            state, event = self._record(
                state,
                EventKind.SESSION_FAILED,
                {
                    "errorType": type(error.__cause__).__name__ if error.__cause__ else type(error).__name__,
                    "reconciliationRequired": True,
                },
            )
            yield event
            raise
        except AgentNoProgressError as error:
            state.stage = Stage.FAILED
            state.failure_code = "agent_no_progress"
            state.final_output = None
            state.pending_call = None
            state.pending_approval = None
            state.approval_grant = None
            state.execution_lease_id = None
            state.execution_lease_expires_at_ms = None
            state, event = self._record(
                state,
                EventKind.SESSION_FAILED,
                {
                    "errorType": type(error).__name__,
                    "reason": "agent_no_progress",
                },
            )
            yield event
            raise
        except CancellationError:
            state.stage = Stage.CANCELLED
            state.failure_code = "cancelled"
            state.final_output = None
            state.pending_call = None
            state.pending_approval = None
            state.approval_grant = None
            state.execution_lease_id = None
            state.execution_lease_expires_at_ms = None
            state, event = self._record(state, EventKind.SESSION_CANCELLED, {"reason": "cancelled"})
            yield event
        except Exception as error:
            state.stage = Stage.FAILED
            state.failure_code = type(error).__name__
            state.final_output = None
            state.pending_call = None
            state.pending_approval = None
            state.approval_grant = None
            state.execution_lease_id = None
            state.execution_lease_expires_at_ms = None
            state, event = self._record(state, EventKind.SESSION_FAILED, {"errorType": type(error).__name__})
            yield event
            raise
        finally:
            if self._active_tokens.get(session_id) is token:
                self._active_tokens.pop(session_id, None)
            self._streaming.discard(session_id)

    def cancel(self, session_id: str) -> AgentEvent | None:
        """Signal an active operation, or persist cancellation while idle."""

        token = self._active_tokens.get(session_id)
        if token is not None:
            token.cancel()
            return None
        state = self.state(session_id)
        if state.terminal:
            raise ProtocolError("cannot cancel a terminal session")
        if state.execution_lease_id is not None:
            raise StateConflictError("cannot cancel a leased tool call from another stream; reconcile its outcome")
        state.stage = Stage.CANCELLED
        state.failure_code = "cancelled"
        state.final_output = None
        state.pending_call = None
        state.pending_approval = None
        state.approval_grant = None
        state.execution_lease_id = None
        state.execution_lease_expires_at_ms = None
        _, event = self._record(state, EventKind.SESSION_CANCELLED, {"reason": "cancelled"})
        return event

    def reconcile_tool_result(
        self,
        session_id: str,
        *,
        idempotency_key: str,
        result: ToolResult,
    ) -> AgentEvent:
        """Resume an uncertain execution only after the broker reconciles its stable call key."""

        state = self.state(session_id)
        if state.stage != Stage.FAILED or state.failure_code != "broker_outcome_uncertain":
            raise ProtocolError("session does not have an uncertain broker outcome to reconcile")
        call, grant = self._validated_grant(state)
        if idempotency_key != grant.idempotency_key or result.call_id != call.call_id:
            raise ProtocolError("reconciled broker result does not match the durable exact-call grant")
        self._bound_tool_result(result)
        state.observations.append(result)
        state.pending_call = None
        state.pending_approval = None
        state.approval_grant = None
        state.execution_lease_id = None
        state.execution_lease_expires_at_ms = None
        state.failure_code = None
        state.stage = Stage.REVIEW
        _, event = self._record(
            state,
            EventKind.TOOL_COMPLETED,
            {
                "callId": result.call_id,
                "idempotencyKey": grant.idempotency_key,
                "outputBytes": len(result.output.encode("utf-8")),
                "outputSha256": sha256_value(result.output),
                "reconciled": True,
                "status": result.status,
            },
        )
        return event

    def _resolve_approval(
        self,
        state: SessionState,
        response: ApprovalResponse,
    ) -> tuple[SessionState, tuple[AgentEvent, ...]]:
        request, call = self._validate_approval_response(state, response)

        events: list[AgentEvent] = []
        if response.decision == ApprovalDecision.CANCEL:
            state.stage = Stage.CANCELLED
            state.pending_call = None
            state.pending_approval = None
            state.failure_code = "approval_cancelled"
            state.final_output = None
        elif response.decision == ApprovalDecision.DENY_ONCE:
            state.observations.append(ToolResult(call.call_id, "denied", "Tool call denied by approval policy."))
            state.pending_call = None
            state.pending_approval = None
            state.stage = Stage.REVIEW
        elif response.decision == ApprovalDecision.ALLOW_ONCE:
            state.approval_grant = ApprovalGrant(
                request_id=request.request_id,
                session_id=request.session_id,
                call_id=request.call_id,
                tool_name=request.tool_name,
                arguments_sha256=request.arguments_sha256,
                idempotency_key=_grant_idempotency_key(
                    request.request_id,
                    request.session_id,
                    request.call_id,
                    request.tool_name,
                    request.arguments_sha256,
                ),
            )
            state.pending_approval = None
            state.stage = Stage.OBSERVE
        else:
            raise ProtocolError("unsupported approval decision")
        state, event = self._record(
            state,
            EventKind.APPROVAL_RESOLVED,
            {"decision": response.decision.value, "requestId": request.request_id},
        )
        events.append(event)
        if state.stage == Stage.CANCELLED:
            state, event = self._record(
                state,
                EventKind.SESSION_CANCELLED,
                {"reason": "approval_cancelled"},
            )
            events.append(event)
        return state, tuple(events)

    def _validate_approval_response(
        self,
        state: SessionState,
        response: ApprovalResponse,
    ) -> tuple[ApprovalRequest, ToolCall]:
        if not isinstance(response, ApprovalResponse):
            raise ProtocolError("approval must be a response bound to the current request")
        request, call = self._validated_pending_approval(state)
        expected = (
            request.request_id,
            request.session_id,
            request.call_id,
            request.tool_name,
            request.arguments_sha256,
            request.expected_revision,
        )
        actual = (
            response.request_id,
            response.session_id,
            response.call_id,
            response.tool_name,
            response.arguments_sha256,
            response.expected_revision,
        )
        if actual != expected or response.expected_revision != state.revision:
            raise ProtocolError("approval response does not match the current checkpointed request")
        return request, call

    def _reissue_approval(self, state: SessionState) -> tuple[SessionState, AgentEvent]:
        request, call = self._validated_pending_approval(state, require_revision=False)
        request = replace(request, expected_revision=state.revision + 1)
        state.pending_approval = request
        return self._record(
            state,
            EventKind.APPROVAL_REQUESTED,
            {
                "argumentsBytes": len(canonical_json(call.arguments)),
                "argumentsSha256": request.arguments_sha256,
                "callId": call.call_id,
                "expectedRevision": request.expected_revision,
                "requestId": request.request_id,
                "summary": request.summary,
                "toolName": call.name,
            },
        )

    def _claim_execution(self, state: SessionState, grant: ApprovalGrant) -> tuple[SessionState, AgentEvent]:
        now = int(time.time() * 1_000)
        if state.execution_lease_id is not None:
            expires = state.execution_lease_expires_at_ms or 0
            if expires > now:
                raise StateConflictError("approved tool call already has an active execution lease")
        state.execution_lease_id = f"lease:{uuid.uuid4().hex}"
        state.execution_lease_expires_at_ms = now + round(self.limits.broker_timeout_seconds * 1_000) + 30_000
        return self._record(
            state,
            EventKind.TOOL_EXECUTION_CLAIMED,
            {
                "callId": grant.call_id,
                "idempotencyKey": grant.idempotency_key,
                "leaseId": state.execution_lease_id,
            },
        )

    def _retry_events(
        self,
        state: SessionState,
        operation: str,
        retries: int,
    ) -> tuple[SessionState, tuple[AgentEvent, ...]]:
        events: list[AgentEvent] = []
        for attempt in range(1, retries + 1):
            state, event = self._record(
                state,
                EventKind.RETRY_SCHEDULED,
                {"attempt": attempt, "operation": operation},
            )
            events.append(event)
        return state, tuple(events)

    async def _provider_call(
        self,
        state: SessionState,
        token: CancellationToken,
        seen_requests: set[str],
    ) -> tuple[ProviderResult, int]:
        tools = await self._tools(token)
        request = self._provider_request(state, tools)
        request_fingerprint = _provider_request_fingerprint(request)
        if request_fingerprint in seen_requests:
            raise AgentNoProgressError(
                "agent produced no new state and would repeat an identical provider request"
            )
        seen_requests.add(request_fingerprint)
        return await self._bounded_retry(
            lambda: self.provider.complete(request, token),
            RetryableProviderError,
            self.limits.provider_timeout_seconds,
        )

    async def _broker_call(
        self,
        call: ToolCall,
        grant: ApprovalGrant,
        token: CancellationToken,
    ) -> ToolResult:
        try:
            return await asyncio.wait_for(
                self.broker.execute(call, token, idempotency_key=grant.idempotency_key),
                timeout=self.limits.broker_timeout_seconds,
            )
        except asyncio.CancelledError as error:
            raise BrokerOutcomeUncertainError(
                "broker task was cancelled after dispatch; reconcile by idempotency key"
            ) from error
        except Exception as error:
            raise BrokerOutcomeUncertainError(
                "broker outcome is uncertain; reconcile by idempotency key before any retry"
            ) from error

    async def _bounded_retry(
        self,
        operation: Callable[[], Awaitable[T]],
        retryable: type[Exception],
        timeout: float,
    ) -> tuple[T, int]:
        retries = 0
        while True:
            try:
                return await asyncio.wait_for(operation(), timeout=timeout), retries
            except asyncio.TimeoutError as error:
                if retries >= self.limits.max_retries:
                    raise retryable("operation exceeded its retry and timeout limits") from error
            except retryable:
                if retries >= self.limits.max_retries:
                    raise
            retries += 1

    async def _tools(self, token: CancellationToken) -> tuple[ToolDefinition, ...]:
        token.raise_if_cancelled()
        tools = await asyncio.wait_for(
            self.broker.list_tools(token),
            timeout=self.limits.broker_timeout_seconds,
        )
        if len(tools) > self.limits.max_tools:
            raise LimitExceededError("execution broker returned too many tools")
        names = [tool.name for tool in tools]
        if len(set(names)) != len(names):
            raise ProtocolError("execution broker returned duplicate tool names")
        if len(canonical_json([_tool_value(item) for item in tools])) > self.limits.max_context_bytes:
            raise LimitExceededError("execution broker tool metadata exceeds the context byte limit")
        return tools

    async def _validate_tool_call(self, call: ToolCall, token: CancellationToken) -> None:
        if len(canonical_json(call.arguments)) > self.limits.max_tool_arguments_bytes:
            raise LimitExceededError("tool arguments exceed the configured byte limit")
        tools = await self._tools(token)
        if call.name not in {tool.name for tool in tools}:
            raise ProtocolError(f"provider requested an unavailable tool: {call.name}")

    def _provider_request(
        self,
        state: SessionState,
        tools: tuple[ToolDefinition, ...],
    ) -> ProviderRequest:
        system = render_system_instructions(state.evidence)
        context_value = {
            "candidateAnswer": state.candidate_answer,
            "observations": [
                {
                    "callId": item.call_id,
                    "contentType": item.content_type,
                    "output": item.output,
                    "status": item.status,
                }
                for item in state.observations
            ],
            "plan": state.plan,
            "prompt": state.prompt,
            "reviewNotes": state.review_notes,
            "system": system,
            "tools": [_tool_value(item) for item in tools],
        }
        if len(canonical_json(context_value)) > self.limits.max_context_bytes:
            raise LimitExceededError("assembled provider context exceeds the configured byte limit")
        return ProviderRequest(
            session_id=state.session_id,
            stage=state.stage,
            prompt=state.prompt,
            system=system,
            plan=state.plan,
            observations=tuple(state.observations),
            review_notes=state.review_notes,
            candidate_answer=state.candidate_answer,
            tools=tools,
            max_output_bytes=self.limits.max_output_bytes,
        )

    def _require_decision(self, result: ProviderResult, stage: Stage) -> None:
        allowed = {
            Stage.PLAN: {DecisionKind.PLAN},
            Stage.ACT: {DecisionKind.TOOL_CALL, DecisionKind.ANSWER},
            Stage.REVIEW: {DecisionKind.REVIEW},
        }[stage]
        if result.decision.kind not in allowed:
            raise ProtocolError(
                f"provider decision {result.decision.kind.value} is invalid during {stage.value}"
            )
        self._bound_output(result.decision.content, "provider decision")

    def _bound_output(self, value: str, label: str) -> None:
        if len(value.encode("utf-8")) > self.limits.max_output_bytes:
            raise LimitExceededError(f"{label} exceeds the configured byte limit")

    def _bound_tool_result(self, result: ToolResult) -> None:
        if len(result.output.encode("utf-8")) > self.limits.max_tool_result_bytes:
            raise LimitExceededError("broker output exceeds the configured byte limit")

    def _record(
        self,
        state: SessionState,
        kind: EventKind,
        data: dict[str, JsonValue],
    ) -> tuple[SessionState, AgentEvent]:
        canonical_json(data)
        state.event_sequence += 1
        state.updated_at_ms = int(time.time() * 1_000)
        event = AgentEvent(
            session_id=state.session_id,
            sequence=state.event_sequence,
            kind=kind,
            stage=state.stage,
            data=data,
            created_at_ms=state.updated_at_ms,
        )
        state.events.append(event)
        if len(state.events) > self.limits.max_events:
            state.events.pop(0)
        return self._save(state), event

    def _save(self, state: SessionState) -> SessionState:
        return self.checkpoints.save(state, expected_revision=state.revision)

    def _replay_events(self, state: SessionState, after_sequence: int) -> tuple[AgentEvent, ...]:
        if after_sequence < 0 or after_sequence > state.event_sequence:
            raise ProtocolError("event replay cursor is outside the session sequence")
        if state.events and after_sequence < state.events[0].sequence - 1:
            raise ProtocolError("event replay cursor has expired from the bounded outbox")
        return tuple(event for event in state.events if event.sequence > after_sequence)

    def _validated_pending_approval(
        self,
        state: SessionState,
        *,
        require_revision: bool = True,
    ) -> tuple[ApprovalRequest, ToolCall]:
        request = state.pending_approval
        call = state.pending_call
        if request is None or call is None:
            raise ProtocolError("approval checkpoint is missing its pending tool call")
        digest = sha256_value(call.arguments)
        if (
            request.session_id != state.session_id
            or request.call_id != call.call_id
            or request.tool_name != call.name
            or request.arguments_sha256 != digest
            or (require_revision and request.expected_revision != state.revision)
        ):
            raise ProtocolError("pending approval is not bound to the exact checkpointed call")
        return request, call

    def _validated_grant(self, state: SessionState) -> tuple[ToolCall, ApprovalGrant]:
        call = state.pending_call
        grant = state.approval_grant
        if call is None or grant is None:
            raise ProtocolError("observe stage requires one durable exact-call approval grant")
        if (
            grant.session_id != state.session_id
            or grant.call_id != call.call_id
            or grant.tool_name != call.name
            or grant.arguments_sha256 != sha256_value(call.arguments)
            or grant.idempotency_key
            != _grant_idempotency_key(
                grant.request_id,
                grant.session_id,
                grant.call_id,
                grant.tool_name,
                grant.arguments_sha256,
            )
        ):
            raise ProtocolError("durable approval grant does not match the pending call")
        return call, grant

    def _validate_state(self, state: SessionState) -> None:
        if state.events:
            sequences = [event.sequence for event in state.events]
            if sequences[0] < 1:
                raise ProtocolError("checkpoint event outbox sequences must start at one or later")
            if sequences != list(range(sequences[0], sequences[-1] + 1)):
                raise ProtocolError("checkpoint event outbox sequence is not contiguous")
            if state.events[-1].sequence != state.event_sequence:
                raise ProtocolError("checkpoint event sequence does not match its outbox")
            if any(event.session_id != state.session_id for event in state.events):
                raise ProtocolError("checkpoint event belongs to another session")
        elif state.event_sequence != 0:
            raise ProtocolError("checkpoint event sequence is missing its outbox")
        lease_fields = (state.execution_lease_id, state.execution_lease_expires_at_ms)
        if (lease_fields[0] is None) != (lease_fields[1] is None):
            raise ProtocolError("execution lease fields must be present together")
        if state.execution_lease_expires_at_ms is not None and state.execution_lease_expires_at_ms <= 0:
            raise ProtocolError("execution lease expiry must be a positive epoch timestamp")
        if state.stage == Stage.COMPLETED and state.final_output is None:
            raise ProtocolError("completed checkpoint must retain its final output")
        if state.stage != Stage.COMPLETED and state.final_output is not None:
            raise ProtocolError("only a completed checkpoint may retain final output")
        if state.stage in {Stage.FAILED, Stage.CANCELLED}:
            if not state.failure_code:
                raise ProtocolError("failed and cancelled checkpoints require a failure code")
        elif state.failure_code is not None:
            raise ProtocolError("active and completed checkpoints cannot retain a failure code")
        if state.stage == Stage.AWAITING_APPROVAL:
            self._validated_pending_approval(state)
            if state.approval_grant is not None or state.execution_lease_id is not None:
                raise ProtocolError("awaiting approval cannot already hold a grant or lease")
            return
        if state.stage == Stage.OBSERVE:
            self._validated_grant(state)
            if state.pending_approval is not None:
                raise ProtocolError("observe stage cannot retain a pending approval request")
            return
        if state.stage == Stage.FAILED and state.failure_code == "broker_outcome_uncertain":
            self._validated_grant(state)
            if state.execution_lease_id is None:
                raise ProtocolError("uncertain broker outcome must retain its execution lease")
            return
        if any(
            value is not None
            for value in (
                state.pending_call,
                state.pending_approval,
                state.approval_grant,
                state.execution_lease_id,
                state.execution_lease_expires_at_ms,
            )
        ):
            raise ProtocolError(f"stage {state.stage.value} contains unauthorized execution state")


def _provider_request_fingerprint(request: ProviderRequest) -> str:
    """Hash one exact provider state without retaining any request content."""

    return sha256_value(
        {
            "candidateAnswer": request.candidate_answer,
            "maxOutputBytes": request.max_output_bytes,
            "observations": [
                {
                    "callId": item.call_id,
                    "contentType": item.content_type,
                    "output": item.output,
                    "status": item.status,
                }
                for item in request.observations
            ],
            "plan": request.plan,
            "prompt": request.prompt,
            "reviewNotes": request.review_notes,
            "stage": request.stage.value,
            "system": request.system,
            "tools": [_tool_value(item) for item in request.tools],
        }
    )


def _tool_value(tool: ToolDefinition) -> dict[str, JsonValue]:
    return {"description": tool.description, "inputSchema": tool.input_schema, "name": tool.name}


def _grant_idempotency_key(
    request_id: str,
    session_id: str,
    call_id: str,
    tool_name: str,
    arguments_sha256: str,
) -> str:
    return sha256_value(
        {
            "argumentsSha256": arguments_sha256,
            "callId": call_id,
            "requestId": request_id,
            "sessionId": session_id,
            "toolName": tool_name,
        }
    )
