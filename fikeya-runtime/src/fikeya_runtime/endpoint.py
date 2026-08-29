# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Strict, content-free endpoint execution protocol for managed Fikeya runs.

One bounded JSON request enters on stdin. A whole-run authorization binds every
non-authorization field, while each internal tool request is still checked
against an explicit capability set and receives a distinct one-use decision.
The v2 boundary intentionally excludes process, browser, and MCP tools.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Callable, Protocol, cast

from fikeya_agent_core import ApprovalDecision, CancellationToken

from .coding import CodingAgentRunner, CodingRunResult
from .errors import (
    CancellationError,
    ProviderError,
    ProviderOutputLimitError,
    StateError,
    WorkspaceError,
)
from .modes import AgentMode
from .providers import ProviderProfile, ProviderStore
from .state import StateStore
from .util import sha256_text, stable_json
from .workspace import Workspace, discover_workspace

ENDPOINT_PROTOCOL = "maqam.endpoint-harness.v2"
ENDPOINT_REQUEST_SCHEMA = "maqam.endpoint-harness-request.v2"
ENDPOINT_RESULT_SCHEMA = "maqam.endpoint-harness-result.v2"
ENDPOINT_VERSION_SCHEMA = "maqam.endpoint-runtime.v1"
MAX_ENDPOINT_BYTES = 1_048_576
MAX_ENDPOINT_PROMPT_BYTES = 256 * 1_024
MAX_ENDPOINT_USAGE_VALUE = 10_000_000_000

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_ERROR_CODE = re.compile(r"^FIKEYA_[A-Z0-9_]{1,121}$")
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_REQUEST_KEYS = {
    "access",
    "allowNetwork",
    "authorization",
    "capabilities",
    "commandId",
    "endpointId",
    "limits",
    "memory",
    "prompt",
    "provider",
    "runId",
    "schema",
    "tenantId",
    "toolCallId",
    "workingDirectory",
}
_AUTHORIZATION_KEYS = {"approvalId", "decision", "expiresAt", "scopeSha256"}
_PROVIDER_KEYS = {"model", "profileName", "profileSha256"}
_LIMIT_KEYS = {"maxOutputTokens", "maxSteps", "maxToolCalls", "timeoutMs"}
_CAPABILITY_KEYS = {"allowedTools"}
_MEMORY_KEYS = {"contextMaxCharacters", "mode"}
_READ_TOOLS = frozenset(
    {
        "workspace.list_files",
        "workspace.read_file",
        "workspace.search_text",
    }
)
_WRITE_TOOLS = _READ_TOOLS | frozenset(
    {"workspace.replace_text", "workspace.write_file"}
)
_RESULT_STATUSES = frozenset({"succeeded", "failed", "cancelled"})


class EndpointRunner(Protocol):
    """Subset of ``CodingAgentRunner`` exercised by this boundary."""

    async def run(self, **kwargs: object) -> CodingRunResult: ...


@dataclass(frozen=True, slots=True)
class EndpointAuthorization:
    """One expiring, single-consumption authorization for the exact request."""

    approval_id: str
    expires_at: datetime
    scope_sha256: str


@dataclass(frozen=True, slots=True)
class EndpointProvider:
    """Expected provider identity, local profile digest, and model."""

    profile_name: str
    profile_sha256: str
    model: str


@dataclass(frozen=True, slots=True)
class EndpointLimits:
    """Mechanical ceilings applied to the coding-agent run."""

    timeout_ms: int
    max_output_tokens: int
    max_steps: int
    max_tool_calls: int


@dataclass(frozen=True, slots=True)
class EndpointMemory:
    """Bounded Qarinah context policy supplied by the caller."""

    mode: str
    context_max_characters: int


@dataclass(frozen=True, slots=True)
class EndpointRequest:
    """Fully validated request with stable canonical correlation hashes."""

    tenant_id: str
    endpoint_id: str
    command_id: str
    run_id: str
    tool_call_id: str
    authorization: EndpointAuthorization
    access: str
    prompt: str
    working_directory: Path
    workspace: Workspace
    provider: EndpointProvider
    limits: EndpointLimits
    allowed_tools: frozenset[str]
    memory: EndpointMemory
    allow_network: bool
    scope_canonical_json: str
    request_sha256: str

    def recheck_scope(self) -> None:
        """Recompute the whole-run scope digest at every approval boundary."""

        if sha256_text(self.scope_canonical_json) != self.authorization.scope_sha256:
            raise StateError("Endpoint authorization scope changed during execution.")

    def recheck_expiry(self) -> None:
        """Reject authorization that expires after initial parsing."""

        if self.authorization.expires_at <= datetime.now(timezone.utc):
            raise StateError("Endpoint authorization expired during execution.")


@dataclass(frozen=True, slots=True)
class EndpointResult:
    """Strict content-free endpoint response, including settled failures."""

    request_sha256: str
    status: str
    session_id: str
    provider: str
    model: str
    error_code: str | None
    measurement: str = "unavailable"
    complete: bool = False
    input_tokens: int | None = None
    cached_input_tokens: int | None = None
    output_tokens: int | None = None

    def as_json(self) -> dict[str, object]:
        """Return the exact v2 envelope and its canonical outcome digest."""

        if self.status not in _RESULT_STATUSES:
            raise StateError("Endpoint result status is invalid.")
        if _DIGEST.fullmatch(self.request_sha256) is None:
            raise StateError("Endpoint result requestSha256 is invalid.")
        try:
            bounded_result_text = (
                self.session_id.strip()
                and self.provider.strip()
                and self.model.strip()
                and len(self.session_id.encode("utf-8")) <= 256
                and len(self.provider.encode("utf-8")) <= 128
                and len(self.model.encode("utf-8")) <= 256
                and "\0" not in self.session_id
                and "\0" not in self.provider
                and "\0" not in self.model
            )
        except (AttributeError, UnicodeEncodeError):
            bounded_result_text = False
        if not bounded_result_text:
            raise StateError("Endpoint result identity is invalid.")
        if (self.status == "succeeded") != (self.error_code is None):
            raise StateError("Endpoint result status and errorCode are inconsistent.")
        if self.error_code is not None and _ERROR_CODE.fullmatch(self.error_code) is None:
            raise StateError("Endpoint result errorCode is invalid.")
        token_values = (
            self.input_tokens,
            self.cached_input_tokens,
            self.output_tokens,
        )
        if self.measurement == "unavailable":
            if self.complete or any(value is not None for value in token_values):
                raise StateError("Unavailable endpoint usage must remain incomplete and null.")
        elif self.measurement == "provider-reported":
            if (
                not self.complete
                or any(
                    isinstance(value, bool)
                    or not isinstance(value, int)
                    or not 0 <= value <= MAX_ENDPOINT_USAGE_VALUE
                    for value in token_values
                )
            ):
                raise StateError("Provider-reported endpoint usage is invalid.")
            input_tokens, cached_tokens, output_tokens = cast(tuple[int, int, int], token_values)
            if cached_tokens > input_tokens or not any((input_tokens, cached_tokens, output_tokens)):
                raise StateError("Provider-reported endpoint usage is inconsistent.")
        else:
            raise StateError("Endpoint usage measurement is invalid.")
        usage: dict[str, object] = {
            "cachedInputTokens": self.cached_input_tokens,
            "complete": self.complete,
            "costMicros": None,
            "currency": None,
            "inputTokens": self.input_tokens,
            "measurement": self.measurement,
            "outputTokens": self.output_tokens,
            "reasoningTokens": None,
        }
        unhashed: dict[str, object] = {
            "errorCode": self.error_code,
            "model": self.model,
            "provider": self.provider,
            "requestSha256": self.request_sha256,
            "schema": ENDPOINT_RESULT_SCHEMA,
            "sessionId": self.session_id,
            "status": self.status,
            "usage": usage,
        }
        return {**unhashed, "outcomeSha256": sha256_text(stable_json(unhashed))}


def read_endpoint_request(
    stream: BinaryIO,
    *,
    cwd: str | Path | None = None,
    clock: Callable[[], datetime] | None = None,
) -> EndpointRequest:
    """Read one strict UTF-8 JSON object without crossing the 1 MiB boundary."""

    payload = stream.read(MAX_ENDPOINT_BYTES + 1)
    if not payload:
        raise ProviderError("Endpoint execution requires one JSON request on stdin.")
    if len(payload) > MAX_ENDPOINT_BYTES:
        raise ProviderError(f"Endpoint request exceeds {MAX_ENDPOINT_BYTES} UTF-8 bytes.")
    try:
        text = payload.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_finite,
        )
    except (RecursionError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ProviderError("Endpoint request must be one strict UTF-8 JSON object.") from error
    if not isinstance(value, dict):
        raise ProviderError("Endpoint request must be one JSON object.")
    return validate_endpoint_request(cast(dict[str, object], value), cwd=cwd, clock=clock)


def validate_endpoint_request(
    value: dict[str, object],
    *,
    cwd: str | Path | None = None,
    clock: Callable[[], datetime] | None = None,
) -> EndpointRequest:
    """Validate the complete v2 schema and bind it to the current real path."""

    _exact_keys(value, _REQUEST_KEYS, "endpoint request")
    if value.get("schema") != ENDPOINT_REQUEST_SCHEMA:
        raise ProviderError(f"Endpoint request schema must be {ENDPOINT_REQUEST_SCHEMA}.")

    tenant_id = _uuid(value, "tenantId")
    endpoint_id = _uuid(value, "endpointId")
    command_id = _uuid(value, "commandId")
    run_id = _uuid(value, "runId")
    tool_call_id = _string(value, "toolCallId", maximum=256)
    access = _string(value, "access", maximum=16)
    if access not in {"read", "write"}:
        raise ProviderError("Endpoint access must be read or write.")
    prompt = _string(value, "prompt", maximum=MAX_ENDPOINT_PROMPT_BYTES)
    allow_network = value.get("allowNetwork")
    if not isinstance(allow_network, bool):
        raise ProviderError("Endpoint allowNetwork must be a boolean.")

    provider = _provider(_object(value.get("provider"), "endpoint provider"))
    limits = _limits(_object(value.get("limits"), "endpoint limits"))
    allowed_tools = _capabilities(
        _object(value.get("capabilities"), "endpoint capabilities"), access=access
    )
    if bool(allowed_tools) != (limits.max_tool_calls > 0):
        raise ProviderError(
            "Endpoint maxToolCalls must be zero exactly when allowedTools is empty."
        )
    memory = _memory(_object(value.get("memory"), "endpoint memory"))
    working_directory = _bound_working_directory(value.get("workingDirectory"), cwd)
    workspace = discover_workspace(working_directory)
    try:
        working_directory.relative_to(workspace.root)
    except ValueError as error:
        raise WorkspaceError("Endpoint working directory escapes its Fikeya workspace.") from error

    scope_value = {key: item for key, item in value.items() if key != "authorization"}
    scope_canonical_json = stable_json(scope_value)
    authorization = _authorization(
        value.get("authorization"),
        expected_scope_sha256=sha256_text(scope_canonical_json),
        clock=clock,
    )
    return EndpointRequest(
        tenant_id=tenant_id,
        endpoint_id=endpoint_id,
        command_id=command_id,
        run_id=run_id,
        tool_call_id=tool_call_id,
        authorization=authorization,
        access=access,
        prompt=prompt,
        working_directory=working_directory,
        workspace=workspace,
        provider=provider,
        limits=limits,
        allowed_tools=allowed_tools,
        memory=memory,
        allow_network=allow_network,
        scope_canonical_json=scope_canonical_json,
        request_sha256=sha256_text(stable_json(value)),
    )


async def execute_endpoint_request(
    request: EndpointRequest,
    providers: ProviderStore,
    *,
    runner_factory: Callable[[Workspace, ProviderStore], EndpointRunner] | None = None,
) -> EndpointResult:
    """Consume authorization and run only through the existing agent/tool boundary."""

    profile = select_endpoint_provider(providers, request.provider)
    request.recheck_scope()
    request.recheck_expiry()
    StateStore(request.workspace.state_path).consume_endpoint_authorization(
        approval_id=request.authorization.approval_id,
        request_sha256=request.request_sha256,
        tenant_id=request.tenant_id,
        endpoint_id=request.endpoint_id,
        command_id=request.command_id,
        run_id=request.run_id,
        tool_call_id=request.tool_call_id,
        expires_at=request.authorization.expires_at.isoformat().replace("+00:00", "Z"),
    )

    endpoint_session_id = f"ses_endpoint_{request.request_sha256[7:39]}"
    approved_calls = 0
    denied_call = False

    async def approve(exact_request: dict[str, object]) -> ApprovalDecision:
        nonlocal approved_calls, denied_call
        request.recheck_scope()
        request.recheck_expiry()
        select_endpoint_provider(providers, request.provider)
        tool_name = exact_request.get("toolName")
        if (
            not isinstance(tool_name, str)
            or tool_name not in request.allowed_tools
            or approved_calls >= request.limits.max_tool_calls
        ):
            denied_call = True
            return ApprovalDecision.DENY_ONCE
        approved_calls += 1
        return ApprovalDecision.ALLOW_ONCE

    cancellation = CancellationToken()
    selected_mode = AgentMode.REVIEW if request.access == "read" else AgentMode.BUILD
    try:
        runner: EndpointRunner
        if runner_factory is None:
            runner = CodingAgentRunner(
                request.workspace,
                providers,
                allowed_executables=frozenset(),
            )
        else:
            runner = runner_factory(request.workspace, providers)
        result = await asyncio.wait_for(
            runner.run(
                provider_name=profile.name,
                prompt=request.prompt,
                allow_network=request.allow_network,
                timeout=min(300.0, request.limits.timeout_ms / 1_000),
                max_output_tokens=request.limits.max_output_tokens,
                max_steps=request.limits.max_steps,
                allowed_tools=request.allowed_tools,
                session_id=endpoint_session_id,
                cancellation=cancellation,
                approval_handler=approve,
                memory_mode=request.memory.mode,
                context_max_characters=request.memory.context_max_characters,
                mode=selected_mode,
                allow_private_browser=False,
                browser_engine="playwright",
            ),
            timeout=request.limits.timeout_ms / 1_000,
        )
    except (TimeoutError, asyncio.TimeoutError):
        cancellation.cancel()
        return _failed_result(request, profile, endpoint_session_id, "cancelled", "FIKEYA_TIMEOUT")
    except (CancellationError, asyncio.CancelledError):
        cancellation.cancel()
        return _failed_result(request, profile, endpoint_session_id, "cancelled", "FIKEYA_CANCELLED")
    except ProviderOutputLimitError:
        cancellation.cancel()
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "failed",
            "FIKEYA_LIMIT_EXCEEDED",
        )
    except Exception:  # noqa: BLE001 - post-start errors settle without leaking details.
        return _failed_result(request, profile, endpoint_session_id, "failed", "FIKEYA_RUNTIME_FAILED")

    try:
        usage = _safe_usage(result)
        if denied_call:
            return _failed_result(
                request,
                profile,
                endpoint_session_id,
                "failed",
                "FIKEYA_CAPABILITY_DENIED",
                usage=usage,
            )
        if result.session_id != endpoint_session_id:
            return _failed_result(
                request, profile, endpoint_session_id, "failed", "FIKEYA_RUNTIME_FAILED"
            )
        if (
            result.steps > request.limits.max_steps
            or len(result.tool_calls) > request.limits.max_tool_calls
        ):
            return _failed_result(
                request,
                profile,
                endpoint_session_id,
                "failed",
                "FIKEYA_LIMIT_EXCEEDED",
                usage=usage,
            )
        if result.status != "completed":
            status = "cancelled" if result.status == "cancelled" else "failed"
            return _failed_result(
                request,
                profile,
                endpoint_session_id,
                status,
                "FIKEYA_CANCELLED" if status == "cancelled" else "FIKEYA_AGENT_FAILED",
                usage=usage,
            )
        if usage is None:
            return _failed_result(
                request, profile, endpoint_session_id, "failed", "FIKEYA_USAGE_INVALID"
            )
        measurement, complete, input_tokens, cached_tokens, output_tokens = usage
        return EndpointResult(
            request_sha256=request.request_sha256,
            status="succeeded",
            session_id=endpoint_session_id,
            provider=profile.name,
            model=profile.model,
            error_code=None,
            measurement=measurement,
            complete=complete,
            input_tokens=input_tokens,
            cached_input_tokens=cached_tokens,
            output_tokens=output_tokens,
        )
    except Exception:  # noqa: BLE001 - settle post-start normalization failures.
        return _failed_result(
            request, profile, endpoint_session_id, "failed", "FIKEYA_RUNTIME_FAILED"
        )


def select_endpoint_provider(
    providers: ProviderStore, expected: EndpointProvider
) -> ProviderProfile:
    """Require exact profile metadata and model identity at every boundary."""

    profile = providers.get(expected.profile_name)
    if profile.model != expected.model:
        raise ProviderError("Endpoint model does not match its configured provider profile.")
    if sha256_text(stable_json(profile.as_json())) != expected.profile_sha256:
        raise ProviderError("Endpoint provider profile digest does not match local metadata.")
    return profile


def _failed_result(
    request: EndpointRequest,
    profile: ProviderProfile,
    session_id: str,
    status: str,
    error_code: str,
    *,
    usage: tuple[str, bool, int | None, int | None, int | None] | None = None,
) -> EndpointResult:
    values = usage or ("unavailable", False, None, None, None)
    return EndpointResult(
        request_sha256=request.request_sha256,
        status=status,
        session_id=session_id,
        provider=profile.name,
        model=profile.model,
        error_code=error_code,
        measurement=values[0],
        complete=values[1],
        input_tokens=values[2],
        cached_input_tokens=values[3],
        output_tokens=values[4],
    )


def _safe_usage(
    result: CodingRunResult,
) -> tuple[str, bool, int | None, int | None, int | None] | None:
    measurement = result.usage.get("measurement")
    if measurement == "unavailable":
        return None
    if measurement != "provider-reported":
        return None
    values: dict[str, int] = {}
    for name in ("inputTokens", "cachedInputTokens", "outputTokens"):
        item = result.usage.get(name)
        if (
            isinstance(item, bool)
            or not isinstance(item, int)
            or not 0 <= item <= MAX_ENDPOINT_USAGE_VALUE
        ):
            return None
        values[name] = item
    if (
        values["cachedInputTokens"] > values["inputTokens"]
        or not any(values.values())
    ):
        return None
    return (
        "provider-reported",
        True,
        values["inputTokens"],
        values["cachedInputTokens"],
        values["outputTokens"],
    )


def _authorization(
    value: object,
    *,
    expected_scope_sha256: str,
    clock: Callable[[], datetime] | None,
) -> EndpointAuthorization:
    item = _object(value, "endpoint authorization")
    _exact_keys(item, _AUTHORIZATION_KEYS, "endpoint authorization")
    if item.get("decision") != "allow":
        raise ProviderError("Endpoint authorization decision must be allow.")
    approval_id = _string(item, "approvalId", maximum=256)
    scope_sha256 = _digest(item, "scopeSha256")
    if scope_sha256 != expected_scope_sha256:
        raise ProviderError("Endpoint authorization scope does not match the request.")
    expires = _string(item, "expiresAt", maximum=64)
    if not expires.endswith("Z"):
        raise ProviderError("Endpoint authorization expiry must be an absolute UTC timestamp.")
    try:
        expires_at = datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProviderError("Endpoint authorization expiry is invalid.") from error
    if expires_at.tzinfo is None:
        raise ProviderError("Endpoint authorization expiry must include a timezone.")
    now = (clock or (lambda: datetime.now(timezone.utc)))()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    expires_at = expires_at.astimezone(timezone.utc)
    if expires_at <= now.astimezone(timezone.utc):
        raise ProviderError("Endpoint authorization has expired.")
    return EndpointAuthorization(approval_id, expires_at, scope_sha256)


def _provider(value: dict[str, object]) -> EndpointProvider:
    _exact_keys(value, _PROVIDER_KEYS, "endpoint provider")
    return EndpointProvider(
        profile_name=_string(value, "profileName", maximum=128),
        profile_sha256=_digest(value, "profileSha256"),
        model=_string(value, "model", maximum=256),
    )


def _limits(value: dict[str, object]) -> EndpointLimits:
    _exact_keys(value, _LIMIT_KEYS, "endpoint limits")
    return EndpointLimits(
        timeout_ms=_integer(value, "timeoutMs", minimum=1, maximum=900_000),
        max_output_tokens=_integer(value, "maxOutputTokens", minimum=1, maximum=32_768),
        max_steps=_integer(value, "maxSteps", minimum=1, maximum=64),
        max_tool_calls=_integer(value, "maxToolCalls", minimum=0, maximum=128),
    )


def _capabilities(value: dict[str, object], *, access: str) -> frozenset[str]:
    _exact_keys(value, _CAPABILITY_KEYS, "endpoint capabilities")
    raw = value.get("allowedTools")
    if (
        not isinstance(raw, list)
        or len(raw) > len(_WRITE_TOOLS)
        or any(not isinstance(name, str) for name in raw)
        or cast(list[str], raw) != sorted(cast(list[str], raw))
        or len(set(cast(list[str], raw))) != len(raw)
    ):
        raise ProviderError("Endpoint allowedTools must be a sorted, unique bounded string array.")
    tools = frozenset(cast(list[str], raw))
    permitted = _READ_TOOLS if access == "read" else _WRITE_TOOLS
    if not tools <= permitted:
        raise ProviderError("Endpoint capabilities include a tool denied by access mode.")
    return tools


def _memory(value: dict[str, object]) -> EndpointMemory:
    _exact_keys(value, _MEMORY_KEYS, "endpoint memory")
    mode = _string(value, "mode", maximum=16)
    if mode not in {"auto", "off", "required"}:
        raise ProviderError("Endpoint memory mode must be auto, off, or required.")
    return EndpointMemory(
        mode=mode,
        context_max_characters=_integer(
            value, "contextMaxCharacters", minimum=512, maximum=64_000
        ),
    )


def _bound_working_directory(value: object, cwd: str | Path | None) -> Path:
    try:
        byte_length = len(value.encode("utf-8")) if isinstance(value, str) else -1
    except UnicodeEncodeError:
        byte_length = -1
    if (
        not isinstance(value, str)
        or not value
        or not 0 <= byte_length <= 4_096
        or "\0" in value
    ):
        raise WorkspaceError("Endpoint workingDirectory must be a bounded absolute path.")
    supplied = Path(value)
    if not supplied.is_absolute():
        raise WorkspaceError("Endpoint workingDirectory must be an absolute path.")
    try:
        resolved = supplied.resolve(strict=True)
    except OSError as error:
        raise WorkspaceError("Endpoint workingDirectory does not exist.") from error
    if not resolved.is_dir():
        raise WorkspaceError("Endpoint workingDirectory must be a directory.")
    current = (Path(cwd) if cwd is not None else Path.cwd()).expanduser().resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(current)):
        raise WorkspaceError("Endpoint workingDirectory does not match the process working directory.")
    return resolved


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ProviderError(f"{label} must be an object.")
    return cast(dict[str, object], value)


def _exact_keys(value: dict[str, object], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ProviderError(f"{label} has missing or unknown fields.")


def _string(value: dict[str, object], name: str, *, maximum: int) -> str:
    item = value.get(name)
    try:
        byte_length = len(item.encode("utf-8")) if isinstance(item, str) else -1
    except UnicodeEncodeError:
        byte_length = -1
    if (
        not isinstance(item, str)
        or not item.strip()
        or not 0 <= byte_length <= maximum
        or "\0" in item
    ):
        raise ProviderError(f"Endpoint {name} must be a non-empty bounded string.")
    return item


def _uuid(value: dict[str, object], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or _UUID.fullmatch(item) is None:
        raise ProviderError(f"Endpoint {name} must be a UUID.")
    return item


def _digest(value: dict[str, object], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or _DIGEST.fullmatch(item) is None:
        raise ProviderError(f"Endpoint {name} must be a prefixed SHA-256 digest.")
    return item


def _integer(
    value: dict[str, object], name: str, *, minimum: int, maximum: int
) -> int:
    item = value.get(name)
    if isinstance(item, bool) or not isinstance(item, int) or not minimum <= item <= maximum:
        raise ProviderError(
            f"Endpoint {name} must be an integer between {minimum} and {maximum}."
        )
    return item


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def _reject_non_finite(value: str) -> object:
    raise ValueError(f"non-finite JSON number: {value}")


__all__ = [
    "ENDPOINT_PROTOCOL",
    "ENDPOINT_REQUEST_SCHEMA",
    "ENDPOINT_RESULT_SCHEMA",
    "ENDPOINT_VERSION_SCHEMA",
    "MAX_ENDPOINT_BYTES",
    "EndpointAuthorization",
    "EndpointLimits",
    "EndpointMemory",
    "EndpointProvider",
    "EndpointRequest",
    "EndpointResult",
    "execute_endpoint_request",
    "read_endpoint_request",
    "select_endpoint_provider",
    "validate_endpoint_request",
]
