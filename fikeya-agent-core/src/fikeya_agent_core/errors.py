# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Errors exposed by the Fikeya orchestration boundary."""


class AgentCoreError(Exception):
    """Base class for failures with stable orchestration meaning."""


class ConfigurationError(AgentCoreError):
    """Raised when a caller supplies an unsafe or contradictory configuration."""


class LimitExceededError(AgentCoreError):
    """Raised before an operation crosses a configured resource boundary."""


class ProtocolError(AgentCoreError):
    """Raised when a provider or broker violates its typed contract."""


class SessionNotFoundError(AgentCoreError):
    """Raised when a checkpointed session does not exist."""


class StateConflictError(AgentCoreError):
    """Raised when optimistic checkpoint revision validation fails."""


class CancellationError(AgentCoreError):
    """Raised at a cooperative cancellation boundary."""


class RetryableProviderError(AgentCoreError):
    """A transient model-provider failure eligible for a bounded retry."""


class RetryableBrokerError(AgentCoreError):
    """Deprecated marker retained for source compatibility; broker calls are never auto-retried."""


class BrokerOutcomeUncertainError(AgentCoreError):
    """Raised after an execution attempt whose exact outcome requires reconciliation."""
