# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Dependency-light command-line interface for local runtime setup."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import hashlib
import json
import math
import os
import signal
import sqlite3
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fikeya_agent_core import ApprovalDecision

from . import __version__
from .agent import AgentRunner
from .autonomy import AutonomousProjectLoop, AutonomyRecord, ProviderOptions
from .browser import SUPPORTED_BROWSER_ENGINES
from .coding import CodingAgentRunner
from .conversation import parse_conversation_history
from .credentials import CredentialResolver
from .endpoint import (
    ENDPOINT_PROTOCOL,
    ENDPOINT_VERSION_SCHEMA,
    execute_endpoint_request,
    read_endpoint_request,
)
from .errors import (
    CancellationError,
    FikeyaError,
    ProviderConnectivityError,
    ProviderError,
    ProviderHttpError,
    SecretStoreUnavailable,
    ToolPresetError,
)
from .inference import MAX_REQUEST_BYTES, CancellationToken, parse_inference_images
from .mcp_broker import McpCredentialStore, preset_broker_tools
from .modes import AgentMode
from .planning import (
    PLAN_PROPOSAL_PROTOCOL,
    PLAN_REQUEST_PROTOCOL,
    PlanProposalRunner,
)
from .plans import PlanService, PlanStatus
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
    ToolStatus,
)
from .util import sha256_text, stable_json, utc_now
from .workspace import Workspace, initialize_workspace, runtime_home


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fikeya",
        description="Local-first Fikeya runtime and provider configuration.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
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

    endpoint = subcommands.add_parser(
        "endpoint", help="Serve the strict managed-endpoint execution protocol."
    )
    endpoint_commands = endpoint.add_subparsers(
        dest="endpoint_command", required=True
    )
    endpoint_version = endpoint_commands.add_parser(
        "version", help="Return the content-free runtime identity envelope."
    )
    endpoint_version.add_argument("--protocol", required=True)
    endpoint_version.add_argument("--json", action="store_true", required=True)
    endpoint_execute = endpoint_commands.add_parser(
        "execute", help="Consume one scoped v2 request from stdin."
    )
    endpoint_execute.add_argument("--protocol", required=True)
    endpoint_execute.add_argument("--json", action="store_true", required=True)

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
    agent_execute.add_argument(
        "--allow-private-browser",
        action="store_true",
        help=(
            "Permit explicitly approved browser actions to private or loopback hosts. "
            "Off by default."
        ),
    )
    agent_execute.add_argument(
        "--browser-engine",
        choices=SUPPORTED_BROWSER_ENGINES,
        default="playwright",
        help=(
            "Use Playwright by default or explicitly select the optional "
            "Puppeteer transport."
        ),
    )
    agent_execute.add_argument("--timeout", type=float, default=60.0)
    agent_execute.add_argument("--max-output-tokens", type=int, default=1_024)
    agent_execute.add_argument(
        "--mode",
        choices=[mode.value for mode in AgentMode],
        default=AgentMode.BUILD.value,
        help="Apply the matching deny-by-default tool boundary.",
    )
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

    project = subcommands.add_parser(
        "project",
        help="Run a bounded, durable plan-audit-build-audit-verify project loop.",
    )
    project_commands = project.add_subparsers(dest="project_command", required=True)

    project_start = project_commands.add_parser(
        "start",
        help="Create a durable project run and stop for exact plan review or approval.",
    )
    project_start.add_argument("path", nargs="?", default=".")
    project_start.add_argument("--provider", required=True)
    project_start.add_argument("--protocol-stdin", action="store_true")
    project_start.add_argument("--json-lines", action="store_true")
    project_start.add_argument("--allow-network", action="store_true")
    project_start.add_argument("--allow-private-browser", action="store_true")
    project_start.add_argument(
        "--browser-engine", choices=SUPPORTED_BROWSER_ENGINES, default="playwright"
    )
    project_start.add_argument("--timeout", type=float, default=120.0)
    project_start.add_argument("--max-output-tokens", type=int, default=4_096)
    project_start.add_argument(
        "--memory", choices=("auto", "off", "required"), default="auto"
    )
    project_start.add_argument("--context-max-characters", type=int, default=12_000)

    project_resume = project_commands.add_parser(
        "resume",
        help="Resume one stopped run after its exact plan was reviewed or approved.",
    )
    project_resume.add_argument("run_id")
    project_resume.add_argument("--workspace", default=".")
    project_resume.add_argument("--provider", required=True)
    project_resume.add_argument("--protocol-stdin", action="store_true")
    project_resume.add_argument("--json-lines", action="store_true")
    project_resume.add_argument("--allow-network", action="store_true")
    project_resume.add_argument("--allow-private-browser", action="store_true")
    project_resume.add_argument(
        "--browser-engine", choices=SUPPORTED_BROWSER_ENGINES, default="playwright"
    )
    project_resume.add_argument("--timeout", type=float, default=120.0)
    project_resume.add_argument("--max-output-tokens", type=int, default=4_096)
    project_resume.add_argument(
        "--memory", choices=("auto", "off", "required"), default="auto"
    )
    project_resume.add_argument("--context-max-characters", type=int, default=12_000)

    project_show = project_commands.add_parser(
        "show", help="Show one durable project record and its content-free history."
    )
    project_show.add_argument("run_id")
    project_show.add_argument("--workspace", default=".")
    project_show.add_argument("--json", action="store_true")

    project_cancel = project_commands.add_parser(
        "cancel", help="Permanently cancel one non-terminal project run."
    )
    project_cancel.add_argument("run_id")
    project_cancel.add_argument("--workspace", default=".")
    project_cancel.add_argument("--json", action="store_true")

    plan = subcommands.add_parser(
        "plan", help="Create and run durable approval-gated local plans."
    )
    plan_commands = plan.add_subparsers(dest="plan_command", required=True)

    plan_propose = plan_commands.add_parser(
        "propose",
        help="Ask one model for a strict draft plan without executing tools.",
    )
    plan_propose.add_argument("path", nargs="?", default=".")
    plan_propose.add_argument("--provider", required=True)
    plan_propose.add_argument(
        "--request-stdin",
        action="store_true",
        help="Read one versioned JSON request from stdin so task content stays out of arguments.",
    )
    plan_propose.add_argument("--allow-network", action="store_true")
    plan_propose.add_argument("--timeout", type=float, default=60.0)
    plan_propose.add_argument("--max-output-tokens", type=int, default=2_048)
    plan_propose.add_argument(
        "--memory",
        choices=("auto", "off", "required"),
        default="auto",
    )
    plan_propose.add_argument("--context-max-characters", type=int, default=12_000)
    plan_propose.add_argument("--json", action="store_true")

    plan_create = plan_commands.add_parser(
        "create", help="Create a draft plan from one bounded JSON specification."
    )
    plan_create.add_argument("path", nargs="?", default=".")
    plan_create.add_argument("--spec-stdin", action="store_true")
    plan_create.add_argument("--json", action="store_true")

    plan_show = plan_commands.add_parser(
        "show", help="Show one plan and proof receipt."
    )
    plan_show.add_argument("plan_id")
    plan_show.add_argument("--workspace", default=".")
    plan_show.add_argument("--json", action="store_true")

    plan_review = plan_commands.add_parser(
        "review", help="Mark one immutable draft specification as reviewed."
    )
    plan_review.add_argument("plan_id")
    plan_review.add_argument("--workspace", default=".")
    plan_review.add_argument("--json", action="store_true")

    plan_approve = plan_commands.add_parser(
        "approve", help="Issue exact single-use approval references for plan steps."
    )
    plan_approve.add_argument("plan_id")
    plan_approve.add_argument("--workspace", default=".")
    approval_selection = plan_approve.add_mutually_exclusive_group(required=True)
    approval_selection.add_argument("--step", action="append", default=[])
    approval_selection.add_argument("--all", action="store_true")
    plan_approve.add_argument("--json", action="store_true")

    for command_name, command_help in (
        ("run", "Run approved ordered steps until completion or the next approval."),
        ("resume", "Resume verification or continue with newly approved steps."),
    ):
        plan_run = plan_commands.add_parser(command_name, help=command_help)
        plan_run.add_argument("plan_id")
        plan_run.add_argument("--workspace", default=".")
        plan_run.add_argument(
            "--allow-executable",
            action="append",
            default=[],
            help="Replace the default process allowlist with this executable name.",
        )
        plan_run.add_argument(
            "--allow-private-browser",
            action="store_true",
            help="Permit approved browser steps to access private or loopback hosts.",
        )
        plan_run.add_argument(
            "--browser-engine",
            choices=SUPPORTED_BROWSER_ENGINES,
            default="playwright",
        )
        plan_run.add_argument("--json", action="store_true")

    plan_cancel = plan_commands.add_parser("cancel", help="Cancel a non-terminal plan.")
    plan_cancel.add_argument("plan_id")
    plan_cancel.add_argument("--workspace", default=".")
    plan_cancel.add_argument("--reason", default="person cancelled")
    plan_cancel.add_argument("--json", action="store_true")

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

    tool_credential_set = tool_commands.add_parser(
        "credential-set",
        help="Store one declared external-tool credential in the OS keyring.",
    )
    tool_credential_set.add_argument("preset_id")
    tool_credential_set.add_argument("credential_name")
    tool_credential_set.add_argument("--workspace", required=True)
    tool_credential_set.add_argument(
        "--secret-stdin",
        action="store_true",
        help="Read the credential from stdin instead of a hidden terminal prompt.",
    )
    tool_credential_set.add_argument("--json", action="store_true")

    tool_credential_remove = tool_commands.add_parser(
        "credential-remove",
        help="Remove one declared external-tool credential from the OS keyring.",
    )
    tool_credential_remove.add_argument("preset_id")
    tool_credential_remove.add_argument("credential_name")
    tool_credential_remove.add_argument("--workspace", required=True)
    tool_credential_remove.add_argument("--json", action="store_true")
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
        if args.command == "endpoint":
            return _run_endpoint(args)
        if args.command == "provider":
            return _run_provider(args)
        if args.command == "agent":
            return _run_agent(args)
        if args.command == "project":
            return _run_project(args)
        if args.command == "plan":
            return _run_plan(args)
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
    measured_calls = statistics["measuredProviderCalls"]
    measurement = "provider-reported-only" if measured_calls else "unavailable"
    if not measured_calls:
        statistics = {
            **statistics,
            "cachedInputTokens": None,
            "inputTokens": None,
            "outputTokens": None,
        }
    _emit(
        {
            "ok": True,
            "source": "local-runtime-sqlite",
            "measurement": measurement,
            "generatedAt": utc_now(),
            "matchedComparison": _load_matched_comparison(workspace),
            **statistics,
        },
        as_json=args.json,
    )
    return 0


def _run_endpoint(args: argparse.Namespace) -> int:
    if args.protocol != ENDPOINT_PROTOCOL:
        raise ProviderError("The requested Fikeya endpoint protocol is unsupported.")
    if args.endpoint_command == "version":
        _emit(
            {
                "name": "fikeya",
                "schema": ENDPOINT_VERSION_SCHEMA,
                "version": __version__,
            },
            as_json=True,
        )
        return 0
    if args.endpoint_command == "execute":
        request = read_endpoint_request(sys.stdin.buffer)
        result = asyncio.run(
            execute_endpoint_request(request, ProviderStore(runtime_home(args.home)))
        )
        _emit(result.as_json(), as_json=True)
        return 0
    raise AssertionError("argparse accepted an unknown endpoint command")


def _load_matched_comparison(workspace: Workspace) -> dict[str, object] | None:
    """Load a bounded, fail-closed aggregate emitted by the offline comparator."""

    report_path = workspace.metadata_directory / "matched-efficiency.json"
    if not report_path.is_file():
        return None
    payload = report_path.read_bytes()
    if not payload or len(payload) > 1_048_576:
        return None
    try:
        report = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(report, dict) or set(report) != {
        "baseline",
        "delta",
        "fikeya",
        "matchedFields",
        "pairCount",
        "reportVersion",
        "status",
    }:
        return None
    pair_count = report.get("pairCount")
    matched_fields = report.get("matchedFields")
    if (
        report.get("reportVersion") != "1.0.0"
        or report.get("status") != "matched"
        or not isinstance(pair_count, int)
        or isinstance(pair_count, bool)
        or pair_count < 1
        or pair_count > 100_000
        or not isinstance(matched_fields, list)
        or not matched_fields
        or len(matched_fields) > 128
        or any(not isinstance(field, str) or not field or len(field) > 256 for field in matched_fields)
    ):
        return None
    baseline = _matched_arm(report.get("baseline"))
    fikeya = _matched_arm(report.get("fikeya"))
    if baseline is None or fikeya is None:
        return None
    baseline_tokens = baseline["billedTokens"]
    fikeya_tokens = fikeya["billedTokens"]
    reduction = ((baseline_tokens - fikeya_tokens) / baseline_tokens) * 100
    return {
        "baselineBilledTokens": baseline_tokens,
        "baselineVerifiedSolveRate": baseline["verifiedSolveRate"],
        "billedTokenReductionPercent": round(reduction, 4),
        "fikeyaBilledTokens": fikeya_tokens,
        "fikeyaVerifiedSolveRate": fikeya["verifiedSolveRate"],
        "pairCount": pair_count,
        "reportSha256": f"sha256:{hashlib.sha256(payload).hexdigest()}",
        "status": "matched",
    }


def _matched_arm(value: object) -> dict[str, int | float] | None:
    if not isinstance(value, dict):
        return None
    billed = value.get("billedTokens")
    solve_rate = value.get("verifiedSolveRate")
    if not isinstance(billed, dict) or not _finite_number(solve_rate, minimum=0, maximum=1):
        return None
    total = billed.get("totalBilled")
    if not _finite_number(total, minimum=1, maximum=10**15):
        return None
    return {"billedTokens": int(total), "verifiedSolveRate": float(solve_rate)}


def _finite_number(value: object, *, minimum: float, maximum: float) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and minimum <= value <= maximum
    )


def _run_provider(args: argparse.Namespace) -> int:
    store = ProviderStore(runtime_home(args.home))
    if args.provider_command == "list":
        if args.available:
            entries = [
                {
                    "defaultBaseUrl": definition.default_base_url,
                    "defaultCredentialType": definition.default_credential_type,
                    "kind": definition.kind.value,
                    "credentialRequired": definition.credential_required,
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
                    "profileSha256": sha256_text(stable_json(profile.as_json())),
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


def _run_project(args: argparse.Namespace) -> int:
    workspace_path = (
        args.path if args.project_command == "start" else args.workspace
    )
    workspace = Workspace.load(workspace_path)
    store = ProviderStore(runtime_home(args.home))
    loop = _build_project_loop(
        workspace,
        store,
        memory_mode=getattr(args, "memory", "auto"),
    )

    if args.project_command == "show":
        record = loop.load(args.run_id)
        _emit(
            _project_result(loop, record, message="Loaded durable project run."),
            as_json=args.json,
        )
        return 0
    if args.project_command == "cancel":
        record = loop.cancel(args.run_id)
        _emit(
            _project_result(loop, record, message="Cancelled durable project run."),
            as_json=args.json,
        )
        return 0
    if not args.protocol_stdin or not args.json_lines:
        raise ProviderError(
            "Project start and resume require --protocol-stdin and --json-lines so the goal stays out of process arguments and approvals remain exact."
        )

    message = _read_protocol_message(_PROJECT_PROTOCOL_BYTES)
    if args.project_command == "start":
        goal, completion_criteria = _project_start_message(message)
        record = loop.start(goal, completion_criteria=completion_criteria)
    elif args.project_command == "resume":
        goal = _project_resume_message(message, args.run_id)
        current = loop.load(args.run_id)
        if current.goal_sha256 != sha256_text(goal.strip()):
            raise ProviderError(
                "Resume goal does not match the original durable project run."
            )
        record = loop.resume(args.run_id)
    else:
        raise AssertionError("argparse accepted an unknown project command")

    _emit_protocol_message(
        {
            "type": "project_started",
            "runId": record.run_id,
            "stage": record.stage.value,
            "revision": record.revision,
        }
    )

    async def approve(request: dict[str, object]) -> ApprovalDecision:
        _emit_protocol_message(request)
        response = await asyncio.to_thread(_read_protocol_message, 65_536)
        if (
            set(response) != {"decision", "requestId", "type"}
            or response.get("type") != "approval"
        ):
            raise ProviderError(
                "Project approval responses must contain only type, requestId, and decision."
            )
        if response.get("requestId") != request.get("requestId"):
            raise ProviderError("Project approval does not match the active request.")
        try:
            return ApprovalDecision(response.get("decision"))
        except ValueError as error:
            raise ProviderError(
                "Approval decision must be allow_once, deny_once, or cancel."
            ) from error

    cancellation = CancellationToken()
    options = ProviderOptions(
        provider_name=args.provider,
        allow_network=args.allow_network,
        allow_private_browser=args.allow_private_browser,
        browser_engine=args.browser_engine,
        timeout=args.timeout,
        max_output_tokens=args.max_output_tokens,
        memory_mode=args.memory,
        context_max_characters=args.context_max_characters,
    )
    with _cancellation_signals(cancellation):
        record = asyncio.run(
            loop.advance(
                record.run_id,
                goal=goal,
                provider=options,
                cancellation=cancellation,
                approval_handler=approve,
            )
        )
    _emit_protocol_message(
        {
            "type": "project_result",
            **_project_result(loop, record, message="Project run reached a durable stop."),
        }
    )
    return 2 if record.stage.value == "failed" else 0


def _build_project_loop(
    workspace: Workspace,
    store: ProviderStore,
    *,
    memory_mode: str,
) -> AutonomousProjectLoop:
    agent = AgentRunner(workspace, store)
    if memory_mode != "off":
        agent.memory = select_qarinah_adapter(
            workspace_root=workspace.root,
            state=agent.state,
        )
    planner = PlanProposalRunner(agent)
    coding_runner = CodingAgentRunner(workspace, store)
    return AutonomousProjectLoop(workspace, planner, coding_runner)


def _project_start_message(
    message: dict[str, object],
) -> tuple[str, tuple[str, ...]]:
    if set(message) not in ({"goal", "type"}, {"completionCriteria", "goal", "type"}):
        raise ProviderError(
            "Project start must contain only type=start, goal, and optional completionCriteria."
        )
    if message.get("type") != "start":
        raise ProviderError("Project start protocol type must be start.")
    goal = _project_goal(message.get("goal"))
    raw_criteria = message.get("completionCriteria", [])
    if not isinstance(raw_criteria, list) or len(raw_criteria) > 64:
        raise ProviderError("completionCriteria must be an array of at most 64 strings.")
    criteria: list[str] = []
    for value in raw_criteria:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value.encode("utf-8")) > 4_096
        ):
            raise ProviderError(
                "Each completion criterion must be a non-empty string of at most 4096 UTF-8 bytes."
            )
        criteria.append(value.strip())
    return goal, tuple(criteria)


def _project_resume_message(message: dict[str, object], run_id: str) -> str:
    if set(message) != {"goal", "runId", "type"}:
        raise ProviderError(
            "Project resume must contain only type=resume, runId, and goal."
        )
    if message.get("type") != "resume" or message.get("runId") != run_id:
        raise ProviderError("Project resume protocol is bound to another run.")
    return _project_goal(message.get("goal"))


def _project_goal(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value.strip().encode("utf-8")) > _PROJECT_GOAL_BYTES
    ):
        raise ProviderError(
            f"Project goal must be 1-{_PROJECT_GOAL_BYTES} UTF-8 bytes."
        )
    return value.strip()


def _project_result(
    loop: AutonomousProjectLoop,
    record: AutonomyRecord,
    *,
    message: str,
) -> dict[str, object]:
    durable = record.as_json()
    next_action: dict[str, object] | None = None
    if record.stop_reason == "plan_review_required" and record.plan_id:
        next_action = {"action": "review_plan", "planId": record.plan_id}
    elif record.stop_reason == "plan_approval_required" and record.plan_id:
        next_action = {"action": "approve_plan_steps", "planId": record.plan_id}
    elif record.can_resume:
        next_action = {"action": "resume_project", "runId": record.run_id}
    return {
        "history": list(loop.store.history(record.run_id)),
        "message": message,
        "nextAction": next_action,
        "ok": record.stage.value != "failed",
        "planId": record.plan_id,
        "record": durable,
        "runId": record.run_id,
        "stage": record.stage.value,
    }


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
    if (
        set(start)
        not in (
            {"prompt", "type"},
            {"history", "prompt", "type"},
            {"images", "prompt", "type"},
            {"history", "images", "prompt", "type"},
        )
        or start.get("type") != "start"
    ):
        raise ProviderError(
            "The first protocol message must contain type=start, prompt, and optional history and images."
        )
    prompt = start.get("prompt")
    if (
        not isinstance(prompt, str)
        or not prompt
        or len(prompt.encode("utf-8")) > MAX_REQUEST_BYTES
    ):
        raise ProviderError(f"Agent prompt must be 1-{MAX_REQUEST_BYTES} UTF-8 bytes.")
    history = parse_conversation_history(start.get("history", []))
    images = parse_inference_images(start.get("images", []))

    try:
        from fikeya_agent_core import (
            AgentCoreError,
            AgentNoProgressError,
            ApprovalDecision,
        )
        from fikeya_agent_core import (
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
                    history=history,
                    images=images,
                    mode=args.mode,
                    allow_private_browser=args.allow_private_browser,
                    browser_engine=args.browser_engine,
                )
            )
    except ProviderConnectivityError as error:
        _emit_protocol_message(
            {
                "kind": error.kind,
                "message": str(error),
                "retryable": error.retryable,
                "type": "error",
            }
        )
        return 2
    except ProviderHttpError as error:
        _emit_protocol_message(
            {
                "kind": error.kind,
                "message": str(error),
                "retryable": error.retryable,
                "statusCode": error.status_code,
                "type": "error",
            }
        )
        return 2
    except AgentNoProgressError:
        _emit_protocol_message(
            {
                "kind": "agent_no_progress",
                "message": (
                    "Fikeya stopped before repeating an unchanged provider request."
                ),
                "retryable": False,
                "type": "error",
            }
        )
        return 2
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
        value = json.loads(
            line,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_non_finite_json,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
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


def _run_plan(args: argparse.Namespace) -> int:
    workspace_path = (
        args.path if args.plan_command in {"create", "propose"} else args.workspace
    )
    workspace = Workspace.load(workspace_path)
    service = PlanService(workspace)
    if args.plan_command == "propose":
        if not args.request_stdin:
            raise ProviderError(
                "Plan requests must use --request-stdin so content does not enter process arguments."
            )
        request = _read_bounded_json_object(_PLAN_REQUEST_BYTES)
        if set(request) not in (
            {"prompt", "protocol"},
            {"history", "prompt", "protocol"},
            {"images", "prompt", "protocol"},
            {"history", "images", "prompt", "protocol"},
        ):
            raise ProviderError(
                "Plan requests must contain protocol, prompt, and optional history and images."
            )
        if request.get("protocol") != PLAN_REQUEST_PROTOCOL:
            raise ProviderError(
                f"Plan request protocol must be {PLAN_REQUEST_PROTOCOL}."
            )
        prompt = request.get("prompt")
        if (
            not isinstance(prompt, str)
            or not prompt.strip()
            or len(prompt.encode("utf-8")) > MAX_REQUEST_BYTES
        ):
            raise ProviderError(
                f"Plan prompt must be 1-{MAX_REQUEST_BYTES} UTF-8 bytes."
            )
        history = parse_conversation_history(request.get("history", []))
        images = parse_inference_images(request.get("images", []))
        store = ProviderStore(runtime_home(args.home))
        agent = AgentRunner(workspace, store)
        if args.memory != "off":
            agent.memory = select_qarinah_adapter(
                workspace_root=workspace.root,
                state=agent.state,
            )
        cancellation = CancellationToken()
        try:
            with _cancellation_signals(cancellation):
                proposed = PlanProposalRunner(agent).propose(
                    provider_name=args.provider,
                    prompt=prompt,
                    allow_network=args.allow_network,
                    timeout=args.timeout,
                    max_output_tokens=args.max_output_tokens,
                    cancellation=cancellation,
                    memory_mode=args.memory,
                    context_max_characters=args.context_max_characters,
                    history=history,
                    images=images,
                )
        except CancellationError:
            _emit(
                {"cancelled": True, "error": "Operation cancelled.", "ok": False},
                as_json=args.json,
            )
            return 130
        usage = proposed.agent.provider_call.usage
        _emit(
            {
                "message": f"Created draft plan {proposed.plan.plan_id}.",
                "ok": True,
                "proposal": {
                    "callId": proposed.agent.call_id,
                    "memory": {
                        "coverage": proposed.agent.memory.coverage,
                        "evidenceCount": proposed.agent.memory.evidence_count,
                        "receiptId": proposed.agent.memory.receipt_id,
                        "responseSha256": proposed.agent.memory.response_sha256,
                        "status": proposed.agent.memory.status,
                    },
                    "protocol": PLAN_PROPOSAL_PROTOCOL,
                    "sessionId": proposed.agent.session_id,
                    "usage": {
                        "cachedInputTokens": usage.cached_input_tokens,
                        "inputTokens": usage.input_tokens,
                        "measurement": usage.measurement,
                        "outputTokens": usage.output_tokens,
                    },
                },
                **service.view(proposed.plan),
            },
            as_json=args.json,
        )
        return 0
    if args.plan_command == "create":
        if not args.spec_stdin:
            raise ProviderError(
                "Plan specifications must use --spec-stdin so content stays out of process arguments."
            )
        specification = _read_bounded_json_object(_PLAN_SPECIFICATION_BYTES)
        plan = service.create(specification)
        _emit(
            {
                "message": f"Created draft plan {plan.plan_id}.",
                "ok": True,
                **service.view(plan),
            },
            as_json=args.json,
        )
        return 0
    if args.plan_command == "show":
        _emit({"ok": True, **service.show(args.plan_id)}, as_json=args.json)
        return 0
    if args.plan_command == "review":
        plan = service.review(args.plan_id)
        _emit(
            {
                "message": f"Reviewed plan {plan.plan_id}.",
                "ok": True,
                **service.view(plan),
            },
            as_json=args.json,
        )
        return 0
    if args.plan_command == "approve":
        plan, references = service.approve(
            args.plan_id,
            step_ids=tuple(args.step),
            approve_all=args.all,
        )
        _emit(
            {
                "approvalReferences": [item.as_json() for item in references],
                "message": f"Approved {len(references)} exact plan step(s).",
                "ok": True,
                **service.view(plan),
            },
            as_json=args.json,
        )
        return 0
    if args.plan_command in {"run", "resume"}:
        allowed = frozenset(args.allow_executable) if args.allow_executable else None
        cancellation = CancellationToken()
        with _cancellation_signals(cancellation):
            plan = asyncio.run(
                service.run(
                    args.plan_id,
                    allowed_executables=allowed,
                    allow_private_browser=args.allow_private_browser,
                    browser_engine=args.browser_engine,
                    resume=args.plan_command == "resume",
                    cancellation=cancellation,
                )
            )
        _emit(
            {
                "message": f"Plan {plan.plan_id} is {plan.status.value}.",
                "ok": plan.status not in {PlanStatus.FAILED, PlanStatus.CANCELLED},
                **service.view(plan),
            },
            as_json=args.json,
        )
        return 2 if plan.status is PlanStatus.FAILED else 0
    if args.plan_command == "cancel":
        plan = service.cancel(args.plan_id, args.reason)
        _emit(
            {
                "message": f"Cancelled plan {plan.plan_id}.",
                "ok": True,
                **service.view(plan),
            },
            as_json=args.json,
        )
        return 0
    raise AssertionError("argparse accepted an unknown plan command")


_PLAN_SPECIFICATION_BYTES = 1_048_576
_PLAN_REQUEST_BYTES = (MAX_REQUEST_BYTES * 4) + 4_096
_PROJECT_GOAL_BYTES = 65_536
_PROJECT_PROTOCOL_BYTES = 524_288


def _read_bounded_json_object(maximum_bytes: int) -> dict[str, object]:
    payload = sys.stdin.buffer.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise ProviderError(f"JSON input exceeds {maximum_bytes} bytes.")
    try:
        value = json.loads(
            payload,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_non_finite_json,
        )
    except (
        RecursionError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as error:
        raise ProviderError("Input must be one UTF-8 JSON object.") from error
    if not isinstance(value, dict):
        raise ProviderError("Input must be one JSON object.")
    return value


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object key.")
        result[key] = value
    return result


def _reject_non_finite_json(value: str) -> object:
    raise ValueError("Non-finite JSON number.")


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
    if args.tool_command == "credential-set":
        preset = catalog.get(args.preset_id)
        _require_declared_tool_credential(preset, args.credential_name)
        credential = _read_tool_credential(args)
        McpCredentialStore().set(
            workspace,
            preset.preset_id,
            args.credential_name,
            credential,
        )
        _emit(
            {
                "configured": True,
                "credentialName": args.credential_name,
                "message": "External-tool credential stored in the OS keyring.",
                "ok": True,
                "presetId": preset.preset_id,
                "workspaceId": workspace.config.workspace_id,
            },
            as_json=args.json,
        )
        return 0
    if args.tool_command == "credential-remove":
        preset = catalog.get(args.preset_id)
        _require_declared_tool_credential(preset, args.credential_name)
        McpCredentialStore().remove(
            workspace,
            preset.preset_id,
            args.credential_name,
        )
        _emit(
            {
                "configured": False,
                "credentialName": args.credential_name,
                "message": "External-tool credential removed from the OS keyring.",
                "ok": True,
                "presetId": preset.preset_id,
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
    workspace = enablements.workspace if enablements is not None else None
    configuration = [
        {
            "configured": bool(os.environ.get(str(item["name"]))),
            "name": str(item["name"]),
            "required": bool(item["required"]),
        }
        for item in preset.configuration
    ]
    credential_store = McpCredentialStore()
    credentials = [
        {
            "configured": (
                credential_store.configured(
                    workspace, preset.preset_id, str(item["name"])
                )
                if workspace is not None
                else None
            ),
            "name": str(item["name"]),
            "required": bool(item["required"]),
        }
        for item in preset.secret_references
    ]
    value = preset.public_json()
    value.update(
        {
            "brokerNamespace": f"mcp.{preset.preset_id}",
            "brokerTools": list(preset_broker_tools(preset)),
            "configuration": configuration,
            "credentials": credentials,
            "enabled": status.enabled if status is not None else False,
            "enabledAt": status.enabled_at if status is not None else None,
            "executableFound": diagnostic.executable_found,
            "provenanceWarning": diagnostic.warning,
            "executionTrust": "trusted-local-executable",
            "osSandboxed": False,
            "sandboxWarning": (
                "Exact approval limits when Fikeya may call this executable; it does "
                "not restrict the executable's desktop-user filesystem or network "
                "permissions. Install only reviewed local binaries or add OS sandboxing."
            ),
            "processTreeContained": True,
            "requiresExactApproval": True,
            "requiresConfirmation": (
                status.requires_confirmation if status is not None else False
            ),
            "runtimeState": _tool_runtime_state(
                status,
                diagnostic.executable_found,
                configuration,
                credentials,
            ),
            "transport": "stdio",
        }
    )
    return value


def _tool_runtime_state(
    status: ToolStatus | None,
    executable_found: bool,
    configuration: list[dict[str, object]],
    credentials: list[dict[str, object]],
) -> str:
    if status is None:
        return "workspace-required"
    if status.requires_confirmation:
        return "preset-reconfirmation-required"
    if not status.enabled:
        return "disabled"
    if not executable_found:
        return "executable-missing"
    if any(item["required"] and not item["configured"] for item in configuration):
        return "configuration-missing"
    if any(item["required"] and not item["configured"] for item in credentials):
        return "credential-missing"
    return "preflight-ready"


def _require_declared_tool_credential(preset: ToolPreset, name: str) -> None:
    declared = {str(item["name"]) for item in preset.secret_references}
    if name not in declared:
        raise ToolPresetError(
            f"Preset {preset.preset_id} does not declare credential {name}."
        )


def _read_tool_credential(args: argparse.Namespace) -> str:
    if args.secret_stdin:
        value = sys.stdin.read(16_385)
        if len(value) > 16_384:
            raise ToolPresetError("External-tool credential exceeds 16384 characters.")
        return value.rstrip("\r\n")
    if not sys.stdin.isatty():
        raise ToolPresetError(
            "An external-tool credential requires a hidden terminal prompt or "
            "--secret-stdin."
        )
    return getpass.getpass("External-tool credential: ")


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
