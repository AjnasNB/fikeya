# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from fikeya_agent_core import (
    CancellationToken,
    ConfigurationError,
    DecisionKind,
    ProtocolError,
    ProviderRequest,
    RetryableProviderError,
    RuntimeProviderAdapter,
    Stage,
)

RUNTIME_SOURCE = Path(__file__).resolve().parents[2] / "fikeya-runtime" / "src"
sys.path.insert(0, str(RUNTIME_SOURCE))

from fikeya_runtime.errors import ProviderError as RuntimeProviderError  # noqa: E402
from fikeya_runtime.inference import (  # noqa: E402
    CancellationToken as RuntimeCancellationToken,
)
from fikeya_runtime.inference import (  # noqa: E402
    JsonResponse,
    ProviderExecutor,
)
from fikeya_runtime.providers import ProviderKind, build_profile  # noqa: E402


class RuntimeTransport:
    def __init__(self, text: str) -> None:
        self.text = text
        self.authorization: str | None = None

    def post(
        self,
        url: str,
        headers: dict[str, str],
        payload: bytes,
        *,
        timeout: float,
        maximum_response_bytes: int,
        cancellation: RuntimeCancellationToken,
    ) -> JsonResponse:
        del url, payload, timeout, maximum_response_bytes
        cancellation.raise_if_cancelled()
        self.authorization = headers.get("Authorization")
        body: dict[str, object] = {
            "output_text": self.text,
            "usage": {"input_tokens": 11, "output_tokens": 4},
        }
        raw = json.dumps(body, separators=(",", ":")).encode()
        return JsonResponse(200, body, raw)


def request(stage: Stage) -> ProviderRequest:
    return ProviderRequest(
        session_id="session:runtime-compatibility",
        stage=stage,
        prompt="inspect",
        system="return JSON",
        plan="",
        observations=(),
        review_notes="",
        candidate_answer="",
        tools=(),
        max_output_bytes=8_192,
    )


@pytest.mark.asyncio
async def test_adapter_executes_against_the_actual_fikeya_runtime_contract() -> None:
    transport = RuntimeTransport('{"kind":"plan","content":"inspect then test"}')
    profile = build_profile(
        name="compatibility",
        kind=ProviderKind.OPENAI,
        model="test-model",
    )
    supplied = 0

    def credential_supplier() -> str:
        nonlocal supplied
        supplied += 1
        return "ephemeral-token"

    adapter = RuntimeProviderAdapter(
        ProviderExecutor(transport),
        profile,
        credential_supplier,
        allow_network=True,
        timeout_seconds=10,
    )

    result = await adapter.complete(request(Stage.PLAN), CancellationToken())

    assert result.decision.kind == DecisionKind.PLAN
    assert result.usage.input_tokens == 11
    assert transport.authorization == "Bearer ephemeral-token"
    assert supplied == 1
    assert not hasattr(adapter, "_credential")


@pytest.mark.asyncio
async def test_runtime_errors_are_retryable_only_when_the_host_classifier_says_so() -> None:
    profile = build_profile(
        name="native-anthropic",
        kind=ProviderKind.ANTHROPIC,
        model="test-model",
    )
    passthrough = RuntimeProviderAdapter(
        ProviderExecutor(RuntimeTransport("unused")),
        profile,
        lambda: "token",
        allow_network=True,
        is_retryable_error=lambda error: False,
    )
    with pytest.raises(RuntimeProviderError, match="supported text output"):
        await passthrough.complete(request(Stage.PLAN), CancellationToken())

    mapped = RuntimeProviderAdapter(
        ProviderExecutor(RuntimeTransport("unused")),
        profile,
        lambda: "token",
        allow_network=True,
        is_retryable_error=lambda error: isinstance(error, RuntimeProviderError),
    )
    with pytest.raises(RetryableProviderError, match="classified transient"):
        await mapped.complete(request(Stage.PLAN), CancellationToken())


@pytest.mark.parametrize("timeout", [0, 0.09, 300.01, 600, True])
def test_runtime_adapter_rejects_timeouts_the_runtime_will_not_accept(timeout: float) -> None:
    with pytest.raises(ConfigurationError, match="between 0.1 and 300"):
        RuntimeProviderAdapter(
            ProviderExecutor(RuntimeTransport("unused")),
            object(),
            lambda: None,
            allow_network=False,
            timeout_seconds=timeout,
        )


@pytest.mark.parametrize(
    ("stage", "payload"),
    [
        (Stage.PLAN, '{"kind":"plan","content":"p","reviewAction":"complete"}'),
        (Stage.ACT, '{"kind":"answer","content":"a","toolCall":null}'),
        (
            Stage.ACT,
            '{"kind":"tool_call","toolCall":{"callId":"c","name":"t","arguments":{}},"content":"x"}',
        ),
        (Stage.REVIEW, '{"kind":"review","content":"r","reviewAction":"complete","toolCall":null}'),
    ],
)
def test_each_provider_stage_rejects_every_irrelevant_top_level_key(stage: Stage, payload: str) -> None:
    from fikeya_agent_core import decode_provider_decision

    with pytest.raises(ProtocolError, match="keys are not exact"):
        decode_provider_decision(payload, stage)
