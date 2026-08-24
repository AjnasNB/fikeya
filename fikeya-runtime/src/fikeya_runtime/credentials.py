# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Ephemeral provider credential resolution with no token persistence."""

from __future__ import annotations

from typing import Protocol

from .errors import ProviderError
from .providers import ProviderProfile, ProviderStore

AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"


class AccessTokenProvider(Protocol):
    """Resolve one short-lived access token for an explicit provider call."""

    def get_token(self, scope: str) -> str:
        """Return the token value without persisting it."""


class DefaultAzureAccessTokenProvider:
    """Use the Azure Identity developer/workload credential chain without a browser popup."""

    def get_token(self, scope: str) -> str:
        try:
            from azure.identity import DefaultAzureCredential
        except ImportError as error:
            raise ProviderError(
                "Azure Entra ID requires 'fikeya-runtime[azure]' to be installed."
            ) from error
        try:
            credential = DefaultAzureCredential(
                exclude_interactive_browser_credential=True,
            )
            token = credential.get_token(scope).token
        except Exception as error:
            raise ProviderError(
                "Azure Entra ID could not obtain a Cognitive Services access token."
            ) from error
        finally:
            close = getattr(locals().get("credential"), "close", None)
            if callable(close):
                close()
        if not token:
            raise ProviderError("Azure Entra ID returned an empty access token.")
        return token


class CredentialResolver:
    """Resolve keyring or workload credentials only for the lifetime of one request."""

    def __init__(
        self,
        store: ProviderStore,
        azure_tokens: AccessTokenProvider | None = None,
    ) -> None:
        self.store = store
        self.azure_tokens = azure_tokens or DefaultAzureAccessTokenProvider()

    def resolve(self, profile: ProviderProfile) -> str | None:
        """Return an ephemeral credential, never metadata suitable for serialization."""

        if profile.credential_type == "none":
            return None
        if profile.credential_type == "entra-id":
            return self.azure_tokens.get_token(AZURE_COGNITIVE_SERVICES_SCOPE)
        return self.store.resolve_secret(profile)
