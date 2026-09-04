# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
from pathlib import Path

import pytest

from fikeya_runtime.credentials import (
    AZURE_COGNITIVE_SERVICES_SCOPE,
    CredentialResolver,
)
from fikeya_runtime.errors import ConfigurationError, ProviderError
from fikeya_runtime.providers import (
    PROVIDER_REGISTRY,
    ProviderKind,
    ProviderStore,
    ProviderTester,
    build_profile,
)


class MemorySecrets:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.deleted: list[str] = []

    def set(self, account: str, secret: str) -> str:
        reference = f"keyring://dev.fikeya.runtime/{account}"
        self.values[reference] = secret
        return reference

    def get(self, reference: str) -> str:
        return self.values[reference]

    def delete(self, reference: str) -> None:
        self.deleted.append(reference)
        self.values.pop(reference, None)


def test_registry_contains_all_first_party_provider_shapes() -> None:
    assert {kind.value for kind in PROVIDER_REGISTRY} == {
        "anthropic",
        "azure-openai",
        "google-gemini",
        "groq",
        "hugging-face",
        "nvidia-nim",
        "ollama",
        "openai",
        "openai-compatible",
        "openrouter",
    }
    azure = PROVIDER_REGISTRY[ProviderKind.AZURE_OPENAI]
    assert azure.default_credential_type == "entra-id"
    assert azure.default_api_mode == "responses"
    assert azure.credential_required is False
    assert PROVIDER_REGISTRY[ProviderKind.OPENAI].credential_required is True

    gemini = build_profile(
        name="gemini",
        kind=ProviderKind.GOOGLE_GEMINI,
        model="gemini-2.5-flash",
    )
    assert gemini.base_url == "https://generativelanguage.googleapis.com/v1beta/openai"
    assert gemini.credential_type == "bearer"
    assert gemini.api_mode == "chat-completions"

    hugging_face = build_profile(
        name="hugging-face",
        kind=ProviderKind.HUGGING_FACE,
        model="openai/gpt-oss-120b:cheapest",
    )
    assert hugging_face.base_url == "https://router.huggingface.co/v1"

    groq = build_profile(
        name="groq",
        kind=ProviderKind.GROQ,
        model="openai/gpt-oss-120b",
    )
    assert groq.base_url == "https://api.groq.com/openai/v1"


def test_provider_secret_never_enters_metadata_and_rotation_deletes_old_ref(
    tmp_path: Path,
) -> None:
    secrets = MemorySecrets()
    store = ProviderStore(tmp_path, secrets)
    profile = build_profile(
        name="work",
        kind=ProviderKind.OPENROUTER,
        model="openai/gpt-oss-20b",
    )
    first = store.configure(profile, "first-private-value")
    second = store.configure(profile, "second-private-value")
    metadata = (tmp_path / "providers.json").read_text(encoding="utf-8")

    assert {
        "first_absent": "first-private-value" not in metadata,
        "second_absent": "second-private-value" not in metadata,
        "reference_present": "keyring://dev.fikeya.runtime/" in metadata,
        "rotated": first.secret_ref in secrets.deleted,
        "resolved": store.resolve_secret(second),
    } == {
        "first_absent": True,
        "second_absent": True,
        "reference_present": True,
        "rotated": True,
        "resolved": "second-private-value",
    }


def test_provider_secret_reuse_requires_the_same_trust_boundary(tmp_path: Path) -> None:
    secrets = MemorySecrets()
    store = ProviderStore(tmp_path, secrets)
    original = build_profile(
        name="work",
        kind=ProviderKind.OPENROUTER,
        model="openai/gpt-oss-20b",
    )
    stored = store.configure(original, "private-value")
    same_boundary = build_profile(
        name="work",
        kind=ProviderKind.OPENROUTER,
        model="openai/gpt-oss-120b",
    )
    reused = store.configure(same_boundary, None)
    moved_endpoint = build_profile(
        name="work",
        kind=ProviderKind.OPENROUTER,
        base_url="https://example.com/v1",
        model="openai/gpt-oss-120b",
    )

    assert reused.secret_ref == stored.secret_ref
    with pytest.raises(ProviderError, match="Enter the secret again"):
        store.configure(moved_endpoint, None)
    assert store.resolve_secret(store.get("work")) == "private-value"


def test_remote_plain_http_is_rejected_but_loopback_ollama_is_allowed() -> None:
    with pytest.raises(ConfigurationError, match="loopback"):
        build_profile(
            name="unsafe",
            kind=ProviderKind.OPENAI_COMPATIBLE,
            base_url="http://models.example.com/v1",
            model="model",
        )

    local = build_profile(name="local", kind=ProviderKind.OLLAMA, model="qwen")
    assert local.base_url == "http://127.0.0.1:11434/v1"

    with pytest.raises(ConfigurationError, match="authenticated"):
        build_profile(
            name="anonymous-openai",
            kind=ProviderKind.OPENAI,
            model="model",
            credential_type="none",
        )


def test_provider_probe_requires_opt_in_and_uses_injected_transport_only() -> None:
    calls: list[tuple[str, dict[str, str], float]] = []

    def probe(url: str, headers: dict[str, str], timeout: float) -> int:
        calls.append((url, headers, timeout))
        return 200

    profile = build_profile(
        name="nvidia",
        kind=ProviderKind.NVIDIA_NIM,
        model="example/model",
    )
    tester = ProviderTester(probe)

    with pytest.raises(ProviderError, match="denied"):
        tester.test(profile, "private", allow_network=False)
    result = tester.test(profile, "private", allow_network=True)

    assert {
        "call_count": len(calls),
        "url": calls[0][0],
        "authorization": calls[0][1]["Authorization"],
        "status": result.status_code,
    } == {
        "call_count": 1,
        "url": "https://integrate.api.nvidia.com/v1/models",
        "authorization": "Bearer private",
        "status": 200,
    }


def test_entra_id_uses_an_ephemeral_injected_token_without_keyring_access(
    tmp_path: Path,
) -> None:
    class AzureTokens:
        def __init__(self) -> None:
            self.scopes: list[str] = []

        def get_token(self, scope: str) -> str:
            self.scopes.append(scope)
            return "ephemeral-access-token"

    secrets = MemorySecrets()
    store = ProviderStore(tmp_path, secrets)
    profile = build_profile(
        name="azure-work",
        kind=ProviderKind.AZURE_OPENAI,
        base_url="https://example.openai.azure.com/openai/v1",
        model="deployment",
    )
    stored = store.configure(profile, None)
    tokens = AzureTokens()

    resolved = CredentialResolver(store, tokens).resolve(stored)

    assert resolved == "ephemeral-access-token"
    assert tokens.scopes == [AZURE_COGNITIVE_SERVICES_SCOPE]
    assert stored.secret_ref is None
    assert secrets.values == {}


def test_version_one_provider_metadata_migrates_on_next_write(tmp_path: Path) -> None:
    metadata = {
        "providers": [
            {
                "apiVersion": None,
                "baseUrl": "http://127.0.0.1:11434/v1",
                "credentialType": "none",
                "kind": "ollama",
                "model": "qwen",
                "name": "local",
                "organization": None,
                "secretRef": None,
            }
        ],
        "schemaVersion": 1,
    }
    (tmp_path / "providers.json").write_text(json.dumps(metadata), encoding="utf-8")
    store = ProviderStore(tmp_path, MemorySecrets())

    profile = store.get("local")
    store.configure(profile, None)

    rewritten = json.loads((tmp_path / "providers.json").read_text(encoding="utf-8"))
    assert profile.api_mode == "chat-completions"
    assert rewritten["schemaVersion"] == 2
    assert rewritten["providers"][0]["apiMode"] == "chat-completions"
