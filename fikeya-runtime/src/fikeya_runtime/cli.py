# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Dependency-light command-line interface for local runtime setup."""

from __future__ import annotations

import argparse
import getpass
import json
import shutil
import sqlite3
import sys
from pathlib import Path

from .errors import FikeyaError, ProviderError, SecretStoreUnavailable
from .providers import (
    PROVIDER_REGISTRY,
    OSKeyringSecretStore,
    ProviderKind,
    ProviderProfile,
    ProviderStore,
    ProviderTester,
    build_profile,
)
from .state import StateStore
from .workspace import Workspace, initialize_workspace, runtime_home


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fikeya",
        description="Local-first Fikeya runtime and provider configuration.",
    )
    parser.add_argument(
        "--home",
        type=Path,
        help="Override non-secret Fikeya user metadata (or use FIKEYA_HOME).",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    initialize = subcommands.add_parser("init", help="Initialize a local workspace.")
    initialize.add_argument("path", nargs="?", default=".")
    initialize.add_argument("--json", action="store_true")

    doctor = subcommands.add_parser("doctor", help="Verify local runtime dependencies.")
    doctor.add_argument("path", nargs="?", default=".")
    doctor.add_argument("--json", action="store_true")

    provider = subcommands.add_parser("provider", help="Manage model providers.")
    provider_commands = provider.add_subparsers(dest="provider_command", required=True)

    provider_list = provider_commands.add_parser("list", help="List provider profiles.")
    provider_list.add_argument("--available", action="store_true")
    provider_list.add_argument("--json", action="store_true")

    configure = provider_commands.add_parser(
        "configure", help="Configure metadata and store a credential in the OS keyring."
    )
    configure.add_argument("name")
    configure.add_argument(
        "--kind",
        required=True,
        choices=[kind.value for kind in ProviderKind],
    )
    configure.add_argument("--base-url")
    configure.add_argument("--model", required=True)
    configure.add_argument(
        "--credential-type",
        choices=("api-key", "bearer", "none"),
    )
    configure.add_argument("--api-version")
    configure.add_argument("--organization")
    configure.add_argument(
        "--secret-stdin",
        action="store_true",
        help="Read the secret from stdin instead of a hidden terminal prompt.",
    )
    configure.add_argument("--json", action="store_true")

    remove = provider_commands.add_parser("remove", help="Remove a profile and credential.")
    remove.add_argument("name")
    remove.add_argument("--json", action="store_true")

    test = provider_commands.add_parser(
        "test", help="Explicitly make one content-free provider connectivity probe."
    )
    test.add_argument("name")
    test.add_argument(
        "--allow-network",
        action="store_true",
        help="Required opt-in for the provider network request.",
    )
    test.add_argument("--timeout", type=float, default=10.0)
    test.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the CLI and convert expected domain errors into safe messages."""

    args = _parser().parse_args(argv)
    try:
        if args.command == "init":
            return _run_init(args)
        if args.command == "doctor":
            return _run_doctor(args)
        if args.command == "provider":
            return _run_provider(args)
        raise AssertionError("argparse accepted an unknown command")
    except (FikeyaError, OSError, sqlite3.Error) as error:
        _emit({"error": str(error), "ok": False}, as_json=getattr(args, "json", False))
        return 2


def _run_init(args: argparse.Namespace) -> int:
    workspace, created = initialize_workspace(args.path)
    _emit(
        {
            "created": created,
            "message": (
                "Initialized Fikeya workspace."
                if created
                else "Fikeya workspace is already initialized."
            ),
            "ok": True,
            "root": str(workspace.root),
            "workspaceId": workspace.config.workspace_id,
        },
        as_json=args.json,
    )
    return 0


def _run_doctor(args: argparse.Namespace) -> int:
    checks: list[dict[str, object]] = []
    checks.append(
        {
            "detail": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "name": "python",
            "ok": sys.version_info >= (3, 10),
        }
    )
    workspace: Workspace | None = None
    try:
        workspace = Workspace.load(args.path)
        checks.append(
            {
                "detail": workspace.config.workspace_id,
                "name": "workspace",
                "ok": True,
            }
        )
    except FikeyaError as error:
        checks.append({"detail": str(error), "name": "workspace", "ok": False})
    if workspace is not None:
        try:
            StateStore(workspace.state_path).initialize()
            with sqlite3.connect(workspace.state_path) as connection:
                integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            checks.append(
                {
                    "detail": integrity,
                    "name": "sqlite",
                    "ok": integrity == "ok",
                }
            )
        except (sqlite3.Error, FikeyaError) as error:
            checks.append({"detail": str(error), "name": "sqlite", "ok": False})
    provider_store = ProviderStore(runtime_home(args.home))
    try:
        provider_count = len(provider_store.list())
        checks.append(
            {
                "detail": f"{provider_count} configured",
                "name": "provider-metadata",
                "ok": True,
            }
        )
    except FikeyaError as error:
        checks.append({"detail": str(error), "name": "provider-metadata", "ok": False})
    try:
        OSKeyringSecretStore()._keyring()
        checks.append({"detail": "available", "name": "os-keyring", "ok": True})
    except SecretStoreUnavailable as error:
        checks.append({"detail": str(error), "name": "os-keyring", "ok": False})
    qarinah_path = shutil.which("qarinah")
    checks.append(
        {
            "detail": "installed" if qarinah_path else "optional CLI not found",
            "name": "qarinah",
            "ok": qarinah_path is not None,
            "optional": True,
        }
    )
    required_ok = all(check["ok"] for check in checks if not check.get("optional", False))
    _emit({"checks": checks, "ok": required_ok}, as_json=args.json)
    return 0 if required_ok else 1


def _run_provider(args: argparse.Namespace) -> int:
    store = ProviderStore(runtime_home(args.home))
    if args.provider_command == "list":
        if args.available:
            entries = [
                {
                    "defaultBaseUrl": definition.default_base_url,
                    "defaultCredentialType": definition.default_credential_type,
                    "kind": definition.kind.value,
                    "secretRequired": definition.secret_required,
                }
                for definition in PROVIDER_REGISTRY.values()
            ]
        else:
            entries = [
                {
                    "baseUrl": profile.base_url,
                    "credentialType": profile.credential_type,
                    "kind": profile.kind.value,
                    "model": profile.model,
                    "name": profile.name,
                    "secretConfigured": profile.secret_ref is not None,
                }
                for profile in store.list()
            ]
        _emit({"ok": True, "providers": entries}, as_json=args.json)
        return 0
    if args.provider_command == "configure":
        kind = ProviderKind(args.kind)
        profile = build_profile(
            name=args.name,
            kind=kind,
            base_url=args.base_url,
            model=args.model,
            credential_type=args.credential_type,
            api_version=args.api_version,
            organization=args.organization,
        )
        secret = _read_provider_secret(args, profile, store)
        stored = store.configure(profile, secret)
        _emit(
            {
                "kind": stored.kind.value,
                "message": "Provider configured without persisting credential bytes.",
                "name": stored.name,
                "ok": True,
                "secretConfigured": stored.secret_ref is not None,
            },
            as_json=args.json,
        )
        return 0
    if args.provider_command == "remove":
        removed = store.remove(args.name)
        _emit(
            {"name": args.name, "ok": True, "removed": removed},
            as_json=args.json,
        )
        return 0
    if args.provider_command == "test":
        profile = store.get(args.name)
        secret = store.resolve_secret(profile)
        result = ProviderTester().test(
            profile,
            secret,
            allow_network=args.allow_network,
            timeout=args.timeout,
        )
        _emit(
            {
                "latencyMs": result.latency_ms,
                "name": result.provider_name,
                "ok": True,
                "statusCode": result.status_code,
            },
            as_json=args.json,
        )
        return 0
    raise AssertionError("argparse accepted an unknown provider command")


def _read_provider_secret(
    args: argparse.Namespace,
    profile: ProviderProfile,
    store: ProviderStore,
) -> str | None:
    if profile.credential_type == "none":
        if args.secret_stdin:
            raise ProviderError("--secret-stdin cannot be used with credential type none.")
        return None
    if args.secret_stdin:
        value = sys.stdin.read(16_385)
        if len(value) > 16_384:
            raise ProviderError("Provider secret exceeds 16384 characters.")
        return value.rstrip("\r\n")
    existing = None
    try:
        existing = store.get(profile.name)
    except ProviderError:
        pass
    if not sys.stdin.isatty():
        if existing is not None and existing.secret_ref is not None:
            return None
        raise ProviderError(
            "A new provider secret requires a hidden terminal prompt or --secret-stdin."
        )
    prompt = "Provider secret"
    if existing is not None and existing.secret_ref is not None:
        prompt += " (leave blank to keep existing)"
    value = getpass.getpass(f"{prompt}: ")
    return value or None


def _emit(value: dict[str, object], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
        return
    if value.get("ok") is False and "error" in value:
        print(f"Error: {value['error']}", file=sys.stderr)
        return
    if "checks" in value:
        checks = value["checks"]
        assert isinstance(checks, list)
        for check in checks:
            assert isinstance(check, dict)
            marker = "ok" if check.get("ok") else "fail"
            optional = " (optional)" if check.get("optional") else ""
            print(f"[{marker}] {check.get('name')}{optional}: {check.get('detail')}")
        return
    if "providers" in value:
        providers = value["providers"]
        assert isinstance(providers, list)
        if not providers:
            print("No provider profiles configured.")
        for provider in providers:
            assert isinstance(provider, dict)
            print(json.dumps(provider, ensure_ascii=False, sort_keys=True))
        return
    message = value.get("message")
    if message:
        print(message)
    else:
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
