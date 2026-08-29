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


class ProviderConnectivityError(ProviderError):
    """Raised when a provider cannot be reached before returning a response."""

    kind = "connectivity"
    retryable = True

    def __init__(self) -> None:
        super().__init__(
            "Provider endpoint could not be reached before a response was received."
        )


class ProviderHttpError(ProviderError):
    """Raised for an HTTP response without retaining provider body content."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.kind = (
            "quota"
            if status_code == 429
            else "authentication"
            if status_code in {401, 403}
            else "provider"
        )
        self.retryable = status_code in {408, 409, 425, 429} or status_code >= 500
        super().__init__(
            f"Provider returned HTTP {status_code}; response body was not retained."
        )


class ProviderOutputLimitError(ProviderError):
    """Raised when reported output usage exceeds one provider call's signed cap."""

    def __init__(self) -> None:
        super().__init__(
            "Provider-reported output usage exceeded the configured per-call limit."
        )


class CancellationError(FikeyaError):
    """Raised when a person cancels a bounded runtime operation."""


class StateError(FikeyaError):
    """Raised when session state violates an invariant."""


class ApprovalError(FikeyaError):
    """Raised when tool execution lacks a matching live approval."""


class ToolPresetError(FikeyaError):
    """Raised when an external-tool preset or launch violates its boundary."""
