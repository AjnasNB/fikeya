# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json

import pytest

from fikeya_runtime.errors import CancellationError, ProviderError
from fikeya_runtime.inference import (
    CancellationToken,
    InferenceRequest,
    JsonResponse,
    ProviderExecutor,
)
from fikeya_runtime.providers import ProviderKind, build_profile


class FakeTransport:
    def __init__(self, body: dict[str, object]) -> None:
        self.body = body
        self.calls: list[dict[str, object]] = []

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
        self.calls.append(
            {
                "headers": headers,
                "maximum": maximum_response_bytes,
                "payload": json.loads(payload),
                "timeout": timeout,
                "url": url,
            }
        )
        raw = json.dumps(self.body, separators=(",", ":")).encode()
        return JsonResponse(status_code=200, body=self.body, raw_body=raw)


def test_azure_responses_execution_normalizes_usage_and_url() -> None:
    transport = FakeTransport(
        {
            "output_text": "bounded answer",
            "usage": {
                "input_tokens": 18,
                "input_tokens_details": {"cached_tokens": 4},
                "output_tokens": 7,
            },
        }
    )
    profile = build_profile(
        name="azure",
        kind=ProviderKind.AZURE_OPENAI,
        base_url="https://example.openai.azure.com",
        model="deployment",
    )

    result = ProviderExecutor(transport).execute(
        profile,
        "short-lived-token",
        InferenceRequest("Summarize this change.", system="Be concise."),
        allow_network=True,
    )

    call = transport.calls[0]
    assert result.text == "bounded answer"
    assert result.usage.measurement == "provider-reported"
    assert result.usage.input_tokens == 18
    assert result.usage.output_tokens == 7
    assert result.usage.cached_input_tokens == 4
    assert call["url"] == "https://example.openai.azure.com/openai/v1/responses"
    assert call["headers"]["Authorization"] == "Bearer short-lived-token"
    assert call["payload"]["model"] == "deployment"
    assert result.request_sha256.startswith("sha256:")
    assert result.response_sha256.startswith("sha256:")


def test_chat_completions_handles_missing_usage_honestly() -> None:
    transport = FakeTransport({"choices": [{"message": {"content": "local answer"}}]})
    profile = build_profile(
        name="local",
        kind=ProviderKind.OLLAMA,
        model="qwen",
    )

    result = ProviderExecutor(transport).execute(
        profile,
        None,
        InferenceRequest("Inspect this repository."),
        allow_network=True,
    )

    assert transport.calls[0]["url"] == "http://127.0.0.1:11434/v1/chat/completions"
    assert result.text == "local answer"
    assert result.usage.measurement == "unavailable"
    assert result.usage.input_tokens is None


def test_execution_requires_opt_in_and_honors_preflight_cancellation() -> None:
    transport = FakeTransport({"output_text": "unused"})
    profile = build_profile(
        name="work",
        kind=ProviderKind.OPENAI,
        model="gpt-example",
    )
    executor = ProviderExecutor(transport)

    with pytest.raises(ProviderError, match="denied"):
        executor.execute(
            profile,
            "credential",
            InferenceRequest("request"),
            allow_network=False,
        )

    cancellation = CancellationToken()
    cancellation.cancel()
    with pytest.raises(CancellationError, match="cancelled"):
        executor.execute(
            profile,
            "credential",
            InferenceRequest("request"),
            allow_network=True,
            cancellation=cancellation,
        )
    assert transport.calls == []


def test_native_provider_is_explicitly_not_claimed_as_implemented() -> None:
    profile = build_profile(
        name="anthropic",
        kind=ProviderKind.ANTHROPIC,
        model="claude-example",
    )
    with pytest.raises(ProviderError, match="not shipped"):
        ProviderExecutor(FakeTransport({})).execute(
            profile,
            "credential",
            InferenceRequest("request"),
            allow_network=True,
        )
