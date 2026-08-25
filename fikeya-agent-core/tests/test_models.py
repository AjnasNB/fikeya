# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import hashlib

import pytest

from fikeya_agent_core import (
    AgentLimits,
    CancellationError,
    CancellationToken,
    ConfigurationError,
    DecisionKind,
    EvidenceCitation,
    EvidenceContext,
    ProtocolError,
    ProviderDecision,
    SessionState,
    ToolCall,
)


def test_evidence_context_requires_exact_content_hash_and_unique_citations() -> None:
    citation = EvidenceCitation("event:123", "a" * 64, "qarinah:event:123")
    context = EvidenceContext.from_content("bounded evidence", (citation,))

    assert context.content_sha256 == hashlib.sha256(b"bounded evidence").hexdigest()
    with pytest.raises(ConfigurationError, match="does not match"):
        EvidenceContext("changed", (citation,), "b" * 64)
    with pytest.raises(ConfigurationError, match="unique"):
        EvidenceContext.from_content("bounded evidence", (citation, citation))


def test_limits_and_provider_decisions_fail_closed() -> None:
    with pytest.raises(ConfigurationError, match="max_steps"):
        AgentLimits(max_steps=0)
    with pytest.raises(ProtocolError, match="require a tool call"):
        ProviderDecision(DecisionKind.TOOL_CALL)


def test_cancellation_token_matches_runtime_cooperative_shape() -> None:
    token = CancellationToken()
    token.raise_if_cancelled()
    token.cancel()

    assert token.cancelled is True
    with pytest.raises(CancellationError):
        token.raise_if_cancelled()


def test_non_standard_json_numbers_and_invalid_session_ids_are_rejected() -> None:
    with pytest.raises(ProtocolError, match="JSON serializable"):
        ToolCall("call:nan", "repo:read", {"offset": float("nan")})
    with pytest.raises(ConfigurationError, match="session identifier"):
        SessionState("not valid whitespace", "task")
