# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Provider metadata, OS-keyring credential references, and explicit probes."""

from __future__ import annotations

import enum
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .errors import ConfigurationError, ProviderError, SecretStoreUnavailable
from .util import atomic_write_text, read_json_object, stable_json, validate_identifier

KEYRING_SERVICE = "dev.fikeya.runtime"
PROVIDER_CONFIG_VERSION = 2
_CREDENTIAL_TYPES = {"api-key", "bearer", "entra-id", "none"}
_API_MODES = {"responses", "chat-completions", "native"}


class ProviderKind(str, enum.Enum):
    """Provider protocols available through the first-party registry."""

    AZURE_OPENAI = "azure-openai"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OPENROUTER = "openrouter"
    NVIDIA_NIM = "nvidia-nim"
    OLLAMA = "ollama"
    OPENAI_COMPATIBLE = "openai-compatible"


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    """Static defaults and credential requirements for one provider kind."""

    kind: ProviderKind
    default_base_url: str | None
    default_credential_type: str
    secret_required: bool
    default_api_mode: str
    supported_api_modes: tuple[str, ...]


PROVIDER_REGISTRY: dict[ProviderKind, ProviderDefinition] = {
    ProviderKind.AZURE_OPENAI: ProviderDefinition(
        kind=ProviderKind.AZURE_OPENAI,
        default_base_url=None,
        default_credential_type="entra-id",
        secret_required=False,
        default_api_mode="responses",
        supported_api_modes=("responses", "chat-completions"),
    ),
    ProviderKind.OPENAI: ProviderDefinition(
        kind=ProviderKind.OPENAI,
        default_base_url="https://api.openai.com/v1",
        default_credential_type="bearer",
        secret_required=True,
        default_api_mode="responses",
        supported_api_modes=("responses", "chat-completions"),
    ),
    ProviderKind.ANTHROPIC: ProviderDefinition(
        kind=ProviderKind.ANTHROPIC,
        default_base_url="https://api.anthropic.com/v1",
        default_credential_type="api-key",
        secret_required=True,
        default_api_mode="native",
        supported_api_modes=("native",),
    ),
    ProviderKind.OPENROUTER: ProviderDefinition(
        kind=ProviderKind.OPENROUTER,
        default_base_url="https://openrouter.ai/api/v1",
        default_credential_type="bearer",
        secret_required=True,
        default_api_mode="chat-completions",
        supported_api_modes=("responses", "chat-completions"),
    ),
    ProviderKind.NVIDIA_NIM: ProviderDefinition(
        kind=ProviderKind.NVIDIA_NIM,
        default_base_url="https://integrate.api.nvidia.com/v1",
        default_credential_type="bearer",
        secret_required=True,
        default_api_mode="chat-completions",
        supported_api_modes=("responses", "chat-completions"),
    ),
    ProviderKind.OLLAMA: ProviderDefinition(
        kind=ProviderKind.OLLAMA,
        default_base_url="http://127.0.0.1:11434/v1",
        default_credential_type="none",
        secret_required=False,
        default_api_mode="chat-completions",
        supported_api_modes=("chat-completions",),
    ),
    ProviderKind.OPENAI_COMPATIBLE: ProviderDefinition(
        kind=ProviderKind.OPENAI_COMPATIBLE,
        default_base_url=None,
        default_credential_type="bearer",
        secret_required=False,
        default_api_mode="chat-completions",
        supported_api_modes=("responses", "chat-completions"),
    ),
}


class SecretStore(Protocol):
    """Minimal interface used to isolate credential backends in tests."""

    def set(self, account: str, secret: str) -> str:
        """Store a secret and return an opaque reference."""

    def get(self, reference: str) -> str:
        """Resolve a previously stored opaque reference."""

    def delete(self, reference: str) -> None:
        """Delete a stored secret if it exists."""


class OSKeyringSecretStore:
    """Credential storage backed only by the active OS keyring."""

    def _keyring(self) -> object:
        try:
            import keyring
            import keyring.errors
        except ImportError as error:
            raise SecretStoreUnavailable(
                "The 'keyring' package is required for provider credentials."
            ) from error
        backend = keyring.get_keyring()
        if float(getattr(backend, "priority", 0)) <= 0:
            raise SecretStoreUnavailable(
                "No usable operating-system keyring backend is available."
            )
        return keyring

    @staticmethod
    def _account(reference: str) -> str:
        prefix = f"keyring://{KEYRING_SERVICE}/"
        if not reference.startswith(prefix):
            raise SecretStoreUnavailable("Credential reference is not owned by Fikeya.")
        account = reference[len(prefix) :]
        validate_identifier(account, "credential account")
        return account

    def set(self, account: str, secret: str) -> str:
        """Write a non-empty secret without returning its value."""

        validate_identifier(account, "credential account")
        if not secret or secret.strip() != secret:
            raise ProviderError(
                "Provider secret must be non-empty and have no outer whitespace."
            )
        keyring_module = self._keyring()
        try:
            keyring_module.set_password(KEYRING_SERVICE, account, secret)
        except Exception as error:
            raise SecretStoreUnavailable(
                "The OS keyring rejected the credential write."
            ) from error
        return f"keyring://{KEYRING_SERVICE}/{account}"

    def get(self, reference: str) -> str:
        """Read a secret for immediate request construction."""

        keyring_module = self._keyring()
        try:
            secret = keyring_module.get_password(
                KEYRING_SERVICE, self._account(reference)
            )
        except Exception as error:
            raise SecretStoreUnavailable(
                "The OS keyring rejected the credential read."
            ) from error
        if not secret:
            raise SecretStoreUnavailable(
                "The provider credential is missing from the OS keyring."
            )
        return secret

    def delete(self, reference: str) -> None:
        """Delete a credential without exposing whether a value existed."""

        try:
            keyring_module = self._keyring()
            keyring_module.delete_password(KEYRING_SERVICE, self._account(reference))
        except Exception:  # noqa: BLE001 - deletion is intentionally best effort across backends.
            return


@dataclass(frozen=True, slots=True)
class ProviderProfile:
    """Non-secret provider configuration safe to serialize."""

    name: str
    kind: ProviderKind
    base_url: str
    model: str
    credential_type: str
    api_mode: str
    secret_ref: str | None = None
    api_version: str | None = None
    organization: str | None = None

    def __post_init__(self) -> None:
        validate_identifier(self.name, "provider name")
        _validate_base_url(self.base_url)
        if not self.model or len(self.model) > 256:
            raise ConfigurationError("Provider model must be 1-256 characters.")
        if self.credential_type not in _CREDENTIAL_TYPES:
            raise ConfigurationError(
                "credential_type must be api-key, bearer, entra-id, or none."
            )
        if self.credential_type in {"none", "entra-id"} and self.secret_ref is not None:
            raise ConfigurationError(
                "Credential-free and Entra ID profiles cannot contain a secret reference."
            )
        if (
            self.credential_type == "entra-id"
            and self.kind != ProviderKind.AZURE_OPENAI
        ):
            raise ConfigurationError(
                "Entra ID credentials are supported only for Azure OpenAI."
            )
        definition = PROVIDER_REGISTRY[self.kind]
        if (
            self.api_mode not in _API_MODES
            or self.api_mode not in definition.supported_api_modes
        ):
            raise ConfigurationError(
                f"{self.kind.value} does not support API mode {self.api_mode}."
            )
        if self.secret_ref is not None and not self.secret_ref.startswith(
            f"keyring://{KEYRING_SERVICE}/"
        ):
            raise ConfigurationError("Only Fikeya OS-keyring references are accepted.")
        if self.api_version is not None and (
            not self.api_version or len(self.api_version) > 64
        ):
            raise ConfigurationError("api_version must be at most 64 characters.")
        if self.organization is not None and (
            not self.organization or len(self.organization) > 128
        ):
            raise ConfigurationError("organization must be at most 128 characters.")

    def as_json(self) -> dict[str, object]:
        """Return only non-secret metadata and an opaque keyring reference."""

        return {
            "apiVersion": self.api_version,
            "apiMode": self.api_mode,
            "baseUrl": self.base_url,
            "credentialType": self.credential_type,
            "kind": self.kind.value,
            "model": self.model,
            "name": self.name,
            "organization": self.organization,
            "secretRef": self.secret_ref,
        }

    @classmethod
    def from_json(cls, value: dict[str, object]) -> ProviderProfile:
        """Validate a provider profile from disk."""

        expected = {
            "apiMode",
            "apiVersion",
            "baseUrl",
            "credentialType",
            "kind",
            "model",
            "name",
            "organization",
            "secretRef",
        }
        unknown = set(value) - expected
        if unknown:
            raise ConfigurationError(
                f"Provider profile contains unknown fields: {', '.join(sorted(unknown))}."
            )
        required_strings = ("baseUrl", "credentialType", "kind", "model", "name")
        if any(not isinstance(value.get(key), str) for key in required_strings):
            raise ConfigurationError(
                "Provider profile is missing required string fields."
            )
        for optional_key in ("apiVersion", "organization", "secretRef"):
            if value.get(optional_key) is not None and not isinstance(
                value.get(optional_key), str
            ):
                raise ConfigurationError(f"{optional_key} must be a string or null.")
        try:
            kind = ProviderKind(str(value["kind"]))
        except ValueError as error:
            raise ConfigurationError(
                f"Unknown provider kind: {value['kind']}"
            ) from error
        return cls(
            name=str(value["name"]),
            kind=kind,
            base_url=str(value["baseUrl"]),
            model=str(value["model"]),
            credential_type=str(value["credentialType"]),
            api_mode=(
                str(value["apiMode"])
                if isinstance(value.get("apiMode"), str)
                else PROVIDER_REGISTRY[kind].default_api_mode
            ),
            secret_ref=(str(value["secretRef"]) if value.get("secretRef") else None),
            api_version=(str(value["apiVersion"]) if value.get("apiVersion") else None),
            organization=(
                str(value["organization"]) if value.get("organization") else None
            ),
        )


def build_profile(
    *,
    name: str,
    kind: ProviderKind,
    model: str,
    base_url: str | None = None,
    credential_type: str | None = None,
    api_mode: str | None = None,
    api_version: str | None = None,
    organization: str | None = None,
) -> ProviderProfile:
    """Build a validated profile from registry defaults."""

    definition = PROVIDER_REGISTRY[kind]
    selected_url = base_url or definition.default_base_url
    if selected_url is None:
        raise ConfigurationError(f"{kind.value} requires --base-url.")
    selected_credential = credential_type or definition.default_credential_type
    if definition.secret_required and selected_credential in {"none", "entra-id"}:
        raise ConfigurationError(
            f"{kind.value} requires an authenticated credential type."
        )
    return ProviderProfile(
        name=name,
        kind=kind,
        base_url=selected_url.rstrip("/"),
        model=model,
        credential_type=selected_credential,
        api_mode=api_mode or definition.default_api_mode,
        api_version=api_version,
        organization=organization,
    )


class ProviderStore:
    """Atomic provider metadata plus independently stored OS-keyring secrets."""

    def __init__(self, home: str | Path, secrets: SecretStore | None = None) -> None:
        self.home = Path(home).expanduser().resolve(strict=False)
        self.path = self.home / "providers.json"
        self.secrets = secrets or OSKeyringSecretStore()

    def list(self) -> tuple[ProviderProfile, ...]:
        """List profiles sorted by stable name."""

        return tuple(sorted(self._load().values(), key=lambda profile: profile.name))

    def get(self, name: str) -> ProviderProfile:
        """Return one profile without resolving its secret."""

        validate_identifier(name, "provider name")
        try:
            return self._load()[name]
        except KeyError as error:
            raise ProviderError(f"Unknown provider profile: {name}") from error

    def configure(
        self, profile: ProviderProfile, secret: str | None
    ) -> ProviderProfile:
        """Atomically save metadata while keeping credential bytes in the keyring."""

        profiles = self._load()
        previous = profiles.get(profile.name)
        secret_ref: str | None = None
        if profile.credential_type in {"none", "entra-id"}:
            if secret is not None:
                raise ProviderError(
                    "This credential-free profile does not accept a secret."
                )
        elif secret is not None:
            account = f"provider-{profile.name}-{uuid.uuid4().hex}"
            secret_ref = self.secrets.set(account, secret)
        elif previous is not None and previous.secret_ref is not None:
            secret_ref = previous.secret_ref
        else:
            raise ProviderError(
                "A provider secret is required. Use the hidden prompt or stdin."
            )
        stored = ProviderProfile(
            name=profile.name,
            kind=profile.kind,
            base_url=profile.base_url,
            model=profile.model,
            credential_type=profile.credential_type,
            api_mode=profile.api_mode,
            secret_ref=secret_ref,
            api_version=profile.api_version,
            organization=profile.organization,
        )
        profiles[stored.name] = stored
        try:
            self._save(profiles)
        except Exception:
            if secret_ref is not None and secret_ref != (
                previous.secret_ref if previous is not None else None
            ):
                self.secrets.delete(secret_ref)
            raise
        if (
            previous is not None
            and previous.secret_ref is not None
            and previous.secret_ref != secret_ref
        ):
            self.secrets.delete(previous.secret_ref)
        return stored

    def remove(self, name: str) -> bool:
        """Remove metadata and best-effort delete its OS-keyring entry."""

        validate_identifier(name, "provider name")
        profiles = self._load()
        removed = profiles.pop(name, None)
        if removed is None:
            return False
        self._save(profiles)
        if removed.secret_ref is not None:
            self.secrets.delete(removed.secret_ref)
        return True

    def resolve_secret(self, profile: ProviderProfile) -> str | None:
        """Resolve a credential only for immediate provider request construction."""

        if profile.secret_ref is None:
            return None
        return self.secrets.get(profile.secret_ref)

    def _load(self) -> dict[str, ProviderProfile]:
        if not self.path.exists():
            return {}
        value = read_json_object(self.path)
        if value.get("schemaVersion") not in {1, PROVIDER_CONFIG_VERSION}:
            raise ConfigurationError("Unsupported provider configuration version.")
        raw_profiles = value.get("providers")
        if not isinstance(raw_profiles, list):
            raise ConfigurationError(
                "Provider configuration must contain a providers array."
            )
        profiles: dict[str, ProviderProfile] = {}
        for raw_profile in raw_profiles:
            if not isinstance(raw_profile, dict):
                raise ConfigurationError("Each provider profile must be an object.")
            profile = ProviderProfile.from_json(raw_profile)
            if profile.name in profiles:
                raise ConfigurationError(f"Duplicate provider profile: {profile.name}")
            profiles[profile.name] = profile
        return profiles

    def _save(self, profiles: dict[str, ProviderProfile]) -> None:
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        value = {
            "providers": [profiles[name].as_json() for name in sorted(profiles)],
            "schemaVersion": PROVIDER_CONFIG_VERSION,
        }
        serialized = stable_json(value)
        lowered = serialized.lower()
        for forbidden in ('"apikey"', '"password"', '"secret"'):
            if forbidden in lowered:
                raise ConfigurationError(
                    "Provider metadata unexpectedly contains a secret field."
                )
        atomic_write_text(self.path, f"{serialized}\n")


@dataclass(frozen=True, slots=True)
class ProviderTestResult:
    """Content-free result from an explicitly requested connectivity probe."""

    provider_name: str
    status_code: int
    latency_ms: int


HttpProbe = Callable[[str, dict[str, str], float], int]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> urllib.request.Request | None:
        return None


def _default_http_probe(url: str, headers: dict[str, str], timeout: float) -> int:
    request = urllib.request.Request(url, headers=headers, method="GET")
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            return int(response.status)
    except urllib.error.HTTPError as error:
        return int(error.code)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ProviderError("Provider endpoint could not be reached.") from error


class ProviderTester:
    """Run one minimal probe only after an explicit network opt-in."""

    def __init__(self, probe: HttpProbe | None = None) -> None:
        self._probe = probe or _default_http_probe

    def test(
        self,
        profile: ProviderProfile,
        secret: str | None,
        *,
        allow_network: bool,
        timeout: float = 10.0,
    ) -> ProviderTestResult:
        """Probe a models endpoint without retaining or returning its response body."""

        if not allow_network:
            raise ProviderError(
                "Network probe denied. Pass --allow-network explicitly."
            )
        if timeout <= 0 or timeout > 30:
            raise ProviderError(
                "Provider probe timeout must be between 0 and 30 seconds."
            )
        url, headers = _probe_request(profile, secret)
        start = time.monotonic()
        status = self._probe(url, headers, timeout)
        latency = max(0, round((time.monotonic() - start) * 1_000))
        if status < 200 or status >= 300:
            raise ProviderError(
                f"Provider returned HTTP {status}; no response body was retained."
            )
        return ProviderTestResult(
            provider_name=profile.name,
            status_code=status,
            latency_ms=latency,
        )


def _probe_request(
    profile: ProviderProfile,
    secret: str | None,
) -> tuple[str, dict[str, str]]:
    headers = provider_headers(profile, secret)

    base_url = profile.base_url
    if profile.kind == ProviderKind.OLLAMA:
        base_url = profile.base_url.removesuffix("/v1")
        path = "/api/tags"
    elif profile.kind == ProviderKind.AZURE_OPENAI:
        if profile.base_url.rstrip("/").endswith("/openai/v1"):
            path = "/models"
        else:
            version = urllib.parse.quote(profile.api_version or "2024-10-21", safe="")
            path = f"/openai/models?api-version={version}"
    else:
        path = "/models"
    return f"{base_url.rstrip('/')}{path}", headers


def provider_headers(
    profile: ProviderProfile,
    credential: str | None,
) -> dict[str, str]:
    """Construct ephemeral request headers without logging credential bytes."""

    headers = {"Accept": "application/json", "User-Agent": "fikeya-runtime/0.1"}
    if profile.credential_type not in {"none", "entra-id"} and not credential:
        raise ProviderError("The provider credential is missing from the OS keyring.")
    if profile.credential_type == "entra-id" and not credential:
        raise ProviderError("Azure Entra ID did not provide an access token.")
    if profile.credential_type in {"bearer", "entra-id"} and credential is not None:
        headers["Authorization"] = f"Bearer {credential}"
    elif profile.credential_type == "api-key" and credential is not None:
        if profile.kind == ProviderKind.ANTHROPIC:
            headers["x-api-key"] = credential
            headers["anthropic-version"] = "2023-06-01"
        else:
            headers["api-key"] = credential
    if profile.organization is not None:
        headers["OpenAI-Organization"] = profile.organization
    return headers


def _validate_base_url(value: str) -> None:
    if len(value) > 2_048:
        raise ConfigurationError("Provider base URL is too long.")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise ConfigurationError("Provider base URL must be an absolute HTTP(S) URL.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigurationError(
            "Provider base URL cannot contain credentials, a query, or a fragment."
        )
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not loopback:
        raise ConfigurationError(
            "Plain HTTP is permitted only for a loopback provider."
        )
