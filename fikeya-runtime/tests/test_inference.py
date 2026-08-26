# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import urllib.error

import pytest

from fikeya_runtime.errors import (
    CancellationError,
    ProviderConnectivityError,
    ProviderError,
    ProviderHttpError,
)
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


class StatusTransport(FakeTransport):
    def __init__(self, status_code: int) -> None:
        super().__init__({"error": "not retained by Fikeya"})
        self.status_code = status_code

    def post(self, *args: object, **kwargs: object) -> JsonResponse:
        response = super().post(*args, **kwargs)
        return JsonResponse(
            status_code=self.status_code,
            body=response.body,
            raw_body=response.raw_body,
        )


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


def test_pre_response_connection_failure_is_typed_without_endpoint_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class UnreachableOpener:
        def open(self, *_args: object, **_kwargs: object) -> object:
            raise urllib.error.URLError("private operating-system detail")

    monkeypatch.setattr(
        "fikeya_runtime.inference.urllib.request.build_opener",
        lambda *_handlers: UnreachableOpener(),
    )
    profile = build_profile(
        name="local",
        kind=ProviderKind.OLLAMA,
        model="qwen",
    )

    with pytest.raises(ProviderConnectivityError) as failure:
        ProviderExecutor().execute(
            profile,
            None,
            InferenceRequest("request"),
            allow_network=True,
        )

    assert failure.value.kind == "connectivity"
    assert failure.value.retryable is True
    assert str(failure.value) == (
        "Provider endpoint could not be reached before a response was received."
    )
    assert "private operating-system detail" not in str(failure.value)


def test_http_quota_failure_is_typed_without_retaining_the_body() -> None:
    profile = build_profile(
        name="work",
        kind=ProviderKind.OPENAI,
        model="gpt-example",
    )
    with pytest.raises(ProviderHttpError) as failure:
        ProviderExecutor(StatusTransport(429)).execute(
            profile,
            "credential",
            InferenceRequest("request"),
            allow_network=True,
        )
    assert failure.value.status_code == 429
    assert failure.value.kind == "quota"
    assert failure.value.retryable is True
    assert "not retained" in str(failure.value)


def test_anthropic_messages_execution_uses_native_contract_and_usage() -> None:
    transport = FakeTransport(
        {
            "content": [
                {"type": "text", "text": "First sentence. "},
                {"type": "thinking", "thinking": "not returned"},
                {"type": "text", "text": "Second sentence."},
            ],
            "usage": {
                "cache_creation_input_tokens": 3,
                "cache_read_input_tokens": 12,
                "input_tokens": 72,
                "output_tokens": 18,
            },
        }
    )
    profile = build_profile(
        name="anthropic",
        kind=ProviderKind.ANTHROPIC,
        model="claude-example",
    )

    result = ProviderExecutor(transport).execute(
        profile,
        "credential",
        InferenceRequest(
            "Review the patch.",
            system="Return only verified findings.",
            max_output_tokens=512,
        ),
        allow_network=True,
    )

    call = transport.calls[0]
    assert call["url"] == "https://api.anthropic.com/v1/messages"
    assert call["headers"]["x-api-key"] == "credential"
    assert call["headers"]["anthropic-version"] == "2023-06-01"
    assert call["payload"] == {
        "max_tokens": 512,
        "messages": [{"content": "Review the patch.", "role": "user"}],
        "model": "claude-example",
        "system": "Return only verified findings.",
    }
    assert result.text == "First sentence. Second sentence."
    assert result.usage.measurement == "provider-reported"
    assert result.usage.input_tokens == 87
    assert result.usage.output_tokens == 18
    assert result.usage.cached_input_tokens == 12
