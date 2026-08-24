# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Domain-specific errors with messages safe to show in the CLI."""


class FikeyaError(Exception):
    """Base class for expected runtime errors."""


class ConfigurationError(FikeyaError):
    """Raised when persisted or supplied configuration is invalid."""


class WorkspaceError(FikeyaError):
    """Raised when a path crosses the authorized workspace boundary."""


class SecretStoreUnavailable(FikeyaError):
    """Raised when a usable operating-system keyring is unavailable."""


class ProviderError(FikeyaError):
    """Raised for invalid provider configuration or connectivity."""


class StateError(FikeyaError):
    """Raised when session state violates an invariant."""


class ApprovalError(FikeyaError):
    """Raised when tool execution lacks a matching live approval."""
