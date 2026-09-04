# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Bounded provider inference with content-free call receipts."""

from __future__ import annotations

import base64
import binascii
import json
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from .errors import (
    CancellationError,
    ConfigurationError,
    ProviderConnectivityError,
    ProviderError,
    ProviderHttpError,
)
from .providers import ProviderKind, ProviderProfile, provider_headers
from .util import sha256_bytes, stable_json

MAX_REQUEST_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 4_194_304
MAX_IMAGE_BYTES = 393_216
MAX_TOTAL_IMAGE_BYTES = 524_288
MAX_IMAGE_COUNT = 4
_IMAGE_NAME = re.compile(r"^[^\\/\x00-\x1f\x7f]{1,160}$")
_IMAGE_TYPES = frozenset({"image/gif", "image/jpeg", "image/png", "image/webp"})


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
class InferenceImage:
    """One bounded ephemeral image supplied to a vision-capable provider."""

    name: str
    media_type: str
    base64_data: str
    size_bytes: int

    def __post_init__(self) -> None:
        if not _IMAGE_NAME.fullmatch(self.name):
            raise ConfigurationError("Image name is invalid or exceeds 160 characters.")
        if self.media_type not in _IMAGE_TYPES:
            raise ConfigurationError("Image type must be GIF, JPEG, PNG, or WebP.")
        if not 1 <= self.size_bytes <= MAX_IMAGE_BYTES:
            raise ConfigurationError(
                f"Image bytes must be between 1 and {MAX_IMAGE_BYTES}."
            )
        try:
            decoded = base64.b64decode(self.base64_data, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ConfigurationError("Image data must be canonical base64.") from error
        if len(decoded) != self.size_bytes or base64.b64encode(decoded).decode("ascii") != self.base64_data:
            raise ConfigurationError("Image size or base64 encoding is inconsistent.")

    @property
    def data_url(self) -> str:
        return f"data:{self.media_type};base64,{self.base64_data}"


@dataclass(frozen=True, slots=True)
class InferenceRequest:
    """One bounded multimodal request; callers retain ownership of its content."""

    prompt: str
    system: str | None = None
    max_output_tokens: int = 1_024
    temperature: float | None = None
    images: tuple[InferenceImage, ...] = ()

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
        if len(self.images) > MAX_IMAGE_COUNT:
            raise ConfigurationError(f"At most {MAX_IMAGE_COUNT} images are accepted.")
        if sum(image.size_bytes for image in self.images) > MAX_TOTAL_IMAGE_BYTES:
            raise ConfigurationError(
                f"Combined image bytes cannot exceed {MAX_TOTAL_IMAGE_BYTES}."
            )


def parse_inference_images(value: object) -> tuple[InferenceImage, ...]:
    """Strictly decode the private stdin image envelope."""

    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > MAX_IMAGE_COUNT:
        raise ConfigurationError(f"Images must be a list of at most {MAX_IMAGE_COUNT} items.")
    images: list[InferenceImage] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {
            "base64Data",
            "mimeType",
            "name",
            "sizeBytes",
        }:
            raise ConfigurationError("Each image must contain exact bounded image fields.")
        name = item.get("name")
        media_type = item.get("mimeType")
        base64_data = item.get("base64Data")
        size_bytes = item.get("sizeBytes")
        if (
            not isinstance(name, str)
            or not isinstance(media_type, str)
            or not isinstance(base64_data, str)
            or isinstance(size_bytes, bool)
            or not isinstance(size_bytes, int)
        ):
            raise ConfigurationError("Image fields have invalid types.")
        images.append(InferenceImage(name, media_type, base64_data, size_bytes))
    normalized = tuple(images)
    if sum(image.size_bytes for image in normalized) > MAX_TOTAL_IMAGE_BYTES:
        raise ConfigurationError(
            f"Combined image bytes cannot exceed {MAX_TOTAL_IMAGE_BYTES}."
        )
    return normalized


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
            raise ProviderHttpError(int(error.code)) from error
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise ProviderConnectivityError() from error
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
    """Execute one explicit provider call without persisting content."""

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
        if profile.api_mode == "native" and profile.kind != ProviderKind.ANTHROPIC:
            raise ProviderError(
                f"Native {profile.kind.value} execution is not shipped in this runtime slice."
            )
        token = cancellation or CancellationToken()
        token.raise_if_cancelled()
        url = _execution_url(profile)
        payload = _serialized_provider_request(profile, request)
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
            raise ProviderHttpError(response.status_code)
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

    payload = _serialized_provider_request(profile, request)
    if len(payload) > MAX_REQUEST_BYTES:
        raise ConfigurationError(
            f"Serialized provider request exceeds {MAX_REQUEST_BYTES} bytes."
        )
    return ProviderRequestFingerprint(
        request_sha256=sha256_bytes(payload),
        request_bytes=len(payload),
    )


def serialized_provider_request_bytes(
    profile: ProviderProfile,
    request: InferenceRequest,
) -> int:
    """Measure the exact UTF-8 request body for any supported provider API mode."""

    return len(_serialized_provider_request(profile, request))


def _serialized_provider_request(
    profile: ProviderProfile,
    request: InferenceRequest,
) -> bytes:
    return stable_json(_request_payload(profile, request)).encode("utf-8")


def _execution_url(profile: ProviderProfile) -> str:
    base_url = profile.base_url.rstrip("/")
    if profile.kind == ProviderKind.ANTHROPIC:
        return f"{base_url}/messages"
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
    if profile.kind == ProviderKind.ANTHROPIC and profile.api_mode == "native":
        content: str | list[dict[str, object]] = request.prompt
        if request.images:
            content = [
                {"type": "text", "text": request.prompt},
                *[
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.media_type,
                            "data": image.base64_data,
                        },
                    }
                    for image in request.images
                ],
            ]
        payload: dict[str, object] = {
            "max_tokens": request.max_output_tokens,
            "messages": [{"content": content, "role": "user"}],
            "model": profile.model,
        }
        if request.system is not None:
            payload["system"] = request.system
    elif profile.api_mode == "responses":
        input_value: str | list[dict[str, object]] = request.prompt
        if request.images:
            input_value = [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": request.prompt},
                        *[
                            {"type": "input_image", "image_url": image.data_url}
                            for image in request.images
                        ],
                    ],
                }
            ]
        payload: dict[str, object] = {
            "input": input_value,
            "max_output_tokens": request.max_output_tokens,
            "model": profile.model,
        }
        if request.system is not None:
            payload["instructions"] = request.system
    else:
        messages: list[dict[str, object]] = []
        if request.system is not None:
            messages.append({"content": request.system, "role": "system"})
        user_content: str | list[dict[str, object]] = request.prompt
        if request.images:
            user_content = [
                {"type": "text", "text": request.prompt},
                *[
                    {"type": "image_url", "image_url": {"url": image.data_url}}
                    for image in request.images
                ],
            ]
        messages.append({"content": user_content, "role": "user"})
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
    elif api_mode == "native":
        content = body.get("content")
        if isinstance(content, list):
            pieces = [
                block["text"]
                for block in content
                if isinstance(block, dict)
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
            ]
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
    elif api_mode == "native":
        base_input_tokens = _non_negative_int(usage.get("input_tokens"))
        cache_creation_tokens = _non_negative_int(
            usage.get("cache_creation_input_tokens", 0)
        )
        cache_read_tokens = _non_negative_int(usage.get("cache_read_input_tokens", 0))
        output_tokens = _non_negative_int(usage.get("output_tokens"))
        if (
            base_input_tokens is None
            or cache_creation_tokens is None
            or cache_read_tokens is None
            or output_tokens is None
        ):
            return ProviderUsage("unavailable", None, None, None)
        # Anthropic reports these three input categories separately. The shared
        # receipt's input_tokens field is normalized to total billed input while
        # cached_input_tokens preserves the cache-read subset. Cache writes remain
        # included in input_tokens until the versioned protocol gains a distinct field.
        return ProviderUsage(
            "provider-reported",
            base_input_tokens + cache_creation_tokens + cache_read_tokens,
            output_tokens,
            cache_read_tokens,
        )
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
