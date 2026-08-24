# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""One-shot agent execution with durable, content-free evidence receipts."""

from __future__ import annotations

from dataclasses import dataclass

from .credentials import CredentialResolver
from .errors import CancellationError
from .events import EventType
from .inference import (
    CancellationToken,
    InferenceRequest,
    ProviderCallResult,
    ProviderExecutor,
    provider_request_fingerprint,
)
from .providers import ProviderStore
from .state import StateStore
from .workspace import Workspace


@dataclass(frozen=True, slots=True)
class AgentRunResult:
    """Live output and its content-free durable identifiers."""

    session_id: str
    call_id: str
    output: str
    provider_call: ProviderCallResult


class AgentRunner:
    """Run one bounded model turn and persist no prompt or response content."""

    def __init__(
        self,
        workspace: Workspace,
        providers: ProviderStore,
        *,
        executor: ProviderExecutor | None = None,
        credentials: CredentialResolver | None = None,
    ) -> None:
        self.workspace = workspace
        self.providers = providers
        self.executor = executor or ProviderExecutor()
        self.credentials = credentials or CredentialResolver(providers)
        self.state = StateStore(workspace.state_path)

    def run(
        self,
        *,
        provider_name: str,
        prompt: str,
        allow_network: bool,
        timeout: float,
        max_output_tokens: int,
        cancellation: CancellationToken,
    ) -> AgentRunResult:
        """Execute one request with exact call hashes and provider-reported usage."""

        profile = self.providers.get(provider_name)
        request = InferenceRequest(
            prompt=prompt,
            max_output_tokens=max_output_tokens,
        )
        fingerprint = provider_request_fingerprint(profile, request)
        session = self.state.create_session(
            metadata={
                "mode": "agent",
                "model": profile.model,
                "provider": profile.name,
            }
        )
        requested = self.state.append_event(
            session.session_id,
            EventType.PROVIDER_REQUESTED,
            {
                "apiMode": profile.api_mode,
                "model": profile.model,
                "provider": profile.name,
                "requestBytes": fingerprint.request_bytes,
                "requestSha256": fingerprint.request_sha256,
            },
        )
        try:
            credential = self.credentials.resolve(profile)
            result = self.executor.execute(
                profile,
                credential,
                request,
                allow_network=allow_network,
                timeout=timeout,
                cancellation=cancellation,
            )
            cancellation.raise_if_cancelled()
        except CancellationError:
            self.state.cancel_session(session.session_id, "person cancelled")
            raise
        except Exception:
            self.state.cancel_session(session.session_id, "provider request failed")
            raise
        usage = result.usage
        call_id = self.state.record_provider_call(
            session.session_id,
            provider_name=profile.name,
            model_name=profile.model,
            api_mode=profile.api_mode,
            request_sha256=result.request_sha256,
            response_sha256=result.response_sha256,
            request_bytes=result.request_bytes,
            response_bytes=result.response_bytes,
            status_code=result.status_code,
            duration_ms=result.duration_ms,
            usage_measurement=usage.measurement,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cached_input_tokens=usage.cached_input_tokens,
        )
        if usage.measurement == "provider-reported":
            assert usage.input_tokens is not None
            assert usage.output_tokens is not None
            assert usage.cached_input_tokens is not None
            self.state.record_usage(
                session.session_id,
                provider_name=profile.name,
                model_name=profile.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cached_input_tokens=usage.cached_input_tokens,
            )
        result_payload: dict[str, object] = {
            "callId": call_id,
            "durationMs": result.duration_ms,
            "responseBytes": result.response_bytes,
            "responseSha256": result.response_sha256,
            "statusCode": result.status_code,
            "usageMeasurement": usage.measurement,
        }
        if usage.measurement == "provider-reported":
            result_payload.update(
                {
                    "cachedInputTokens": usage.cached_input_tokens,
                    "inputTokens": usage.input_tokens,
                    "outputTokens": usage.output_tokens,
                }
            )
        self.state.append_event(
            session.session_id,
            EventType.PROVIDER_RESULT,
            result_payload,
            causation_id=requested.event_id,
        )
        self.state.complete_session(session.session_id, "model response returned")
        return AgentRunResult(
            session_id=session.session_id,
            call_id=call_id,
            output=result.text,
            provider_call=result,
        )

    def cancel(self, session_id: str, reason: str) -> None:
        """Cancel an active durable session."""

        self.state.cancel_session(session_id, reason)
