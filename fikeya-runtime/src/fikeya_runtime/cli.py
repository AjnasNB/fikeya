# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Dependency-light command-line interface for local runtime setup."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import signal
import sqlite3
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .agent import AgentRunner
from .credentials import CredentialResolver
from .errors import (
    CancellationError,
    FikeyaError,
    ProviderError,
    SecretStoreUnavailable,
)
from .inference import MAX_REQUEST_BYTES, CancellationToken
from .providers import (
    PROVIDER_REGISTRY,
    OSKeyringSecretStore,
    ProviderKind,
    ProviderProfile,
    ProviderStore,
    ProviderTester,
    build_profile,
)
from .qarinah import qarinah_adapter_kind, select_qarinah_adapter
from .state import StateStore
from .tool_presets import (
    PresetCatalog,
    ToolEnablementStore,
    ToolPreset,
    ToolPresetLoader,
)
from .util import utc_now
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

    statistics = subcommands.add_parser(
        "stats", help="Show local, content-free workspace usage statistics."
    )
    statistics.add_argument("--workspace", default=".")
    statistics.add_argument("--json", action="store_true")

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
        choices=("api-key", "bearer", "entra-id", "none"),
    )
    configure.add_argument(
        "--api-mode",
        choices=("responses", "chat-completions", "native"),
    )
    configure.add_argument("--api-version")
    configure.add_argument("--organization")
    configure.add_argument(
        "--secret-stdin",
        action="store_true",
        help="Read the secret from stdin instead of a hidden terminal prompt.",
    )
    configure.add_argument("--json", action="store_true")

    remove = provider_commands.add_parser(
        "remove", help="Remove a profile and credential."
    )
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

    agent = subcommands.add_parser(
        "agent", help="Run or inspect bounded model sessions."
    )
    agent_commands = agent.add_subparsers(dest="agent_command", required=True)

    agent_run = agent_commands.add_parser(
        "run", help="Run one model turn without persisting prompt or output content."
    )
    agent_run.add_argument("path", nargs="?", default=".")
    agent_run.add_argument("--provider", required=True)
    agent_run.add_argument(
        "--prompt-stdin",
        action="store_true",
        help="Read the prompt from stdin so it is absent from process arguments.",
    )
    agent_run.add_argument("--allow-network", action="store_true")
    agent_run.add_argument("--timeout", type=float, default=60.0)
    agent_run.add_argument("--max-output-tokens", type=int, default=1_024)
    agent_run.add_argument(
        "--memory",
        choices=("auto", "off", "required"),
        default="auto",
        help="Use Qarinah when available, disable it, or require cited context.",
    )
    agent_run.add_argument("--context-max-characters", type=int, default=12_000)
    agent_run.add_argument("--json", action="store_true")

    agent_execute = agent_commands.add_parser(
        "execute",
        help="Run the approval-gated plan, act, observe, and review coding loop.",
    )
    agent_execute.add_argument("path", nargs="?", default=".")
    agent_execute.add_argument("--provider", required=True)
    agent_execute.add_argument(
        "--protocol-stdin",
        action="store_true",
        help="Read one bounded start message and exact approval decisions as JSON Lines.",
    )
    agent_execute.add_argument("--allow-network", action="store_true")
    agent_execute.add_argument("--timeout", type=float, default=60.0)
    agent_execute.add_argument("--max-output-tokens", type=int, default=1_024)
    agent_execute.add_argument(
        "--memory",
        choices=("auto", "off", "required"),
        default="auto",
    )
    agent_execute.add_argument("--context-max-characters", type=int, default=12_000)
    agent_execute.add_argument(
        "--allow-executable",
        action="append",
        default=[],
        help="Replace the default process allowlist with this repeatable executable name.",
    )
    agent_execute.add_argument("--json-lines", action="store_true")

    agent_cancel = agent_commands.add_parser(
        "cancel", help="Cancel one active durable session."
    )
    agent_cancel.add_argument("session_id")
    agent_cancel.add_argument("--workspace", default=".")
    agent_cancel.add_argument("--reason", default="person cancelled")
    agent_cancel.add_argument("--json", action="store_true")

    agent_receipts = agent_commands.add_parser(
        "receipts", help="List content-free provider receipts for one session."
    )
    agent_receipts.add_argument("session_id")
    agent_receipts.add_argument("--workspace", default=".")
    agent_receipts.add_argument("--json", action="store_true")

    tool = subcommands.add_parser(
        "tool", help="Inspect or explicitly enable reviewed external tools."
    )
    tool_commands = tool.add_subparsers(dest="tool_command", required=True)

    tool_list = tool_commands.add_parser("list", help="List reviewed tool presets.")
    tool_list.add_argument("--workspace")
    tool_list.add_argument("--json", action="store_true")

    tool_enable = tool_commands.add_parser(
        "enable", help="Enable one exact preset digest in an initialized workspace."
    )
    tool_enable.add_argument("preset_id")
    tool_enable.add_argument("--workspace", required=True)
    tool_enable.add_argument("--confirm-workspace", action="store_true")
    tool_enable.add_argument("--json", action="store_true")

    tool_disable = tool_commands.add_parser(
        "disable", help="Disable one preset in an initialized workspace."
    )
    tool_disable.add_argument("preset_id")
    tool_disable.add_argument("--workspace", required=True)
    tool_disable.add_argument("--json", action="store_true")

    tool_status = tool_commands.add_parser(
        "status", help="Show workspace enablement and executable diagnostics."
    )
    tool_status.add_argument("preset_id", nargs="?")
    tool_status.add_argument("--workspace", required=True)
    tool_status.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the CLI and convert expected domain errors into safe messages."""

    args = _parser().parse_args(argv)
    try:
        if args.command == "init":
            return _run_init(args)
        if args.command == "doctor":
            return _run_doctor(args)
        if args.command == "stats":
            return _run_stats(args)
        if args.command == "provider":
            return _run_provider(args)
        if args.command == "agent":
            return _run_agent(args)
        if args.command == "tool":
            return _run_tool(args)
        raise AssertionError("argparse accepted an unknown command")
    except KeyboardInterrupt:
        _emit(
            {"cancelled": True, "error": "Operation cancelled.", "ok": False},
            as_json=getattr(args, "json", False),
        )
        return 130
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
                integrity = str(
                    connection.execute("PRAGMA integrity_check").fetchone()[0]
                )
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
        checks.append(
            {
                "detail": "available",
                "name": "os-keyring",
                "ok": True,
                "optional": True,
            }
        )
    except SecretStoreUnavailable as error:
        checks.append(
            {
                "detail": str(error),
                "name": "os-keyring",
                "ok": False,
                "optional": True,
            }
        )
    qarinah_kind, qarinah_detail = qarinah_adapter_kind()
    checks.append(
        {
            "detail": qarinah_detail,
            "name": "qarinah",
            "ok": qarinah_kind is not None,
            "optional": True,
        }
    )
    required_ok = all(
        check["ok"] for check in checks if not check.get("optional", False)
    )
    _emit({"checks": checks, "ok": required_ok}, as_json=args.json)
    return 0 if required_ok else 1


def _run_stats(args: argparse.Namespace) -> int:
    workspace = Workspace.load(args.workspace)
    statistics = StateStore(workspace.state_path).workspace_statistics()
    _emit(
        {
            "ok": True,
            "source": "local-runtime-sqlite",
            "measurement": "provider-reported-only",
            "generatedAt": utc_now(),
            **statistics,
        },
        as_json=args.json,
    )
    return 0


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
            api_mode=args.api_mode,
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
        secret = CredentialResolver(store).resolve(profile)
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
    if profile.credential_type in {"none", "entra-id"}:
        if args.secret_stdin:
            raise ProviderError(
                "--secret-stdin cannot be used with credential type none or entra-id."
            )
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


def _run_agent(args: argparse.Namespace) -> int:
    workspace_path = (
        args.path if args.agent_command in {"run", "execute"} else args.workspace
    )
    workspace = Workspace.load(workspace_path)
    store = ProviderStore(runtime_home(args.home))
    runner = AgentRunner(workspace, store)
    if args.agent_command == "run":
        if args.memory != "off":
            runner.memory = select_qarinah_adapter(
                workspace_root=workspace.root,
                state=runner.state,
            )
        if not args.prompt_stdin:
            raise ProviderError(
                "Agent prompts must use --prompt-stdin so they do not enter process arguments."
            )
        prompt = sys.stdin.read(MAX_REQUEST_BYTES + 1)
        if len(prompt.encode("utf-8")) > MAX_REQUEST_BYTES:
            raise ProviderError(
                f"Agent prompt exceeds {MAX_REQUEST_BYTES} UTF-8 bytes."
            )
        cancellation = CancellationToken()
        try:
            with _cancellation_signals(cancellation):
                result = runner.run(
                    provider_name=args.provider,
                    prompt=prompt,
                    allow_network=args.allow_network,
                    timeout=args.timeout,
                    max_output_tokens=args.max_output_tokens,
                    cancellation=cancellation,
                    memory_mode=args.memory,
                    context_max_characters=args.context_max_characters,
                )
        except CancellationError:
            _emit(
                {"cancelled": True, "error": "Operation cancelled.", "ok": False},
                as_json=args.json,
            )
            return 130
        usage = result.provider_call.usage
        _emit(
            {
                "callId": result.call_id,
                "ok": True,
                "output": result.output,
                "sessionId": result.session_id,
                "memory": {
                    "coverage": result.memory.coverage,
                    "evidenceCount": result.memory.evidence_count,
                    "receiptId": result.memory.receipt_id,
                    "responseSha256": result.memory.response_sha256,
                    "status": result.memory.status,
                },
                "usage": {
                    "cachedInputTokens": usage.cached_input_tokens,
                    "inputTokens": usage.input_tokens,
                    "measurement": usage.measurement,
                    "outputTokens": usage.output_tokens,
                },
            },
            as_json=args.json,
        )
        return 0
    if args.agent_command == "execute":
        return _run_coding_agent(args, workspace, store)
    if args.agent_command == "cancel":
        runner.cancel(args.session_id, args.reason)
        _emit(
            {"cancelled": True, "ok": True, "sessionId": args.session_id},
            as_json=args.json,
        )
        return 0
    if args.agent_command == "receipts":
        receipts = runner.state.provider_call_receipts(args.session_id)
        _emit(
            {"ok": True, "receipts": list(receipts), "sessionId": args.session_id},
            as_json=args.json,
        )
        return 0
    raise AssertionError("argparse accepted an unknown agent command")


def _run_coding_agent(
    args: argparse.Namespace,
    workspace: Workspace,
    store: ProviderStore,
) -> int:
    if not args.protocol_stdin or not args.json_lines:
        raise ProviderError(
            "The coding loop requires --protocol-stdin and --json-lines so every tool can pause for an exact decision."
        )
    # A JSON-escaped UTF-8 prompt can occupy substantially more bytes than the decoded text.
    # Bound the wire representation independently, then enforce the decoded prompt limit below.
    start = _read_protocol_message((MAX_REQUEST_BYTES * 4) + 4_096)
    if set(start) != {"prompt", "type"} or start.get("type") != "start":
        raise ProviderError(
            "The first protocol message must contain only type=start and prompt."
        )
    prompt = start.get("prompt")
    if (
        not isinstance(prompt, str)
        or not prompt
        or len(prompt.encode("utf-8")) > MAX_REQUEST_BYTES
    ):
        raise ProviderError(f"Agent prompt must be 1-{MAX_REQUEST_BYTES} UTF-8 bytes.")

    try:
        from fikeya_agent_core import (
            AgentCoreError,
            ApprovalDecision,
            CancellationToken as CoreCancellationToken,
        )
        from .coding import CodingAgentRunner
    except ImportError as error:
        raise ProviderError(
            "Fikeya Agent Core is unavailable. Install the matched fikeya-agent-core package."
        ) from error

    async def approve(request: dict[str, object]) -> ApprovalDecision:
        _emit_protocol_message(request)
        response = await asyncio.to_thread(_read_protocol_message, 65_536)
        if (
            set(response) != {"decision", "requestId", "type"}
            or response.get("type") != "approval"
        ):
            raise ProviderError(
                "Approval responses must contain only type, requestId, and decision."
            )
        if response.get("requestId") != request["requestId"]:
            raise ProviderError("Approval response does not match the active request.")
        try:
            return ApprovalDecision(response.get("decision"))
        except ValueError as error:
            raise ProviderError(
                "Approval decision must be allow_once, deny_once, or cancel."
            ) from error

    allowed = frozenset(args.allow_executable) if args.allow_executable else None
    runner = CodingAgentRunner(workspace, store, allowed_executables=allowed)
    cancellation = CoreCancellationToken()
    try:
        with _cancellation_signals(cancellation):
            result = asyncio.run(
                runner.run(
                    provider_name=args.provider,
                    prompt=prompt,
                    allow_network=args.allow_network,
                    timeout=args.timeout,
                    max_output_tokens=args.max_output_tokens,
                    cancellation=cancellation,
                    approval_handler=approve,
                    progress_handler=_emit_protocol_message,
                    memory_mode=args.memory,
                    context_max_characters=args.context_max_characters,
                )
            )
    except AgentCoreError as error:
        raise ProviderError(f"Coding loop stopped safely: {error}") from error
    _emit_protocol_message({"type": "result", **result.as_json()})
    return 0 if result.status in {"completed", "cancelled"} else 2


def _read_protocol_message(maximum_bytes: int) -> dict[str, object]:
    line = sys.stdin.buffer.readline(maximum_bytes + 1)
    if not line:
        raise ProviderError(
            "The coding protocol ended before a required message arrived."
        )
    if len(line) > maximum_bytes or not line.endswith(b"\n"):
        raise ProviderError(
            "A coding protocol message exceeded its byte limit or lacked a newline."
        )
    try:
        value = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderError(
            "Coding protocol messages must be UTF-8 JSON objects."
        ) from error
    if not isinstance(value, dict):
        raise ProviderError("Coding protocol messages must be JSON objects.")
    return value


def _emit_protocol_message(value: dict[str, object]) -> None:
    print(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        flush=True,
    )


def _run_tool(args: argparse.Namespace) -> int:
    catalog = PresetCatalog()
    loader = ToolPresetLoader(catalog)
    if args.tool_command == "list":
        enablements = None
        if args.workspace is not None:
            enablements = ToolEnablementStore(Workspace.load(args.workspace))
        tools = [_tool_entry(preset, loader, enablements) for preset in catalog.list()]
        _emit({"ok": True, "tools": tools}, as_json=args.json)
        return 0
    workspace = Workspace.load(args.workspace)
    enablements = ToolEnablementStore(workspace)
    if args.tool_command == "enable":
        preset = catalog.get(args.preset_id)
        status = enablements.enable(
            preset,
            confirmed=args.confirm_workspace,
        )
        _emit(
            {
                "enabled": status.enabled,
                "message": f"Enabled {preset.display_name} for this workspace.",
                "ok": True,
                "tool": _tool_entry(preset, loader, enablements),
                "workspaceId": workspace.config.workspace_id,
            },
            as_json=args.json,
        )
        return 0
    if args.tool_command == "disable":
        preset = catalog.get(args.preset_id)
        removed = enablements.disable(preset.preset_id)
        _emit(
            {
                "disabled": True,
                "message": f"Disabled {preset.display_name} for this workspace.",
                "ok": True,
                "previouslyEnabled": removed,
                "tool": _tool_entry(preset, loader, enablements),
                "workspaceId": workspace.config.workspace_id,
            },
            as_json=args.json,
        )
        return 0
    if args.tool_command == "status":
        presets = (
            (catalog.get(args.preset_id),)
            if args.preset_id is not None
            else catalog.list()
        )
        _emit(
            {
                "ok": True,
                "tools": [
                    _tool_entry(preset, loader, enablements) for preset in presets
                ],
                "workspaceId": workspace.config.workspace_id,
            },
            as_json=args.json,
        )
        return 0
    raise AssertionError("argparse accepted an unknown tool command")


def _tool_entry(
    preset: ToolPreset,
    loader: ToolPresetLoader,
    enablements: ToolEnablementStore | None,
) -> dict[str, object]:
    status = enablements.status(preset) if enablements is not None else None
    diagnostic = loader.diagnostic(preset)
    value = preset.public_json()
    value.update(
        {
            "enabled": status.enabled if status is not None else False,
            "enabledAt": status.enabled_at if status is not None else None,
            "executableFound": diagnostic.executable_found,
            "provenanceWarning": diagnostic.warning,
            "requiresConfirmation": (
                status.requires_confirmation if status is not None else False
            ),
        }
    )
    return value


@contextmanager
def _cancellation_signals(token: CancellationToken) -> Iterator[None]:
    watched = [signal.SIGINT]
    if hasattr(signal, "SIGTERM"):
        watched.append(signal.SIGTERM)
    previous: dict[signal.Signals, object] = {}

    def cancel(_signum: int, _frame: object) -> None:
        token.cancel()

    try:
        for watched_signal in watched:
            previous[watched_signal] = signal.getsignal(watched_signal)
            signal.signal(watched_signal, cancel)
        yield
    finally:
        for watched_signal, handler in previous.items():
            signal.signal(watched_signal, handler)


def _emit(value: dict[str, object], *, as_json: bool) -> None:
    if as_json:
        print(
            json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        )
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
    elif isinstance(value.get("output"), str):
        print(value["output"])
    else:
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
