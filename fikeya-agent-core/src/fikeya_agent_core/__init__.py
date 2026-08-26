# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Native, bounded coding-agent orchestration contracts for Fikeya."""

from .cancellation import CancellationToken
from .checkpoints import CheckpointStore, InMemoryCheckpointStore, SqliteCheckpointStore
from .engine import AgentOrchestrator
from .errors import (
    AgentCoreError,
    AgentNoProgressError,
    BrokerOutcomeUncertainError,
    CancellationError,
    ConfigurationError,
    LimitExceededError,
    ProtocolError,
    RetryableProviderError,
    SessionNotFoundError,
    StateConflictError,
)
from .models import (
    AgentEvent,
    AgentLimits,
    ApprovalDecision,
    ApprovalGrant,
    ApprovalRequest,
    ApprovalResponse,
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
    "AgentNoProgressError",
    "AgentEvent",
    "AgentLimits",
    "AgentOrchestrator",
    "ApprovalDecision",
    "ApprovalGrant",
    "ApprovalRequest",
    "ApprovalResponse",
    "BrokerOutcomeUncertainError",
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
