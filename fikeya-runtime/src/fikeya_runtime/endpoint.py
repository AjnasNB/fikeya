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
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol, cast

from fikeya_agent_core import ApprovalDecision, CancellationToken

from .agent import MemoryPreparation
from .artifact import artifact_file_sha256, artifact_sha256
from .coding import CodingAgentRunner, CodingRunResult
from .errors import (
    CancellationError,
    ConfigurationError,
    EndpointAuthorizationExpiredError,
    EndpointMemoryArtifactError,
    ProviderError,
    ProviderOutputLimitError,
    StateError,
    WorkspaceError,
)
from .events import EventType
from .modes import AgentMode
from .providers import ProviderProfile, ProviderStore
from .qarinah import QarinahQueryResult, QarinahSidecarAdapter
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
_UTC_TIMESTAMP = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$"
)
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
_MEMORY_KEYS = {"adapter", "contextMaxCharacters", "mode", "rebuild"}
_MEMORY_ADAPTER_KEYS = {
    "artifactRoot",
    "artifactSha256",
    "kind",
    "nodeExecutable",
    "nodeSha256",
    "packageJsonPath",
    "packageJsonSha256",
    "sidecarPath",
    "sidecarSha256",
    "version",
}
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
_EFFECT_CHAIN_SCHEMA = "maqam.endpoint-effect-chain.v1"
_EMPTY_EFFECT_CHAIN_SHA256 = sha256_text(
    stable_json({"receipts": [], "schema": _EFFECT_CHAIN_SCHEMA})
)
_SIDECAR_PACKAGE_NAME = "@fikeya/qarinah-sidecar"
_EXACT_SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")


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
class EndpointMemoryAdapter:
    """Exact signed Node/Qarinah sidecar artifact binding."""

    node_executable: Path
    node_sha256: str
    sidecar_path: Path
    sidecar_sha256: str
    package_json_path: Path
    package_json_sha256: str
    artifact_root: Path
    artifact_sha256: str
    version: str
    qarinah_version: str

    def verify(self) -> None:
        """Recompute both file digests and the deterministic artifact tree digest."""

        if artifact_file_sha256(self.node_executable) != self.node_sha256:
            raise ConfigurationError("The managed Node executable digest changed.")
        if artifact_file_sha256(self.sidecar_path) != self.sidecar_sha256:
            raise ConfigurationError("The managed Qarinah sidecar digest changed.")
        if artifact_file_sha256(self.package_json_path) != self.package_json_sha256:
            raise ConfigurationError("The managed Qarinah package digest changed.")
        if artifact_sha256(self.artifact_root) != self.artifact_sha256:
            raise ConfigurationError("The managed Qarinah artifact digest changed.")
        version, qarinah_version = _sidecar_package_metadata(self.package_json_path)
        if version != self.version or qarinah_version != self.qarinah_version:
            raise ConfigurationError("The managed Qarinah package identity changed.")


@dataclass(frozen=True, slots=True)
class EndpointMemory:
    """Bounded Qarinah context policy supplied by the caller."""

    mode: str
    context_max_characters: int
    rebuild: bool
    adapter: EndpointMemoryAdapter | None


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

    def recheck_expiry(self, clock: Callable[[], datetime] | None = None) -> None:
        """Reject authorization that expires after initial parsing."""

        now = (clock or (lambda: datetime.now(timezone.utc)))()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        if self.authorization.expires_at <= now.astimezone(timezone.utc):
            raise EndpointAuthorizationExpiredError(
                "Endpoint authorization expired during execution."
            )


class _ManagedQarinahSidecar:
    """Reverify and invoke only the exact signed Node/sidecar pair."""

    def __init__(self, request: EndpointRequest) -> None:
        binding = request.memory.adapter
        if binding is None:
            raise StateError("Managed Qarinah memory requires an artifact binding.")
        self.binding = binding
        self.adapter = QarinahSidecarAdapter(
            workspace_root=request.workspace.root,
            state=StateStore(request.workspace.state_path),
            node_executable=binding.node_executable,
            sidecar_path=binding.sidecar_path,
            rebuild=False,
        )
        self._run_deadline: float | None = None

    def start_run(self, timeout_seconds: float) -> None:
        """Bind every memory subprocess to the remaining signed run budget."""

        self._run_deadline = time.monotonic() + timeout_seconds

    def verify_identity(self) -> None:
        """Verify artifact bits and the exact package-reported runtime identity."""

        self._verify()
        identity = self.adapter.version()
        if (
            identity.name != _SIDECAR_PACKAGE_NAME
            or identity.version != self.binding.version
            or identity.qarinah_version != self.binding.qarinah_version
        ):
            raise ProviderError(
                "The managed Qarinah runtime identity does not match its package binding."
            )
        self._verify()

    def query(
        self,
        session_id: str,
        query: str,
        *,
        maximum_characters: int,
        limit: int,
        minimum_coverage: str,
        timeout_seconds: float,
    ) -> QarinahQueryResult:
        self._verify()
        deadline = self._run_deadline
        remaining = (
            timeout_seconds
            if deadline is None
            else min(timeout_seconds, deadline - time.monotonic())
        )
        if remaining <= 0:
            raise TimeoutError("Managed Qarinah memory exceeded the run timeout.")
        completed = False
        try:
            result = self.adapter.query(
                session_id,
                query,
                maximum_characters=maximum_characters,
                limit=limit,
                minimum_coverage=minimum_coverage,
                timeout_seconds=remaining,
            )
            completed = True
            return result
        except ProviderError:
            raise
        except Exception as error:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(
                    "Managed Qarinah memory exceeded the run timeout."
                ) from error
            raise
        finally:
            # A successful retrieval must be tied to the same signed files. A
            # timed-out process was killed and produced no usable memory receipt;
            # avoid extending the signed run deadline with another full tree hash.
            if completed:
                self._verify()

    def _verify(self) -> None:
        try:
            self.binding.verify()
        except ConfigurationError as error:
            raise EndpointMemoryArtifactError(
                "The managed Qarinah sidecar changed during execution."
            ) from error


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
    effects_measurement: str = "unavailable"
    effects_complete: bool = False
    effect_receipt_sha256: str | None = None
    tool_call_count: int | None = None
    write_count: int | None = None
    memory_mode: str = "off"
    memory_status: str = "off"
    memory_complete: bool = True
    memory_receipt_id: str | None = None
    memory_response_sha256: str | None = None
    memory_evidence_count: int | None = 0

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
                and self.session_id == self.session_id.strip()
                and self.provider == self.provider.strip()
                and self.model == self.model.strip()
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
        if (
            self.error_code is not None
            and _ERROR_CODE.fullmatch(self.error_code) is None
        ):
            raise StateError("Endpoint result errorCode is invalid.")
        token_values = (
            self.input_tokens,
            self.cached_input_tokens,
            self.output_tokens,
        )
        if self.measurement == "unavailable":
            if self.complete or any(value is not None for value in token_values):
                raise StateError(
                    "Unavailable endpoint usage must remain incomplete and null."
                )
        elif self.measurement == "provider-reported":
            if not self.complete or any(
                isinstance(value, bool)
                or not isinstance(value, int)
                or not 0 <= value <= MAX_ENDPOINT_USAGE_VALUE
                for value in token_values
            ):
                raise StateError("Provider-reported endpoint usage is invalid.")
            input_tokens, cached_tokens, output_tokens = cast(
                tuple[int, int, int], token_values
            )
            if cached_tokens > input_tokens or not any(
                (input_tokens, cached_tokens, output_tokens)
            ):
                raise StateError("Provider-reported endpoint usage is inconsistent.")
        else:
            raise StateError("Endpoint usage measurement is invalid.")
        if self.status == "succeeded" and (
            self.measurement != "provider-reported" or not self.complete
        ):
            raise StateError(
                "Successful endpoint result requires complete provider-reported usage."
            )
        effect_values = (
            self.effect_receipt_sha256,
            self.tool_call_count,
            self.write_count,
        )
        if self.effects_measurement == "unavailable":
            if self.effects_complete or any(
                value is not None for value in effect_values
            ):
                raise StateError(
                    "Unavailable endpoint effects must remain incomplete and null."
                )
        elif self.effects_measurement == "local-receipt-chain":
            if (
                not self.effects_complete
                or not isinstance(self.effect_receipt_sha256, str)
                or _DIGEST.fullmatch(self.effect_receipt_sha256) is None
                or isinstance(self.tool_call_count, bool)
                or not isinstance(self.tool_call_count, int)
                or isinstance(self.write_count, bool)
                or not isinstance(self.write_count, int)
                or not 0 <= self.write_count <= self.tool_call_count <= 128
                or (
                    self.tool_call_count == 0
                    and self.effect_receipt_sha256 != _EMPTY_EFFECT_CHAIN_SHA256
                )
            ):
                raise StateError("Endpoint local effect receipt chain is invalid.")
        else:
            raise StateError("Endpoint effects measurement is invalid.")
        if self.status == "succeeded" and (
            self.effects_measurement != "local-receipt-chain"
            or not self.effects_complete
        ):
            raise StateError(
                "Successful endpoint result requires a complete local effect chain."
            )
        if self.memory_mode not in {"auto", "off", "required"}:
            raise StateError("Endpoint memory mode is invalid.")
        if self.memory_mode == "off":
            if (
                self.memory_status != "off"
                or not self.memory_complete
                or self.memory_receipt_id is not None
                or self.memory_response_sha256 is not None
                or self.memory_evidence_count != 0
            ):
                raise StateError(
                    "Memory-off endpoint results must use the exact empty receipt."
                )
        elif self.memory_status == "used":
            try:
                valid_receipt = (
                    isinstance(self.memory_receipt_id, str)
                    and bool(self.memory_receipt_id.strip())
                    and self.memory_receipt_id == self.memory_receipt_id.strip()
                    and len(self.memory_receipt_id.encode("utf-8")) <= 256
                    and "\0" not in self.memory_receipt_id
                )
            except UnicodeEncodeError:
                valid_receipt = False
            if (
                not self.memory_complete
                or not valid_receipt
                or not isinstance(self.memory_response_sha256, str)
                or _DIGEST.fullmatch(self.memory_response_sha256) is None
                or isinstance(self.memory_evidence_count, bool)
                or not isinstance(self.memory_evidence_count, int)
                or not 0 <= self.memory_evidence_count <= 1_000_000
            ):
                raise StateError("Used endpoint memory receipt is invalid.")
        elif self.memory_status == "unavailable":
            if (
                self.memory_complete
                or self.memory_receipt_id is not None
                or self.memory_response_sha256 is not None
                or self.memory_evidence_count is not None
            ):
                raise StateError(
                    "Unavailable endpoint memory must remain incomplete and null."
                )
        else:
            raise StateError("Endpoint memory result status is invalid.")
        if (
            self.status == "succeeded"
            and self.memory_mode == "required"
            and self.memory_status != "used"
        ):
            raise StateError(
                "Successful required-memory result needs a complete receipt."
            )
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
        effects: dict[str, object] = {
            "complete": self.effects_complete,
            "measurement": self.effects_measurement,
            "receiptSha256": self.effect_receipt_sha256,
            "toolCallCount": self.tool_call_count,
            "writeCount": self.write_count,
        }
        memory: dict[str, object] = {
            "complete": self.memory_complete,
            "evidenceCount": self.memory_evidence_count,
            "mode": self.memory_mode,
            "receiptId": self.memory_receipt_id,
            "responseSha256": self.memory_response_sha256,
            "status": self.memory_status,
        }
        unhashed: dict[str, object] = {
            "errorCode": self.error_code,
            "effects": effects,
            "memory": memory,
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
        raise ProviderError(
            f"Endpoint request exceeds {MAX_ENDPOINT_BYTES} UTF-8 bytes."
        )
    try:
        text = payload.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_finite,
        )
    except (
        RecursionError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as error:
        raise ProviderError(
            "Endpoint request must be one strict UTF-8 JSON object."
        ) from error
    if not isinstance(value, dict):
        raise ProviderError("Endpoint request must be one JSON object.")
    return validate_endpoint_request(
        cast(dict[str, object], value), cwd=cwd, clock=clock
    )


def validate_endpoint_request(
    value: dict[str, object],
    *,
    cwd: str | Path | None = None,
    clock: Callable[[], datetime] | None = None,
) -> EndpointRequest:
    """Validate the complete v2 schema and bind it to the current real path."""

    _exact_keys(value, _REQUEST_KEYS, "endpoint request")
    if value.get("schema") != ENDPOINT_REQUEST_SCHEMA:
        raise ProviderError(
            f"Endpoint request schema must be {ENDPOINT_REQUEST_SCHEMA}."
        )

    tenant_id = _uuid(value, "tenantId")
    endpoint_id = _uuid(value, "endpointId")
    command_id = _uuid(value, "commandId")
    run_id = _uuid(value, "runId")
    tool_call_id = _exact_string(value, "toolCallId", maximum=256)
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
        raise WorkspaceError(
            "Endpoint working directory escapes its Fikeya workspace."
        ) from error

    scope_value = {key: item for key, item in value.items() if key != "authorization"}
    scope_canonical_json = stable_json(scope_value)
    authorization = _authorization(
        value.get("authorization"),
        expected_scope_sha256=sha256_text(scope_canonical_json),
        clock=clock,
    )
    _verify_memory_preflight(memory, workspace)
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
    clock: Callable[[], datetime] | None = None,
) -> EndpointResult:
    """Consume authorization and run only through the existing agent/tool boundary."""

    profile = select_endpoint_provider(providers, request.provider)
    request.recheck_scope()
    request.recheck_expiry(clock)
    _verify_memory_preflight(request.memory, request.workspace)
    memory_provider = (
        _ManagedQarinahSidecar(request) if request.memory.adapter is not None else None
    )
    if memory_provider is not None:
        # Probe the exact signed package before the one-use authorization is
        # consumed. A mismatched sidecar is a preflight failure with no effect.
        memory_provider.verify_identity()
    # Identity probing and artifact hashing can take time. Revalidate the exact
    # lease immediately before its atomic consumption so an expired preflight
    # can never start provider or memory work.
    request.recheck_scope()
    request.recheck_expiry(clock)
    select_endpoint_provider(providers, request.provider)
    _verify_memory_preflight(request.memory, request.workspace)
    StateStore(request.workspace.state_path).consume_endpoint_authorization(
        approval_id=request.authorization.approval_id,
        request_sha256=request.request_sha256,
        tenant_id=request.tenant_id,
        endpoint_id=request.endpoint_id,
        command_id=request.command_id,
        run_id=request.run_id,
        tool_call_id=request.tool_call_id,
        expires_at=request.authorization.expires_at.isoformat().replace("+00:00", "Z"),
        clock=clock,
    )
    if memory_provider is not None:
        memory_provider.start_run(request.limits.timeout_ms / 1_000)

    endpoint_session_id = f"ses_endpoint_{request.request_sha256[7:39]}"
    approved_calls = 0
    denied_call = False

    async def approve(exact_request: dict[str, object]) -> ApprovalDecision:
        nonlocal approved_calls, denied_call
        request.recheck_scope()
        request.recheck_expiry(clock)
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
                memory_provider=memory_provider,
                allow_discovered_memory=False,
                mode=selected_mode,
                allow_private_browser=False,
                browser_engine="playwright",
            ),
            timeout=request.limits.timeout_ms / 1_000,
        )
        _verify_memory_after_start(request.memory)
    except (TimeoutError, asyncio.TimeoutError):
        cancellation.cancel()
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "cancelled",
            "FIKEYA_TIMEOUT",
            usage=_recorded_usage(request.workspace, endpoint_session_id),
            effects=_recorded_effects(request.workspace, endpoint_session_id),
        )
    except (CancellationError, asyncio.CancelledError):
        cancellation.cancel()
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "cancelled",
            "FIKEYA_CANCELLED",
            usage=_recorded_usage(request.workspace, endpoint_session_id),
            effects=_recorded_effects(request.workspace, endpoint_session_id),
        )
    except EndpointAuthorizationExpiredError:
        cancellation.cancel()
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "failed",
            "FIKEYA_AUTHORIZATION_EXPIRED",
            usage=_recorded_usage(request.workspace, endpoint_session_id),
            effects=_recorded_effects(request.workspace, endpoint_session_id),
        )
    except ProviderOutputLimitError:
        cancellation.cancel()
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "failed",
            "FIKEYA_LIMIT_EXCEEDED",
            usage=_recorded_usage(request.workspace, endpoint_session_id),
            effects=_recorded_effects(request.workspace, endpoint_session_id),
        )
    except EndpointMemoryArtifactError:
        cancellation.cancel()
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "failed",
            "FIKEYA_MEMORY_ARTIFACT_CHANGED",
            usage=_recorded_usage(request.workspace, endpoint_session_id),
            effects=_recorded_effects(request.workspace, endpoint_session_id),
        )
    except Exception:  # noqa: BLE001 - settlement must not disclose runtime details.
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "failed",
            "FIKEYA_RUNTIME_FAILED",
            usage=_recorded_usage(request.workspace, endpoint_session_id),
            effects=_recorded_effects(request.workspace, endpoint_session_id),
        )

    effects: tuple[str, bool, str | None, int | None, int | None] | None = None
    memory: tuple[str, str, bool, str | None, str | None, int | None] | None = None
    try:
        usage = _safe_usage(result)
        if result.session_id != endpoint_session_id:
            return _failed_result(
                request, profile, endpoint_session_id, "failed", "FIKEYA_RUNTIME_FAILED"
            )
        effects = _effect_chain(result)
        memory = _memory_result(request.memory.mode, result.memory)
        if denied_call:
            return _failed_result(
                request,
                profile,
                endpoint_session_id,
                "failed",
                "FIKEYA_CAPABILITY_DENIED",
                usage=usage,
                effects=effects,
                memory=memory,
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
                effects=effects,
                memory=memory,
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
                effects=effects,
                memory=memory,
            )
        if usage is None:
            return _failed_result(
                request,
                profile,
                endpoint_session_id,
                "failed",
                "FIKEYA_USAGE_INVALID",
                effects=effects,
                memory=memory,
            )
        measurement, complete, input_tokens, cached_tokens, output_tokens = usage
        request.recheck_scope()
        select_endpoint_provider(providers, request.provider)
        _verify_memory_after_start(request.memory)
        request.recheck_expiry(clock)
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
            effects_measurement=effects[0],
            effects_complete=effects[1],
            effect_receipt_sha256=effects[2],
            tool_call_count=effects[3],
            write_count=effects[4],
            memory_mode=memory[0],
            memory_status=memory[1],
            memory_complete=memory[2],
            memory_receipt_id=memory[3],
            memory_response_sha256=memory[4],
            memory_evidence_count=memory[5],
        )
    except EndpointAuthorizationExpiredError:
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "failed",
            "FIKEYA_AUTHORIZATION_EXPIRED",
            usage=usage,
            effects=effects,
            memory=memory,
        )
    except Exception:  # noqa: BLE001 - settlement must not disclose validation details.
        return _failed_result(
            request,
            profile,
            endpoint_session_id,
            "failed",
            "FIKEYA_RUNTIME_FAILED",
            usage=usage,
            effects=effects,
            memory=memory,
        )


def select_endpoint_provider(
    providers: ProviderStore, expected: EndpointProvider
) -> ProviderProfile:
    """Require exact profile metadata and model identity at every boundary."""

    profile = providers.get(expected.profile_name)
    if profile.model != expected.model:
        raise ProviderError(
            "Endpoint model does not match its configured provider profile."
        )
    if sha256_text(stable_json(profile.as_json())) != expected.profile_sha256:
        raise ProviderError(
            "Endpoint provider profile digest does not match local metadata."
        )
    return profile


def _failed_result(
    request: EndpointRequest,
    profile: ProviderProfile,
    session_id: str,
    status: str,
    error_code: str,
    *,
    usage: tuple[str, bool, int | None, int | None, int | None] | None = None,
    effects: tuple[str, bool, str | None, int | None, int | None] | None = None,
    memory: tuple[str, str, bool, str | None, str | None, int | None] | None = None,
) -> EndpointResult:
    values = usage or ("unavailable", False, None, None, None)
    effect_values = effects or ("unavailable", False, None, None, None)
    memory_values = memory or _unavailable_memory(request.memory.mode)
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
        effects_measurement=effect_values[0],
        effects_complete=effect_values[1],
        effect_receipt_sha256=effect_values[2],
        tool_call_count=effect_values[3],
        write_count=effect_values[4],
        memory_mode=memory_values[0],
        memory_status=memory_values[1],
        memory_complete=memory_values[2],
        memory_receipt_id=memory_values[3],
        memory_response_sha256=memory_values[4],
        memory_evidence_count=memory_values[5],
    )


def _safe_usage(
    result: CodingRunResult,
) -> tuple[str, bool, int | None, int | None, int | None] | None:
    return _validated_usage(
        result.usage.get("measurement"),
        result.usage.get("inputTokens"),
        result.usage.get("cachedInputTokens"),
        result.usage.get("outputTokens"),
    )


def _recorded_usage(
    workspace: Workspace,
    session_id: str,
) -> tuple[str, bool, int | None, int | None, int | None] | None:
    try:
        state = StateStore(workspace.state_path)
        receipts = state.provider_call_receipts(session_id)
        if not receipts or any(
            item["usageMeasurement"] != "provider-reported" for item in receipts
        ):
            return None
        totals = state.usage_totals(session_id)
    except Exception:  # noqa: BLE001 - malformed receipts become unavailable.
        return None
    return _validated_usage(
        "provider-reported",
        totals.get("inputTokens"),
        totals.get("cachedInputTokens"),
        totals.get("outputTokens"),
    )


def _validated_usage(
    measurement: object,
    input_tokens: object,
    cached_input_tokens: object,
    output_tokens: object,
) -> tuple[str, bool, int | None, int | None, int | None] | None:
    if measurement == "unavailable":
        return None
    if measurement != "provider-reported":
        return None
    values: dict[str, int] = {}
    for name, item in (
        ("inputTokens", input_tokens),
        ("cachedInputTokens", cached_input_tokens),
        ("outputTokens", output_tokens),
    ):
        if (
            isinstance(item, bool)
            or not isinstance(item, int)
            or not 0 <= item <= MAX_ENDPOINT_USAGE_VALUE
        ):
            return None
        values[name] = item
    if values["cachedInputTokens"] > values["inputTokens"] or not any(values.values()):
        return None
    return (
        "provider-reported",
        True,
        values["inputTokens"],
        values["cachedInputTokens"],
        values["outputTokens"],
    )


def _effect_chain(
    result: CodingRunResult,
) -> tuple[str, bool, str | None, int | None, int | None]:
    ordered: list[dict[str, object]] = []
    call_ids: set[str] = set()
    write_count = 0
    for receipt in result.tool_calls:
        if (
            not isinstance(receipt.call_id, str)
            or not receipt.call_id
            or len(receipt.call_id.encode("utf-8")) > 256
            or receipt.call_id in call_ids
            or not isinstance(receipt.name, str)
            or not receipt.name
            or len(receipt.name.encode("utf-8")) > 256
            or not isinstance(receipt.status, str)
            or not receipt.status
            or len(receipt.status.encode("utf-8")) > 64
            or _DIGEST.fullmatch(receipt.arguments_sha256) is None
            or _DIGEST.fullmatch(receipt.output_sha256) is None
        ):
            raise StateError("Endpoint local effect receipt is invalid.")
        call_ids.add(receipt.call_id)
        ordered.append(
            {
                "argumentsSha256": receipt.arguments_sha256,
                "callId": receipt.call_id,
                "outputSha256": receipt.output_sha256,
                "status": receipt.status,
                "tool": receipt.name,
            }
        )
        if receipt.status == "ok" and receipt.name in {
            "workspace.replace_text",
            "workspace.write_file",
        }:
            write_count += 1
    if len(ordered) > 128:
        raise StateError("Endpoint local effect receipt chain exceeds its bound.")
    return (
        "local-receipt-chain",
        True,
        _effect_chain_sha256(ordered),
        len(ordered),
        write_count,
    )


def _recorded_effects(
    workspace: Workspace,
    session_id: str,
) -> tuple[str, bool, str | None, int | None, int | None] | None:
    try:
        events = StateStore(workspace.state_path).lineage_events(session_id)
        requests: dict[str, tuple[str, str]] = {}
        ordered: list[dict[str, object]] = []
        seen_results: set[str] = set()
        write_count = 0
        for event in events:
            payload = event.payload
            if event.event_type == EventType.TOOL_REQUESTED:
                call_id = payload.get("callId")
                tool = payload.get("toolName")
                arguments_sha256 = payload.get("argumentsSha256")
                if (
                    not isinstance(call_id, str)
                    or not isinstance(tool, str)
                    or not isinstance(arguments_sha256, str)
                    or _DIGEST.fullmatch(arguments_sha256) is None
                    or call_id in requests
                ):
                    return None
                requests[call_id] = (tool, arguments_sha256)
            elif event.event_type == EventType.TOOL_RESULT:
                call_id = payload.get("callId")
                tool = payload.get("toolName")
                status = payload.get("status")
                output_sha256 = payload.get("outputSha256")
                if (
                    not isinstance(call_id, str)
                    or call_id in seen_results
                    or call_id not in requests
                    or not isinstance(tool, str)
                    or not isinstance(status, str)
                    or not isinstance(output_sha256, str)
                    or _DIGEST.fullmatch(output_sha256) is None
                    or requests[call_id][0] != tool
                ):
                    return None
                seen_results.add(call_id)
                ordered.append(
                    {
                        "argumentsSha256": requests[call_id][1],
                        "callId": call_id,
                        "outputSha256": output_sha256,
                        "status": status,
                        "tool": tool,
                    }
                )
                if status == "ok" and tool in {
                    "workspace.replace_text",
                    "workspace.write_file",
                }:
                    write_count += 1
        if len(ordered) > 128 or set(requests) != seen_results:
            return None
        return (
            "local-receipt-chain",
            True,
            _effect_chain_sha256(ordered),
            len(ordered),
            write_count,
        )
    except Exception:  # noqa: BLE001 - partial receipt recovery must fail closed.
        return None


def _effect_chain_sha256(receipts: list[dict[str, object]]) -> str:
    return sha256_text(
        stable_json({"receipts": receipts, "schema": _EFFECT_CHAIN_SCHEMA})
    )


def _memory_result(
    mode: str,
    memory: MemoryPreparation,
) -> tuple[str, str, bool, str | None, str | None, int | None]:
    if mode == "off":
        if memory.status != "off":
            raise StateError("Memory-off run returned an inconsistent memory status.")
        return ("off", "off", True, None, None, 0)
    if memory.status == "unavailable":
        return (mode, "unavailable", False, None, None, None)
    if (
        memory.status != "used"
        or not isinstance(memory.receipt_id, str)
        or not isinstance(memory.response_sha256, str)
        or isinstance(memory.evidence_count, bool)
        or not isinstance(memory.evidence_count, int)
    ):
        raise StateError("Endpoint memory preparation is incomplete.")
    return (
        mode,
        "used",
        True,
        memory.receipt_id,
        memory.response_sha256,
        memory.evidence_count,
    )


def _unavailable_memory(
    mode: str,
) -> tuple[str, str, bool, str | None, str | None, int | None]:
    if mode == "off":
        return ("off", "off", True, None, None, 0)
    return (mode, "unavailable", False, None, None, None)


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
    approval_id = _exact_string(item, "approvalId", maximum=256)
    scope_sha256 = _digest(item, "scopeSha256")
    if scope_sha256 != expected_scope_sha256:
        raise ProviderError("Endpoint authorization scope does not match the request.")
    expires = _exact_string(item, "expiresAt", maximum=64)
    if _UTC_TIMESTAMP.fullmatch(expires) is None:
        raise ProviderError(
            "Endpoint authorization expiry must use the exact UTC timestamp format."
        )
    try:
        if "." in expires:
            timestamp, fraction = expires[:-1].split(".", 1)
            parsed_expiry = f"{timestamp}.{fraction.ljust(6, '0')}+00:00"
        else:
            parsed_expiry = f"{expires[:-1]}+00:00"
        expires_at = datetime.fromisoformat(parsed_expiry)
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
        profile_name=_exact_string(value, "profileName", maximum=128),
        profile_sha256=_digest(value, "profileSha256"),
        model=_exact_string(value, "model", maximum=256),
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
        raise ProviderError(
            "Endpoint allowedTools must be a sorted, unique bounded string array."
        )
    tools = frozenset(cast(list[str], raw))
    permitted = _READ_TOOLS if access == "read" else _WRITE_TOOLS
    if not tools <= permitted:
        raise ProviderError(
            "Endpoint capabilities include a tool denied by access mode."
        )
    return tools


def _memory(value: dict[str, object]) -> EndpointMemory:
    _exact_keys(value, _MEMORY_KEYS, "endpoint memory")
    mode = _string(value, "mode", maximum=16)
    if mode not in {"auto", "off", "required"}:
        raise ProviderError("Endpoint memory mode must be auto, off, or required.")
    if value.get("rebuild") is not False:
        raise ProviderError("Managed endpoint memory rebuild must be false.")
    raw_adapter = value.get("adapter")
    if mode == "off":
        if raw_adapter is not None:
            raise ProviderError(
                "Endpoint memory adapter must be null when memory is off."
            )
        adapter = None
    else:
        adapter = _memory_adapter(_object(raw_adapter, "endpoint memory adapter"))
    return EndpointMemory(
        mode=mode,
        context_max_characters=_integer(
            value, "contextMaxCharacters", minimum=512, maximum=64_000
        ),
        rebuild=False,
        adapter=adapter,
    )


def _memory_adapter(value: dict[str, object]) -> EndpointMemoryAdapter:
    _exact_keys(value, _MEMORY_ADAPTER_KEYS, "endpoint memory adapter")
    if value.get("kind") != "qarinah-node-sidecar":
        raise ProviderError("Endpoint memory adapter kind is unsupported.")
    version = value.get("version")
    if (
        not isinstance(version, str)
        or len(version.encode("utf-8")) > 128
        or _EXACT_SEMVER.fullmatch(version) is None
    ):
        raise ProviderError("Endpoint memory adapter version is invalid.")
    node_executable = _canonical_protocol_path(
        value.get("nodeExecutable"), "memory.adapter.nodeExecutable", file=True
    )
    sidecar_path = _canonical_protocol_path(
        value.get("sidecarPath"), "memory.adapter.sidecarPath", file=True
    )
    artifact_root = _canonical_protocol_path(
        value.get("artifactRoot"), "memory.adapter.artifactRoot", file=False
    )
    package_json_path = _canonical_protocol_path(
        value.get("packageJsonPath"), "memory.adapter.packageJsonPath", file=True
    )
    if node_executable.suffix.lower() in {".bat", ".cmd", ".ps1"}:
        raise ProviderError(
            "Endpoint memory Node executable must not be a wrapper script."
        )
    if not _path_within(artifact_root, sidecar_path) or _same_path(
        artifact_root, sidecar_path
    ):
        raise ProviderError("Endpoint memory sidecar must be inside its artifact root.")
    if (
        package_json_path.name != "package.json"
        or not _path_within(artifact_root, package_json_path)
        or _same_path(artifact_root, package_json_path)
    ):
        raise ProviderError(
            "Endpoint memory package manifest must be inside its artifact root."
        )
    package_json_sha256 = _digest(value, "packageJsonSha256")
    if artifact_file_sha256(package_json_path) != package_json_sha256:
        raise ProviderError(
            "Endpoint memory artifact binding does not match local files."
        )
    try:
        package_version, qarinah_version = _sidecar_package_metadata(package_json_path)
    except ConfigurationError as error:
        raise ProviderError("Endpoint memory package manifest is invalid.") from error
    if package_version != version:
        raise ProviderError(
            "Endpoint memory adapter version does not match its package manifest."
        )
    return EndpointMemoryAdapter(
        node_executable=node_executable,
        node_sha256=_digest(value, "nodeSha256"),
        sidecar_path=sidecar_path,
        sidecar_sha256=_digest(value, "sidecarSha256"),
        package_json_path=package_json_path,
        package_json_sha256=package_json_sha256,
        artifact_root=artifact_root,
        artifact_sha256=_digest(value, "artifactSha256"),
        version=version,
        qarinah_version=qarinah_version,
    )


def _sidecar_package_metadata(package_json_path: Path) -> tuple[str, str]:
    """Read the exact bounded package identity bound by the artifact digest."""

    try:
        raw = package_json_path.read_bytes()
        if not raw or len(raw) > 65_536:
            raise ValueError("package manifest size")
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_finite,
        )
        if not isinstance(value, dict) or value.get("name") != _SIDECAR_PACKAGE_NAME:
            raise ValueError("package name")
        version = value.get("version")
        dependencies = value.get("dependencies")
        qarinah_version = (
            dependencies.get("qarinah") if isinstance(dependencies, dict) else None
        )
        if (
            not isinstance(version, str)
            or len(version.encode("utf-8")) > 128
            or _EXACT_SEMVER.fullmatch(version) is None
            or not isinstance(qarinah_version, str)
            or len(qarinah_version.encode("utf-8")) > 128
            or _EXACT_SEMVER.fullmatch(qarinah_version) is None
        ):
            raise ValueError("package version")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ConfigurationError(
            "The managed Qarinah package manifest is invalid."
        ) from error
    return version, qarinah_version


def _verify_memory_preflight(memory: EndpointMemory, workspace: Workspace) -> None:
    if memory.adapter is None:
        return
    if _path_within(workspace.root, memory.adapter.node_executable) or _path_within(
        workspace.root, memory.adapter.sidecar_path
    ):
        raise ProviderError("Managed memory executables must be outside the workspace.")
    try:
        memory.adapter.verify()
    except ConfigurationError as error:
        raise ProviderError(
            "Endpoint memory artifact binding does not match local files."
        ) from error


def _verify_memory_after_start(memory: EndpointMemory) -> None:
    if memory.adapter is None:
        return
    try:
        memory.adapter.verify()
    except ConfigurationError as error:
        raise EndpointMemoryArtifactError(
            "The managed Qarinah sidecar changed during execution."
        ) from error


def _canonical_protocol_path(value: object, label: str, *, file: bool) -> Path:
    try:
        encoded_length = len(value.encode("utf-8")) if isinstance(value, str) else -1
    except UnicodeEncodeError:
        encoded_length = -1
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or not 0 <= encoded_length <= 4_096
        or "\0" in value
    ):
        raise ProviderError(f"Endpoint {label} must be a bounded canonical path.")
    supplied = Path(value)
    if not supplied.is_absolute():
        raise ProviderError(f"Endpoint {label} must be absolute.")
    lexical = Path(os.path.abspath(os.path.normpath(value)))
    if str(lexical) != value:
        raise ProviderError(f"Endpoint {label} must be lexically normalized.")
    try:
        resolved = supplied.resolve(strict=True)
    except OSError as error:
        raise ProviderError(f"Endpoint {label} does not exist.") from error
    if not _same_path(supplied, resolved):
        raise ProviderError(
            f"Endpoint {label} must not traverse a link or reparse point."
        )
    if file and not resolved.is_file():
        raise ProviderError(f"Endpoint {label} must be a file.")
    if not file and not resolved.is_dir():
        raise ProviderError(f"Endpoint {label} must be a directory.")
    return resolved


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left)) == os.path.normcase(str(right))


def _path_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def _bound_working_directory(value: object, cwd: str | Path | None) -> Path:
    try:
        byte_length = len(value.encode("utf-8")) if isinstance(value, str) else -1
    except UnicodeEncodeError:
        byte_length = -1
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or not 0 <= byte_length <= 4_096
        or "\0" in value
    ):
        raise WorkspaceError(
            "Endpoint workingDirectory must be a bounded absolute path."
        )
    supplied = Path(value)
    if not supplied.is_absolute():
        raise WorkspaceError("Endpoint workingDirectory must be an absolute path.")
    lexical = Path(os.path.abspath(os.path.normpath(value)))
    if str(lexical) != value:
        raise WorkspaceError("Endpoint workingDirectory must be lexically normalized.")
    try:
        resolved = supplied.resolve(strict=True)
    except OSError as error:
        raise WorkspaceError("Endpoint workingDirectory does not exist.") from error
    if not resolved.is_dir():
        raise WorkspaceError("Endpoint workingDirectory must be a directory.")
    if not _same_path(supplied, resolved):
        raise WorkspaceError(
            "Endpoint workingDirectory must not traverse a link or reparse point."
        )
    current = (
        (Path(cwd) if cwd is not None else Path.cwd()).expanduser().resolve(strict=True)
    )
    if os.path.normcase(str(resolved)) != os.path.normcase(str(current)):
        raise WorkspaceError(
            "Endpoint workingDirectory does not match the process working directory."
        )
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


def _exact_string(value: dict[str, object], name: str, *, maximum: int) -> str:
    item = _string(value, name, maximum=maximum)
    if item != item.strip():
        raise ProviderError(f"Endpoint {name} must not contain surrounding whitespace.")
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


def _integer(value: dict[str, object], name: str, *, minimum: int, maximum: int) -> int:
    item = value.get(name)
    if (
        isinstance(item, bool)
        or not isinstance(item, int)
        or not minimum <= item <= maximum
    ):
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
