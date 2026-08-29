# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator

import pytest

from fikeya_agent_core import (
    AgentEvent,
    ApprovalDecision,
    CancellationToken,
    ConfigurationError,
    EventKind,
    InMemoryCheckpointStore,
    LimitExceededError,
    ProtocolError,
    Stage,
    ToolCall,
    ToolDefinition,
    ToolResult,
)
from fikeya_agent_core.deep_agents import (
    DeepAgentsCheckpointRef,
    DeepAgentsCompatibilityAdapter,
    DeepAgentsProviderAdapter,
    deep_agents_dependency_status,
    require_deep_agents_dependencies,
)
from fikeya_agent_core.models import ProviderRequest


class FakeGraph:
    def __init__(self, *results: object) -> None:
        self.results = deque(results)
        self.inputs: list[dict[str, object]] = []
        self.configs: list[dict[str, object]] = []

    async def ainvoke(self, input: dict[str, object], config: dict[str, object]) -> object:
        self.inputs.append(input)
        self.configs.append(config)
        return self.results.popleft()


class BlockingGraph:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def ainvoke(self, input: dict[str, object], config: dict[str, object]) -> object:
        del input, config
        self.started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


class RecordingBroker:
    def __init__(self) -> None:
        self.calls: list[tuple[ToolCall, str]] = []

    async def list_tools(self, cancellation: CancellationToken) -> tuple[ToolDefinition, ...]:
        cancellation.raise_if_cancelled()
        return (
            ToolDefinition(
                "repo:read",
                "Read one repository file through the root-bound broker",
                {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": False,
                },
            ),
        )

    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        cancellation.raise_if_cancelled()
        self.calls.append((call, idempotency_key))
        return ToolResult(call.call_id, "ok", "bounded broker output")


async def collect(events: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in events]


def decision(kind: str, **values: object) -> dict[str, object]:
    return {"fikeya_decision": {"kind": kind, **values}}


def provider_request(stage: Stage = Stage.PLAN) -> ProviderRequest:
    return ProviderRequest(
        session_id="session:deep-agents-checkpoint",
        stage=stage,
        prompt="inspect through the broker",
        system="return one structured decision",
        plan="",
        observations=(),
        review_notes="",
        candidate_answer="",
        tools=(ToolDefinition("repo:read", "Read a file", {"type": "object"}),),
        max_output_bytes=8_192,
    )


def test_dependency_probe_is_clean_and_missing_packages_are_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(name: str) -> None:
        del name
        return None

    monkeypatch.setattr("fikeya_agent_core.deep_agents.importlib.util.find_spec", missing)
    monkeypatch.setattr("fikeya_agent_core.deep_agents.sys.version_info", (3, 11))

    status = deep_agents_dependency_status()

    assert status.available is False
    assert status.deepagents is False
    assert status.langgraph is False
    with pytest.raises(ConfigurationError, match="deepagents, langgraph"):
        require_deep_agents_dependencies()


def test_checkpoint_translation_is_stable_scoped_and_does_not_disclose_session_id() -> None:
    request = provider_request()

    first = DeepAgentsCheckpointRef.from_request(request)
    second = DeepAgentsCheckpointRef.from_request(request)
    act = DeepAgentsCheckpointRef.from_request(provider_request(Stage.ACT))

    assert first == second
    assert first.thread_id.startswith("fikeya-")
    assert request.session_id not in first.thread_id
    assert len(first.request_sha256) == 64
    assert first.checkpoint_namespace == "provider/plan"
    assert act.checkpoint_namespace == "provider/act"
    assert act.request_sha256 != first.request_sha256


@pytest.mark.asyncio
async def test_graph_tool_attempt_can_only_reach_broker_after_exact_fikeya_approval() -> None:
    graph = FakeGraph(
        decision("plan", content="read once, then review"),
        decision(
            "tool_call",
            toolCall={
                "callId": "call:deep-agents-read",
                "name": "repo:read",
                "arguments": {"path": "README.md"},
            },
        ),
        decision("review", content="Brokered read verified.", reviewAction="complete"),
    )
    broker = RecordingBroker()
    adapter = DeepAgentsCompatibilityAdapter(graph, broker, InMemoryCheckpointStore())
    session = adapter.start("Read README.md safely.", session_id="session:deep-agents-tool")

    paused = await collect(adapter.stream(session.session_id))

    assert paused[-1].kind == EventKind.APPROVAL_REQUESTED
    assert broker.calls == []
    interrupt = adapter.interrupt(session.session_id)
    assert interrupt is not None
    assert interrupt.tool_name == "repo:read"
    assert len(interrupt.arguments_sha256) == 64
    assert session.graph_thread_id == interrupt.graph_thread_id

    completed = await collect(adapter.resume(session.session_id, ApprovalDecision.ALLOW_ONCE))

    assert completed[-1].kind == EventKind.SESSION_COMPLETED
    assert adapter.state(session.session_id).stage == Stage.COMPLETED
    assert len(broker.calls) == 1
    assert broker.calls[0][0].arguments == {"path": "README.md"}
    assert len(broker.calls[0][1]) == 64

    for graph_input in graph.inputs:
        assert "broker" not in graph_input
        assert "shell" not in graph_input
        assert "filesystem" not in graph_input
        assert not _contains_callable(graph_input)
    assert len({config["configurable"]["thread_id"] for config in graph.configs}) == 1  # type: ignore[index]
    assert all(
        config["metadata"]["fikeya_tool_boundary"] == "propose-only"  # type: ignore[index]
        for config in graph.configs
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result",
    [
        "x" * 8_193,
        {"fikeya_decision": {"kind": "plan", "content": "x" * 8_193}},
        {"messages": [{"content": "x" * 8_193}]},
    ],
)
async def test_graph_output_is_bounded_before_decoding(result: object) -> None:
    adapter = DeepAgentsProviderAdapter(FakeGraph(result))

    with pytest.raises(LimitExceededError, match="configured byte limit"):
        await adapter.complete(provider_request(), CancellationToken())


@pytest.mark.asyncio
async def test_graph_native_tool_interrupt_is_rejected_without_touching_broker() -> None:
    graph = FakeGraph(
        {
            "__interrupt__": [
                {
                    "value": {
                        "action_requests": [
                            {"name": "execute", "args": {"command": "unbrokered command"}},
                        ]
                    }
                }
            ]
        }
    )
    broker = RecordingBroker()
    adapter = DeepAgentsCompatibilityAdapter(graph, broker, InMemoryCheckpointStore())
    session = adapter.start("Never bypass the broker.", session_id="session:deep-agents-native-interrupt")

    with pytest.raises(ProtocolError, match="not an execution boundary"):
        await collect(adapter.stream(session.session_id))

    assert broker.calls == []
    assert adapter.state(session.session_id).stage == Stage.FAILED


@pytest.mark.asyncio
async def test_active_graph_invocation_is_cancelled_through_native_session_token() -> None:
    graph = BlockingGraph()
    adapter = DeepAgentsCompatibilityAdapter(graph, RecordingBroker(), InMemoryCheckpointStore())
    session = adapter.start("Wait until cancelled.", session_id="session:deep-agents-cancel")
    task = asyncio.create_task(collect(adapter.stream(session.session_id)))
    await graph.started.wait()

    immediate = adapter.cancel(session.session_id)
    events = await asyncio.wait_for(task, timeout=2)

    assert immediate is None
    assert graph.cancelled.is_set()
    assert events[-1].kind == EventKind.SESSION_CANCELLED
    assert adapter.state(session.session_id).stage == Stage.CANCELLED


@pytest.mark.asyncio
async def test_decision_provider_accepts_message_output_and_reports_optional_usage() -> None:
    graph = FakeGraph(
        {
            "messages": [{"role": "assistant", "content": '{"kind":"plan","content":"bounded plan"}'}],
            "usage": {"input_tokens": 17, "output_tokens": 5, "cached_input_tokens": 3},
        }
    )
    provider = DeepAgentsProviderAdapter(graph, provider_name="deep-agents-test", model_name="fake-model")

    result = await provider.complete(provider_request(), CancellationToken())

    assert result.decision.content == "bounded plan"
    assert result.provider_name == "deep-agents-test"
    assert result.model_name == "fake-model"
    assert (result.usage.input_tokens, result.usage.output_tokens, result.usage.cached_input_tokens) == (17, 5, 3)


def _contains_callable(value: object) -> bool:
    if callable(value):
        return True
    if isinstance(value, dict):
        return any(_contains_callable(key) or _contains_callable(item) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_callable(item) for item in value)
    return False
