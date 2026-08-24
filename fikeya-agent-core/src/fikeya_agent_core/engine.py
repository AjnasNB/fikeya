# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Checkpointed plan-act-observe-review orchestration engine."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable

from .cancellation import CancellationToken
from .checkpoints import CheckpointStore
from .errors import (
    CancellationError,
    LimitExceededError,
    ProtocolError,
    RetryableBrokerError,
    RetryableProviderError,
)
from .models import (
    AgentEvent,
    AgentLimits,
    ApprovalDecision,
    ApprovalRequest,
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
        """Load a copy of the latest durable state."""

        return self.checkpoints.load(session_id)

    async def stream(
        self,
        session_id: str,
        *,
        approval: ApprovalDecision | None = None,
        cancellation: CancellationToken | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Advance until completion, failure, cancellation, or an approval pause."""

        state = self.checkpoints.load(session_id)
        if state.terminal:
            return
        token = cancellation or CancellationToken()
        self._active_tokens[session_id] = token
        try:
            initial_kind = EventKind.SESSION_STARTED if state.event_sequence == 0 else EventKind.SESSION_RESUMED
            state, event = self._record(state, initial_kind, {})
            yield event
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
                yield event

            if state.stage == Stage.AWAITING_APPROVAL:
                if approval is None:
                    return
                state, approval_events = await self._resolve_approval(state, approval)
                for event in approval_events:
                    yield event
                if state.terminal:
                    return
            elif approval is not None:
                raise ProtocolError("approval supplied when no tool call is awaiting approval")

            while not state.terminal:
                token.raise_if_cancelled()
                if state.step_count >= self.limits.max_steps:
                    raise LimitExceededError("agent reached the configured step limit")
                state.step_count += 1
                state, event = self._record(
                    state,
                    EventKind.STAGE_ENTERED,
                    {"step": state.step_count},
                )
                yield event

                if state.stage == Stage.PLAN:
                    result, retries = await self._provider_call(state, token)
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
                    result, retries = await self._provider_call(state, token)
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
                    if decision.tool_call is None:
                        raise ProtocolError("tool_call decision omitted its call")
                    await self._validate_tool_call(decision.tool_call, token)
                    state.pending_call = decision.tool_call
                    state.pending_approval = ApprovalRequest(
                        request_id=f"approval:{uuid.uuid4().hex}",
                        session_id=state.session_id,
                        tool_name=decision.tool_call.name,
                        arguments_sha256=sha256_value(decision.tool_call.arguments),
                        summary=f"Allow one brokered call to {decision.tool_call.name}?",
                    )
                    state.stage = Stage.AWAITING_APPROVAL
                    state, event = self._record(
                        state,
                        EventKind.TOOL_PROPOSED,
                        {
                            "argumentsBytes": len(canonical_json(decision.tool_call.arguments)),
                            "argumentsSha256": state.pending_approval.arguments_sha256,
                            "callId": decision.tool_call.call_id,
                            "toolName": decision.tool_call.name,
                        },
                    )
                    yield event
                    state, event = self._record(
                        state,
                        EventKind.APPROVAL_REQUESTED,
                        {
                            "arguments": decision.tool_call.arguments,
                            "requestId": state.pending_approval.request_id,
                            "summary": state.pending_approval.summary,
                            "toolName": decision.tool_call.name,
                        },
                    )
                    yield event
                    return

                if state.stage == Stage.OBSERVE:
                    if state.pending_call is None:
                        raise ProtocolError("observe stage has no pending broker call")
                    result, retries = await self._broker_call(state.pending_call, token)
                    state, retry_events = self._retry_events(state, "broker", retries)
                    for event in retry_events:
                        yield event
                    if result.call_id != state.pending_call.call_id:
                        raise ProtocolError("broker result call_id does not match the pending call")
                    self._bound_tool_result(result)
                    state.observations.append(result)
                    state.pending_call = None
                    state.pending_approval = None
                    state.stage = Stage.REVIEW
                    state, event = self._record(
                        state,
                        EventKind.TOOL_COMPLETED,
                        {
                            "callId": result.call_id,
                            "outputBytes": len(result.output.encode("utf-8")),
                            "outputSha256": sha256_value(result.output),
                            "status": result.status,
                        },
                    )
                    yield event
                    continue

                if state.stage == Stage.REVIEW:
                    result, retries = await self._provider_call(state, token)
                    state, retry_events = self._retry_events(state, "provider", retries)
                    for event in retry_events:
                        yield event
                    self._require_decision(result, Stage.REVIEW)
                    decision = result.decision
                    self._bound_output(decision.content, "review output")
                    state, event = self._record(
                        state,
                        EventKind.REVIEW_COMPLETED,
                        {
                            "action": decision.review_action.value if decision.review_action else "invalid",
                            "reviewBytes": len(decision.content.encode("utf-8")),
                            "reviewSha256": sha256_value(decision.content),
                        },
                    )
                    yield event
                    if decision.review_action == ReviewAction.COMPLETE:
                        state.final_output = decision.content
                        state.stage = Stage.COMPLETED
                        state, event = self._record(
                            state,
                            EventKind.SESSION_COMPLETED,
                            {
                                "output": decision.content,
                                "outputBytes": len(decision.content.encode("utf-8")),
                                "outputSha256": sha256_value(decision.content),
                            },
                        )
                        yield event
                        return
                    state.review_notes = decision.content
                    state.candidate_answer = ""
                    state.stage = Stage.ACT
                    state = self._save(state)
                    continue

                raise ProtocolError(f"unsupported active stage: {state.stage.value}")
        except CancellationError:
            state.stage = Stage.CANCELLED
            state.failure_code = "cancelled"
            state.pending_call = None
            state.pending_approval = None
            state, event = self._record(state, EventKind.SESSION_CANCELLED, {"reason": "cancelled"})
            yield event
        except Exception as error:
            state.stage = Stage.FAILED
            state.failure_code = type(error).__name__
            state.pending_call = None
            state.pending_approval = None
            state, event = self._record(
                state,
                EventKind.SESSION_FAILED,
                {"errorType": type(error).__name__},
            )
            yield event
            raise
        finally:
            if self._active_tokens.get(session_id) is token:
                self._active_tokens.pop(session_id, None)

    def cancel(self, session_id: str) -> AgentEvent | None:
        """Signal an active operation, or persist cancellation while idle."""

        token = self._active_tokens.get(session_id)
        if token is not None:
            token.cancel()
            return None
        state = self.checkpoints.load(session_id)
        if state.terminal:
            raise ProtocolError("cannot cancel a terminal session")
        state.stage = Stage.CANCELLED
        state.failure_code = "cancelled"
        state.pending_call = None
        state.pending_approval = None
        _, event = self._record(state, EventKind.SESSION_CANCELLED, {"reason": "cancelled"})
        return event

    async def _resolve_approval(
        self,
        state: SessionState,
        approval: ApprovalDecision,
    ) -> tuple[SessionState, tuple[AgentEvent, ...]]:
        request = state.pending_approval
        call = state.pending_call
        if request is None or call is None:
            raise ProtocolError("approval checkpoint is missing its pending tool call")
        state, event = self._record(
            state,
            EventKind.APPROVAL_RESOLVED,
            {"decision": approval.value, "requestId": request.request_id},
        )
        events = [event]
        if approval == ApprovalDecision.CANCEL:
            state.stage = Stage.CANCELLED
            state.pending_call = None
            state.pending_approval = None
            state.failure_code = "approval_cancelled"
            state, event = self._record(
                state,
                EventKind.SESSION_CANCELLED,
                {"reason": "approval_cancelled"},
            )
            events.append(event)
            return state, tuple(events)
        if approval == ApprovalDecision.DENY_ONCE:
            state.observations.append(ToolResult(call.call_id, "denied", "Tool call denied by approval policy."))
            state.pending_call = None
            state.pending_approval = None
            state.stage = Stage.REVIEW
            state = self._save(state)
            return state, tuple(events)
        if approval != ApprovalDecision.ALLOW_ONCE:
            raise ProtocolError("unsupported approval decision")
        state.stage = Stage.OBSERVE
        state = self._save(state)
        return state, tuple(events)

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
    ) -> tuple[ProviderResult, int]:
        tools = await self._tools(token)
        request = self._provider_request(state, tools)
        return await self._bounded_retry(
            lambda: self.provider.complete(request, token),
            RetryableProviderError,
            self.limits.provider_timeout_seconds,
        )

    async def _broker_call(self, call: ToolCall, token: CancellationToken) -> tuple[ToolResult, int]:
        return await self._bounded_retry(
            lambda: self.broker.execute(call, token),
            RetryableBrokerError,
            self.limits.broker_timeout_seconds,
        )

    async def _bounded_retry(
        self,
        operation: Callable[[], Awaitable[object]],
        retryable: type[Exception],
        timeout: float,
    ) -> tuple[object, int]:
        retries = 0
        while True:
            try:
                return await asyncio.wait_for(operation(), timeout=timeout), retries
            except TimeoutError as error:
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
        arguments_bytes = len(canonical_json(call.arguments))
        if arguments_bytes > self.limits.max_tool_arguments_bytes:
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
        return self._save(state), event

    def _save(self, state: SessionState) -> SessionState:
        return self.checkpoints.save(state, expected_revision=state.revision)


def _tool_value(tool: ToolDefinition) -> dict[str, JsonValue]:
    return {"description": tool.description, "inputSchema": tool.input_schema, "name": tool.name}
