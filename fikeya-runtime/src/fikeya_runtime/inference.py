# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Bounded OpenAI-compatible inference with content-free call receipts."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from .errors import CancellationError, ConfigurationError, ProviderError
from .providers import ProviderKind, ProviderProfile, provider_headers
from .util import sha256_bytes, stable_json

MAX_REQUEST_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 4_194_304


class CancellationToken:
    """Thread-safe cooperative cancellation shared by CLI and transports."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        """Request cancellation without blocking the signal handler."""

        self._event.set()

    @property
    def cancelled(self) -> bool:
        """Return whether cancellation has been requested."""

        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        """Stop at the next cooperative boundary."""

        if self.cancelled:
            raise CancellationError("Provider operation was cancelled.")


@dataclass(frozen=True, slots=True)
class InferenceRequest:
    """One bounded text request; callers retain ownership of its content."""

    prompt: str
    system: str | None = None
    max_output_tokens: int = 1_024
    temperature: float | None = None

    def __post_init__(self) -> None:
        if not self.prompt or len(self.prompt.encode("utf-8")) > MAX_REQUEST_BYTES:
            raise ConfigurationError(
                f"Prompt must be non-empty and at most {MAX_REQUEST_BYTES} UTF-8 bytes."
            )
        if (
            self.system is not None
            and len(self.system.encode("utf-8")) > MAX_REQUEST_BYTES
        ):
            raise ConfigurationError(
                f"System instructions cannot exceed {MAX_REQUEST_BYTES} UTF-8 bytes."
            )
        if not 1 <= self.max_output_tokens <= 32_768:
            raise ConfigurationError("max_output_tokens must be between 1 and 32768.")
        if self.temperature is not None and not 0 <= self.temperature <= 2:
            raise ConfigurationError("temperature must be between 0 and 2.")


@dataclass(frozen=True, slots=True)
class ProviderUsage:
    """Exact provider-reported token fields, or an explicit unavailable state."""

    measurement: str
    input_tokens: int | None
    output_tokens: int | None
    cached_input_tokens: int | None


@dataclass(frozen=True, slots=True)
class ProviderCallResult:
    """Live model output plus metadata safe for a content-free receipt."""

    text: str
    status_code: int
    duration_ms: int
    request_sha256: str
    response_sha256: str
    request_bytes: int
    response_bytes: int
    usage: ProviderUsage


@dataclass(frozen=True, slots=True)
class ProviderRequestFingerprint:
    """Content-free identity of the exact serialized provider request."""

    request_sha256: str
    request_bytes: int


@dataclass(frozen=True, slots=True)
class JsonResponse:
    """A bounded decoded HTTP response used by injectable transports."""

    status_code: int
    body: dict[str, object]
    raw_body: bytes


class JsonTransport(Protocol):
    """Minimal transport contract for deterministic provider tests."""

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
        """Post JSON and return a bounded object response."""


class UrllibJsonTransport:
    """Dependency-free HTTPS transport with redirect and response-size controls."""

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
        cancellation.raise_if_cancelled()
        request_headers = dict(headers)
        request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            url,
            headers=request_headers,
            data=payload,
            method="POST",
        )
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            with opener.open(request, timeout=timeout) as response:
                declared_length = response.headers.get("Content-Length")
                if (
                    declared_length is not None
                    and int(declared_length) > maximum_response_bytes
                ):
                    raise ProviderError(
                        "Provider response exceeds the configured byte limit."
                    )
                chunks: list[bytes] = []
                total = 0
                while True:
                    cancellation.raise_if_cancelled()
                    chunk = response.read(
                        min(65_536, maximum_response_bytes - total + 1)
                    )
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > maximum_response_bytes:
                        raise ProviderError(
                            "Provider response exceeds the configured byte limit."
                        )
                    chunks.append(chunk)
                raw_body = b"".join(chunks)
                status = int(response.status)
        except urllib.error.HTTPError as error:
            error.close()
            raise ProviderError(
                f"Provider returned HTTP {error.code}; response body was not retained."
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise ProviderError(
                "Provider request failed before a response was received."
            ) from error
        cancellation.raise_if_cancelled()
        try:
            decoded = json.loads(raw_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProviderError(
                "Provider returned an invalid JSON response."
            ) from error
        if not isinstance(decoded, dict):
            raise ProviderError("Provider JSON response must be an object.")
        return JsonResponse(status_code=status, body=decoded, raw_body=raw_body)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> urllib.request.Request | None:
        return None


class ProviderExecutor:
    """Execute one explicit OpenAI-compatible call without persisting content."""

    def __init__(self, transport: JsonTransport | None = None) -> None:
        self.transport = transport or UrllibJsonTransport()

    def execute(
        self,
        profile: ProviderProfile,
        credential: str | None,
        request: InferenceRequest,
        *,
        allow_network: bool,
        timeout: float = 60.0,
        maximum_response_bytes: int = MAX_RESPONSE_BYTES,
        cancellation: CancellationToken | None = None,
    ) -> ProviderCallResult:
        """Return output and exact usage only after explicit network authorization."""

        if not allow_network:
            raise ProviderError(
                "Model execution denied. Pass --allow-network explicitly."
            )
        if not 0.1 <= timeout <= 300:
            raise ConfigurationError(
                "Provider timeout must be between 0.1 and 300 seconds."
            )
        if not 1 <= maximum_response_bytes <= 16_777_216:
            raise ConfigurationError(
                "maximum_response_bytes is outside the safe range."
            )
        if profile.api_mode == "native":
            raise ProviderError(
                f"Native {profile.kind.value} execution is not shipped in this runtime slice."
            )
        token = cancellation or CancellationToken()
        token.raise_if_cancelled()
        url = _execution_url(profile)
        payload_object = _request_payload(profile, request)
        payload = stable_json(payload_object).encode("utf-8")
        if len(payload) > MAX_REQUEST_BYTES:
            raise ConfigurationError(
                f"Serialized provider request exceeds {MAX_REQUEST_BYTES} bytes."
            )
        headers = provider_headers(profile, credential)
        start = time.monotonic()
        response = self.transport.post(
            url,
            headers,
            payload,
            timeout=timeout,
            maximum_response_bytes=maximum_response_bytes,
            cancellation=token,
        )
        duration_ms = max(0, round((time.monotonic() - start) * 1_000))
        token.raise_if_cancelled()
        if len(response.raw_body) > maximum_response_bytes:
            raise ProviderError("Provider response exceeds the configured byte limit.")
        if response.status_code < 200 or response.status_code >= 300:
            raise ProviderError(
                f"Provider returned HTTP {response.status_code}; response body was not retained."
            )
        text = _response_text(profile.api_mode, response.body)
        usage = _provider_usage(profile.api_mode, response.body)
        return ProviderCallResult(
            text=text,
            status_code=response.status_code,
            duration_ms=duration_ms,
            request_sha256=sha256_bytes(payload),
            response_sha256=sha256_bytes(response.raw_body),
            request_bytes=len(payload),
            response_bytes=len(response.raw_body),
            usage=usage,
        )


def provider_request_fingerprint(
    profile: ProviderProfile,
    request: InferenceRequest,
) -> ProviderRequestFingerprint:
    """Hash the exact request representation without retaining its content."""

    payload = stable_json(_request_payload(profile, request)).encode("utf-8")
    if len(payload) > MAX_REQUEST_BYTES:
        raise ConfigurationError(
            f"Serialized provider request exceeds {MAX_REQUEST_BYTES} bytes."
        )
    return ProviderRequestFingerprint(
        request_sha256=sha256_bytes(payload),
        request_bytes=len(payload),
    )


def _execution_url(profile: ProviderProfile) -> str:
    base_url = profile.base_url.rstrip("/")
    if profile.kind == ProviderKind.AZURE_OPENAI and not base_url.endswith(
        "/openai/v1"
    ):
        base_url = f"{base_url}/openai/v1"
    endpoint = "responses" if profile.api_mode == "responses" else "chat/completions"
    return f"{base_url}/{endpoint}"


def _request_payload(
    profile: ProviderProfile,
    request: InferenceRequest,
) -> dict[str, object]:
    if profile.api_mode == "responses":
        payload: dict[str, object] = {
            "input": request.prompt,
            "max_output_tokens": request.max_output_tokens,
            "model": profile.model,
        }
        if request.system is not None:
            payload["instructions"] = request.system
    else:
        messages: list[dict[str, str]] = []
        if request.system is not None:
            messages.append({"content": request.system, "role": "system"})
        messages.append({"content": request.prompt, "role": "user"})
        payload = {
            "max_tokens": request.max_output_tokens,
            "messages": messages,
            "model": profile.model,
        }
    if request.temperature is not None:
        payload["temperature"] = request.temperature
    return payload


def _response_text(api_mode: str, body: dict[str, object]) -> str:
    if api_mode == "responses":
        output_text = body.get("output_text")
        if isinstance(output_text, str) and output_text:
            return output_text
        output = body.get("output")
        if isinstance(output, list):
            pieces: list[str] = []
            for item in output:
                if not isinstance(item, dict) or not isinstance(
                    item.get("content"), list
                ):
                    continue
                for content in item["content"]:
                    if isinstance(content, dict) and isinstance(
                        content.get("text"), str
                    ):
                        pieces.append(content["text"])
            if pieces:
                return "".join(pieces)
    else:
        choices = body.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            message = choices[0].get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"]
    raise ProviderError("Provider response does not contain a supported text output.")


def _provider_usage(api_mode: str, body: dict[str, object]) -> ProviderUsage:
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return ProviderUsage("unavailable", None, None, None)
    if api_mode == "responses":
        input_tokens = _non_negative_int(usage.get("input_tokens"))
        output_tokens = _non_negative_int(usage.get("output_tokens"))
        details = usage.get("input_tokens_details")
    else:
        input_tokens = _non_negative_int(usage.get("prompt_tokens"))
        output_tokens = _non_negative_int(usage.get("completion_tokens"))
        details = usage.get("prompt_tokens_details")
    cached_tokens = (
        _non_negative_int(details.get("cached_tokens"))
        if isinstance(details, dict)
        else 0
    )
    if input_tokens is None or output_tokens is None or cached_tokens is None:
        return ProviderUsage("unavailable", None, None, None)
    return ProviderUsage(
        "provider-reported", input_tokens, output_tokens, cached_tokens
    )


def _non_negative_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value
