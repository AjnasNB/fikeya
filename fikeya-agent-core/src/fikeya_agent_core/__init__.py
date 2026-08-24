# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Native, bounded coding-agent orchestration contracts for Fikeya."""

from .cancellation import CancellationToken
from .checkpoints import CheckpointStore, InMemoryCheckpointStore, SqliteCheckpointStore
from .errors import (
    AgentCoreError,
    CancellationError,
    ConfigurationError,
    LimitExceededError,
    ProtocolError,
    RetryableBrokerError,
    RetryableProviderError,
    SessionNotFoundError,
    StateConflictError,
)
from .models import (
    AgentEvent,
    AgentLimits,
    ApprovalDecision,
    ApprovalRequest,
    DecisionKind,
    EventKind,
    EvidenceCitation,
    EvidenceContext,
    ProviderDecision,
    ProviderRequest,
    ProviderResult,
    ProviderUsage,
    ReviewAction,
    SessionState,
    Stage,
    ToolCall,
    ToolDefinition,
    ToolResult,
)
from .protocols import ExecutionBroker, Provider
from .provider import (
    RuntimeProviderAdapter,
    decode_provider_decision,
    render_provider_prompt,
    render_system_instructions,
)

__all__ = [
    "AgentCoreError",
    "AgentEvent",
    "AgentLimits",
    "ApprovalDecision",
    "ApprovalRequest",
    "CancellationError",
    "CancellationToken",
    "CheckpointStore",
    "ConfigurationError",
    "DecisionKind",
    "EvidenceCitation",
    "EvidenceContext",
    "EventKind",
    "ExecutionBroker",
    "LimitExceededError",
    "InMemoryCheckpointStore",
    "ProtocolError",
    "Provider",
    "ProviderDecision",
    "ProviderRequest",
    "ProviderResult",
    "ProviderUsage",
    "RetryableBrokerError",
    "RetryableProviderError",
    "ReviewAction",
    "RuntimeProviderAdapter",
    "SessionNotFoundError",
    "SessionState",
    "Stage",
    "StateConflictError",
    "SqliteCheckpointStore",
    "ToolCall",
    "ToolDefinition",
    "ToolResult",
    "decode_provider_decision",
    "render_provider_prompt",
    "render_system_instructions",
]
