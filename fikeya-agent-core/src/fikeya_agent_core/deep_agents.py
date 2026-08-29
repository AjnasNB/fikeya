# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Optional Deep Agents and LangGraph compatibility behind Fikeya boundaries.

The graph used here is a decision engine, not an execution engine. It receives
JSON data and broker-owned tool *descriptions*, but never callable tools, an
execution broker, a shell, or filesystem access. Any tool request it returns is
decoded as a normal :class:`ProviderDecision` and therefore goes through the
native Fikeya checkpoint, exact approval, lease, and broker flow.

Hosts must not pass a graph that was constructed with Deep Agents' default
filesystem or shell tools. Graph-native interrupts are rejected because they
would create a second approval/execution boundary outside Fikeya.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import importlib.util
import sys
from contextlib import suppress
from dataclasses import dataclass
from typing import Protocol

from .cancellation import CancellationToken
from .checkpoints import CheckpointStore
from .engine import AgentOrchestrator
from .errors import CancellationError, ConfigurationError, ProtocolError
from .models import (
    AgentEvent,
    AgentLimits,
    ApprovalDecision,
    ApprovalResponse,
    EvidenceContext,
    JsonValue,
    ProviderRequest,
    ProviderResult,
    ProviderUsage,
    SessionState,
    Stage,
    canonical_json,
    sha256_value,
)
from .protocols import ExecutionBroker
from .provider import decode_provider_decision, render_provider_prompt


class DeepAgentsGraph(Protocol):
    """Narrow subset of a compiled LangGraph used for decision generation."""

    async def ainvoke(
        self,
        input: dict[str, JsonValue],
        config: dict[str, object],
    ) -> object: ...


@dataclass(frozen=True, slots=True)
class DeepAgentsDependencyStatus:
    """Availability of the optional upstream packages without importing them."""

    deepagents: bool
    langgraph: bool
    python_supported: bool

    @property
    def available(self) -> bool:
        """Return whether both packages needed by a real graph are importable."""

        return self.python_supported and self.deepagents and self.langgraph


@dataclass(frozen=True, slots=True)
class DeepAgentsIntegrationDiagnostic:
    """Content-free support report for CLI, Desktop, and host diagnostics."""

    adapter_api_version: int
    dependencies: DeepAgentsDependencyStatus
    deepagents_version: str | None
    langgraph_version: str | None
    graph_supplied: bool
    graph_compatible: bool
    install_extra: str
    tool_boundary: str

    def as_json(self) -> dict[str, JsonValue]:
        """Return a stable JSON representation without model or workspace data."""

        return {
            "adapterApiVersion": self.adapter_api_version,
            "dependencies": {
                "available": self.dependencies.available,
                "deepagents": self.dependencies.deepagents,
                "langgraph": self.dependencies.langgraph,
                "pythonSupported": self.dependencies.python_supported,
            },
            "deepagentsVersion": self.deepagents_version,
            "graphCompatible": self.graph_compatible,
            "graphSupplied": self.graph_supplied,
            "installExtra": self.install_extra,
            "langgraphVersion": self.langgraph_version,
            "toolBoundary": self.tool_boundary,
        }


@dataclass(frozen=True, slots=True)
class DeepAgentsCheckpointRef:
    """Deterministic translation from a Fikeya request to LangGraph identity."""

    session_id: str
    thread_id: str
    checkpoint_namespace: str
    request_sha256: str

    @classmethod
    def from_request(cls, request: ProviderRequest) -> DeepAgentsCheckpointRef:
        """Derive stable, non-content checkpoint identifiers for one request."""

        thread_digest = sha256_value({"fikeyaSessionId": request.session_id})
        request_digest = sha256_value(_request_identity(request))
        return cls(
            session_id=request.session_id,
            thread_id=f"fikeya-{thread_digest}",
            checkpoint_namespace=f"provider/{request.stage.value}",
            request_sha256=request_digest,
        )


@dataclass(frozen=True, slots=True)
class DeepAgentsSession:
    """Public session handle joining native and graph checkpoint identities."""

    session_id: str
    graph_thread_id: str


@dataclass(frozen=True, slots=True)
class DeepAgentsInterrupt:
    """A durable Fikeya approval pause caused by a graph-proposed tool call."""

    session_id: str
    request_id: str
    call_id: str
    tool_name: str
    arguments_sha256: str
    expected_revision: int
    graph_thread_id: str


def deep_agents_dependency_status() -> DeepAgentsDependencyStatus:
    """Inspect optional packages without importing or initializing either one."""

    return DeepAgentsDependencyStatus(
        deepagents=_module_available("deepagents"),
        langgraph=_module_available("langgraph"),
        python_supported=sys.version_info >= (3, 11),
    )


def require_deep_agents_dependencies() -> None:
    """Fail with an actionable error when a host requests the optional runtime."""

    status = deep_agents_dependency_status()
    if status.available:
        return
    if not status.python_supported:
        raise ConfigurationError(
            "Optional Deep Agents support requires Python 3.11 or newer; "
            "the dependency-free native Fikeya engine continues to support Python 3.10"
        )
    missing = [
        name
        for name, present in (("deepagents", status.deepagents), ("langgraph", status.langgraph))
        if not present
    ]
    raise ConfigurationError(
        "Optional Deep Agents support is unavailable; install fikeya-agent-core[deep-agents] "
        "or add the missing package(s) to the host environment: "
        + ", ".join(missing)
    )


def deep_agents_diagnostic(graph: object | None = None) -> DeepAgentsIntegrationDiagnostic:
    """Report installed support and whether one host-supplied graph is compatible."""

    dependencies = deep_agents_dependency_status()
    supplied = graph is not None
    return DeepAgentsIntegrationDiagnostic(
        adapter_api_version=1,
        dependencies=dependencies,
        deepagents_version=_module_version("deepagents") if dependencies.deepagents else None,
        langgraph_version=_module_version("langgraph") if dependencies.langgraph else None,
        graph_supplied=supplied,
        graph_compatible=supplied and callable(getattr(graph, "ainvoke", None)),
        install_extra="fikeya-agent-core[deep-agents]",
        tool_boundary="fikeya-propose-only",
    )


class DeepAgentsProviderAdapter:
    """Use a graph as a structured Fikeya decision provider, never as a tool host."""

    def __init__(
        self,
        graph: DeepAgentsGraph,
        *,
        provider_name: str = "deep-agents",
        model_name: str = "host-configured",
    ) -> None:
        if not callable(getattr(graph, "ainvoke", None)):
            raise ConfigurationError("Deep Agents graph must provide an async ainvoke method")
        if not provider_name or not model_name:
            raise ConfigurationError("Deep Agents provider and model names cannot be empty")
        self._graph = graph
        self._provider_name = provider_name
        self._model_name = model_name

    async def complete(self, request: ProviderRequest, cancellation: CancellationToken) -> ProviderResult:
        """Ask the graph for one decision while preserving Fikeya as action owner."""

        cancellation.raise_if_cancelled()
        checkpoint = DeepAgentsCheckpointRef.from_request(request)
        payload = _graph_input(request, checkpoint)
        config: dict[str, object] = {
            "configurable": {
                "thread_id": checkpoint.thread_id,
                "checkpoint_ns": checkpoint.checkpoint_namespace,
            },
            "metadata": {
                "fikeya_checkpoint_id": checkpoint.request_sha256,
                "fikeya_tool_boundary": "propose-only",
            },
        }
        result = await _invoke_cancellable(self._graph, payload, config, cancellation)
        if _contains_graph_interrupt(result):
            raise ProtocolError(
                "Deep Agents graph-native interrupts are not an execution boundary; "
                "return a Fikeya tool_call decision so the native approval and broker can handle it"
            )
        decision_payload = _extract_decision_payload(result)
        decision = decode_provider_decision(decision_payload, request.stage)
        return ProviderResult(
            decision=decision,
            provider_name=self._provider_name,
            model_name=self._model_name,
            usage=_extract_usage(result),
        )


class DeepAgentsCompatibilityAdapter:
    """Host-facing interrupt, resume, and cancel facade over native orchestration."""

    def __init__(
        self,
        graph: DeepAgentsGraph,
        broker: ExecutionBroker,
        checkpoints: CheckpointStore,
        limits: AgentLimits | None = None,
        *,
        provider_name: str = "deep-agents",
        model_name: str = "host-configured",
    ) -> None:
        provider = DeepAgentsProviderAdapter(
            graph,
            provider_name=provider_name,
            model_name=model_name,
        )
        self._orchestrator = AgentOrchestrator(provider, broker, checkpoints, limits)

    def start(
        self,
        prompt: str,
        *,
        evidence: EvidenceContext | None = None,
        session_id: str | None = None,
    ) -> DeepAgentsSession:
        """Create the canonical Fikeya checkpoint and its graph thread mapping."""

        state = self._orchestrator.start(prompt, evidence=evidence, session_id=session_id)
        thread_digest = sha256_value({"fikeyaSessionId": state.session_id})
        return DeepAgentsSession(state.session_id, f"fikeya-{thread_digest}")

    def state(self, session_id: str) -> SessionState:
        """Return the validated native checkpoint state."""

        return self._orchestrator.state(session_id)

    async def stream(
        self,
        session_id: str,
        *,
        cancellation: CancellationToken | None = None,
        after_sequence: int | None = None,
    ):
        """Advance until completion or a durable Fikeya approval interrupt."""

        async for event in self._orchestrator.stream(
            session_id,
            cancellation=cancellation,
            after_sequence=after_sequence,
        ):
            yield event

    def interrupt(self, session_id: str) -> DeepAgentsInterrupt | None:
        """Describe the current durable approval pause without exposing arguments."""

        state = self._orchestrator.state(session_id)
        request = state.pending_approval
        if state.stage != Stage.AWAITING_APPROVAL or request is None:
            return None
        thread_digest = sha256_value({"fikeyaSessionId": state.session_id})
        return DeepAgentsInterrupt(
            session_id=request.session_id,
            request_id=request.request_id,
            call_id=request.call_id,
            tool_name=request.tool_name,
            arguments_sha256=request.arguments_sha256,
            expected_revision=request.expected_revision,
            graph_thread_id=f"fikeya-{thread_digest}",
        )

    async def resume(
        self,
        session_id: str,
        decision: ApprovalDecision,
        *,
        cancellation: CancellationToken | None = None,
        after_sequence: int | None = None,
    ):
        """Resolve one exact interrupt and continue through the native broker."""

        state = self._orchestrator.state(session_id)
        request = state.pending_approval
        if state.stage != Stage.AWAITING_APPROVAL or request is None:
            raise ProtocolError("Deep Agents session has no Fikeya approval interrupt to resume")
        response = ApprovalResponse(
            request_id=request.request_id,
            session_id=request.session_id,
            call_id=request.call_id,
            tool_name=request.tool_name,
            arguments_sha256=request.arguments_sha256,
            expected_revision=request.expected_revision,
            decision=decision,
        )
        async for event in self._orchestrator.stream(
            session_id,
            approval=response,
            cancellation=cancellation,
            after_sequence=after_sequence,
        ):
            yield event

    def cancel(self, session_id: str) -> AgentEvent | None:
        """Cancel active graph work cooperatively or persist idle cancellation."""

        return self._orchestrator.cancel(session_id)


async def _invoke_cancellable(
    graph: DeepAgentsGraph,
    payload: dict[str, JsonValue],
    config: dict[str, object],
    cancellation: CancellationToken,
) -> object:
    invocation = graph.ainvoke(payload, config=config)
    if not hasattr(invocation, "__await__"):
        raise ProtocolError("Deep Agents graph ainvoke must return an awaitable")
    task = asyncio.create_task(invocation)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=0.025)
            if task in done:
                return task.result()
            if cancellation.cancelled:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
                raise CancellationError("Deep Agents graph invocation was cancelled")
    except asyncio.CancelledError:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        raise


def _graph_input(
    request: ProviderRequest,
    checkpoint: DeepAgentsCheckpointRef,
) -> dict[str, JsonValue]:
    return {
        "messages": [
            {"role": "system", "content": request.system},
            {"role": "user", "content": render_provider_prompt(request)},
        ],
        "fikeya": {
            "checkpointId": checkpoint.request_sha256,
            "stage": request.stage.value,
            "toolBoundary": "propose-only",
        },
    }


def _request_identity(request: ProviderRequest) -> dict[str, JsonValue]:
    return {
        "candidateAnswer": request.candidate_answer,
        "maxOutputBytes": request.max_output_bytes,
        "observations": [
            {
                "callId": item.call_id,
                "contentType": item.content_type,
                "outputSha256": sha256_value(item.output),
                "status": item.status,
            }
            for item in request.observations
        ],
        "plan": request.plan,
        "prompt": request.prompt,
        "reviewNotes": request.review_notes,
        "sessionId": request.session_id,
        "stage": request.stage.value,
        "system": request.system,
        "tools": [
            {
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "name": tool.name,
            }
            for tool in request.tools
        ],
    }


def _extract_decision_payload(result: object) -> str:
    if isinstance(result, str):
        return result
    if not isinstance(result, dict):
        raise ProtocolError("Deep Agents graph must return a string or object")

    for key in ("fikeya_decision", "structured_response", "output"):
        value = result.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            try:
                return canonical_json(value).decode("utf-8")
            except (TypeError, ValueError) as error:
                raise ProtocolError("Deep Agents decision must be JSON serializable") from error

    messages = result.get("messages")
    if isinstance(messages, list) and messages:
        content = _message_content(messages[-1])
        if content is not None:
            return content
    raise ProtocolError("Deep Agents graph result did not contain a Fikeya decision")


def _message_content(message: object) -> str | None:
    if isinstance(message, dict):
        content = message.get("content")
        return content if isinstance(content, str) else None
    content = getattr(message, "content", None)
    return content if isinstance(content, str) else None


def _contains_graph_interrupt(result: object) -> bool:
    if not isinstance(result, dict):
        return False
    legacy = result.get("__interrupt__")
    if isinstance(legacy, (list, tuple)) and legacy:
        return True
    interrupts = result.get("interrupts")
    return isinstance(interrupts, (list, tuple)) and bool(interrupts)


def _extract_usage(result: object) -> ProviderUsage:
    if not isinstance(result, dict):
        return ProviderUsage()
    usage = result.get("usage")
    if not isinstance(usage, dict):
        return ProviderUsage()
    return ProviderUsage(
        input_tokens=_non_negative_integer(usage.get("input_tokens")),
        output_tokens=_non_negative_integer(usage.get("output_tokens")),
        cached_input_tokens=_non_negative_integer(usage.get("cached_input_tokens")),
    )


def _non_negative_integer(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _module_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None
