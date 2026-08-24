# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Reviewed, workspace-scoped external tool presets and bounded launch plans."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .errors import ToolPresetError
from .state import StateStore
from .util import sha256_text, stable_json, utc_now
from .workspace import Workspace

_TOP_LEVEL_KEYS = {
    "$schema",
    "schemaVersion",
    "id",
    "displayName",
    "summary",
    "enabledByDefault",
    "enablement",
    "transport",
    "dependency",
    "capabilities",
    "environment",
    "limits",
    "upstreamPolicyRequirements",
}
_LIMIT_BOUNDS = {
    "startupTimeoutMs": (100, 30_000),
    "requestTimeoutMs": (100, 120_000),
    "shutdownTimeoutMs": (100, 30_000),
    "maxConcurrentRequests": (1, 4),
    "maxRequestsPerSession": (1, 500),
    "maxSessionDurationMs": (1_000, 3_600_000),
    "maxRequestBytes": (1_024, 8 * 1_024 * 1_024),
    "maxResponseBytes": (1_024, 8 * 1_024 * 1_024),
}
_EXECUTABLE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_ENVIRONMENT_NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,79}$")
_SECRET_VALUE = re.compile(
    r"(?:sk-(?:or-)?[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|"
    r"-----BEGIN [A-Z ]+PRIVATE KEY-----)"
)
_SHELL_NAMES = {
    "bash",
    "cmd",
    "cmd.exe",
    "command",
    "fish",
    "pwsh",
    "pwsh.exe",
    "powershell",
    "powershell.exe",
    "sh",
    "zsh",
}
_PROVENANCE_WARNING = (
    "Executable presence is checked by name only. Fikeya has not verified the "
    "installed package provenance or the declared version range."
)

_CONTRACTS: dict[str, dict[str, object]] = {
    "cockroach-browser": {
        "command": "cockroach-browser",
        "args": ["mcp"],
        "dependency": {
            "package": "cockroach-browser",
            "versionRange": ">=0.2.1 <0.3.0",
            "license": "AGPL-3.0-or-later",
            "source": "https://github.com/AjnasNB/cockroach-browser",
            "homepage": "https://cockroachbrowser.com",
        },
        "effect": "read-and-propose",
        "tools": [
            "browser_capabilities",
            "browser_health",
            "browser_sessions",
            "browser_snapshot",
            "browser_capture",
            "browser_network",
            "browser_audit",
            "browser_propose_action",
        ],
        "fixed": {},
        "configuration": [
            {
                "name": "COCKROACH_BROWSER_URL",
                "required": False,
                "format": "http-or-https-url-without-credentials",
            }
        ],
        "secrets": [
            {
                "name": "COCKROACH_BROWSER_TOKEN",
                "required": True,
                "source": "os-credential-store",
            }
        ],
    },
    "cockroach-crawler": {
        "command": "cockroach-mcp",
        "args": [],
        "dependency": {
            "package": "cockroach-crawler",
            "versionRange": ">=0.7.0 <0.8.0",
            "license": "MIT",
            "source": "https://github.com/AjnasNB/cockroach-crawler",
            "homepage": "https://cockroachcrawler.com",
        },
        "effect": "read-only",
        "tools": [
            "crawl",
            "map_site",
            "select",
            "find_similar",
            "relocate_element",
            "crawl_spider",
            "export_records",
            "extract_structured",
        ],
        "fixed": {
            "COCKROACH_MAX_PAGES": "10",
            "COCKROACH_MAX_DEPTH": "1",
            "COCKROACH_MAX_REQUESTS": "50",
            "COCKROACH_MAX_DURATION_MS": "60000",
        },
        "configuration": [
            {
                "name": "COCKROACH_ALLOWED_ORIGINS",
                "required": True,
                "format": "comma-separated-http-origins-without-credentials-or-paths",
            }
        ],
        "secrets": [],
    },
}


@dataclass(frozen=True, slots=True)
class ToolLimits:
    """Finite process and protocol limits taken from a reviewed manifest."""

    startup_timeout_ms: int
    request_timeout_ms: int
    shutdown_timeout_ms: int
    max_concurrent_requests: int
    max_requests_per_session: int
    max_session_duration_ms: int
    max_request_bytes: int
    max_response_bytes: int

    def as_json(self) -> dict[str, int]:
        return {
            "maxConcurrentRequests": self.max_concurrent_requests,
            "maxRequestBytes": self.max_request_bytes,
            "maxRequestsPerSession": self.max_requests_per_session,
            "maxResponseBytes": self.max_response_bytes,
            "maxSessionDurationMs": self.max_session_duration_ms,
            "requestTimeoutMs": self.request_timeout_ms,
            "shutdownTimeoutMs": self.shutdown_timeout_ms,
            "startupTimeoutMs": self.startup_timeout_ms,
        }


@dataclass(frozen=True, slots=True)
class ToolPreset:
    """A fully validated external-tool contract."""

    preset_id: str
    display_name: str
    summary: str
    command: str
    args: tuple[str, ...]
    effect: str
    allowed_tools: tuple[str, ...]
    fixed_environment: Mapping[str, str]
    configuration: tuple[Mapping[str, object], ...]
    secret_references: tuple[Mapping[str, object], ...]
    dependency: Mapping[str, str]
    limits: ToolLimits
    digest: str

    def public_json(self) -> dict[str, object]:
        return {
            "allowedTools": list(self.allowed_tools),
            "command": self.command,
            "dependency": dict(self.dependency),
            "displayName": self.display_name,
            "effect": self.effect,
            "id": self.preset_id,
            "limits": self.limits.as_json(),
            "summary": self.summary,
        }


@dataclass(frozen=True, slots=True)
class ToolDiagnostic:
    """Content-free executable discovery that makes no version claim."""

    executable_found: bool
    warning: str = _PROVENANCE_WARNING


@dataclass(frozen=True, slots=True)
class ToolStatus:
    """Workspace enablement status tied to the exact manifest digest."""

    enabled: bool
    enabled_at: str | None
    requires_confirmation: bool


@dataclass(frozen=True, slots=True)
class ToolLaunchPlan:
    """A secret-redacting, shell-free process plan."""

    preset_id: str
    argv: tuple[str, ...]
    cwd: Path
    limits: ToolLimits
    environment: Mapping[str, str] = field(repr=False, compare=False)


class PresetCatalog:
    """Load only strict, reviewed presets from package data or a test directory."""

    def __init__(self, directory: str | Path | None = None) -> None:
        documents: list[tuple[str, dict[str, object]]] = []
        if directory is None:
            root = resources.files("fikeya_runtime").joinpath("presets")
            entries = sorted(
                (
                    entry
                    for entry in root.iterdir()
                    if entry.name.endswith(".preset.json")
                ),
                key=lambda entry: entry.name,
            )
            for entry in entries:
                documents.append(
                    (entry.name, _read_document(entry.read_text("utf-8"), entry.name))
                )
        else:
            root_path = _safe_catalog_directory(directory)
            for candidate in sorted(root_path.glob("*.preset.json")):
                resolved = candidate.resolve(strict=True)
                try:
                    resolved.relative_to(root_path)
                except ValueError as error:
                    raise ToolPresetError(
                        f"Preset path escapes its catalog: {candidate.name}"
                    ) from error
                if candidate.is_symlink():
                    raise ToolPresetError(
                        "Preset catalogs may not contain symbolic links."
                    )
                documents.append(
                    (
                        candidate.name,
                        _read_document(candidate.read_text("utf-8"), candidate.name),
                    )
                )
        if not documents:
            raise ToolPresetError("No external tool presets were found.")
        presets = tuple(
            _validate_preset(document, label) for label, document in documents
        )
        identifiers = [preset.preset_id for preset in presets]
        if len(set(identifiers)) != len(identifiers):
            raise ToolPresetError("External tool preset identifiers must be unique.")
        self._presets = presets

    def list(self) -> tuple[ToolPreset, ...]:
        return self._presets

    def get(self, preset_id: str) -> ToolPreset:
        for preset in self._presets:
            if preset.preset_id == preset_id:
                return preset
        raise ToolPresetError(f"Unknown external tool preset: {preset_id}")


class ToolEnablementStore:
    """Persist only preset identity, digest, and enablement time in local SQLite."""

    def __init__(self, workspace: Workspace) -> None:
        _require_safe_workspace(workspace)
        self.workspace = workspace
        self.state = StateStore(workspace.state_path)
        self.state.initialize()

    def enable(self, preset: ToolPreset, *, confirmed: bool) -> ToolStatus:
        if not confirmed:
            raise ToolPresetError(
                "Tool enablement requires --confirm-workspace for the selected workspace."
            )
        enabled_at = utc_now()
        with self.state._connect() as connection:
            connection.execute(
                """
                INSERT INTO tool_enablements (preset_id, preset_sha256, enabled_at)
                VALUES (?, ?, ?)
                ON CONFLICT(preset_id) DO UPDATE SET
                    preset_sha256 = excluded.preset_sha256,
                    enabled_at = excluded.enabled_at
                """,
                (preset.preset_id, preset.digest, enabled_at),
            )
        return ToolStatus(True, enabled_at, False)

    def disable(self, preset_id: str) -> bool:
        with self.state._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM tool_enablements WHERE preset_id = ?", (preset_id,)
            )
        return cursor.rowcount > 0

    def status(self, preset: ToolPreset) -> ToolStatus:
        with self.state._connect() as connection:
            row = connection.execute(
                """
                SELECT preset_sha256, enabled_at
                FROM tool_enablements WHERE preset_id = ?
                """,
                (preset.preset_id,),
            ).fetchone()
        if row is None:
            return ToolStatus(False, None, False)
        if row["preset_sha256"] != preset.digest:
            return ToolStatus(False, str(row["enabled_at"]), True)
        return ToolStatus(True, str(row["enabled_at"]), False)


class ToolBudget:
    """Enforce request, concurrency, response, and session ceilings at runtime."""

    def __init__(
        self,
        limits: ToolLimits,
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        _validate_limits(limits)
        self.limits = limits
        self._monotonic = monotonic
        self._started_at = monotonic()
        self._requests = 0
        self._active = 0
        self._lock = threading.Lock()

    @contextmanager
    def request(self, payload: bytes) -> Iterator[None]:
        if not isinstance(payload, bytes):
            raise ToolPresetError("Tool request payload must be bytes.")
        if len(payload) > self.limits.max_request_bytes:
            raise ToolPresetError("Tool request exceeds the preset request-byte limit.")
        self._assert_session_live()
        with self._lock:
            if self._requests >= self.limits.max_requests_per_session:
                raise ToolPresetError("Tool session request limit has been reached.")
            if self._active >= self.limits.max_concurrent_requests:
                raise ToolPresetError("Tool concurrent-request limit has been reached.")
            self._requests += 1
            self._active += 1
        request_started = self._monotonic()
        try:
            yield
            elapsed_ms = (self._monotonic() - request_started) * 1_000
            if elapsed_ms > self.limits.request_timeout_ms:
                raise ToolPresetError("Tool request timeout has expired.")
        finally:
            with self._lock:
                self._active -= 1

    def validate_response(self, payload: bytes) -> None:
        if not isinstance(payload, bytes):
            raise ToolPresetError("Tool response payload must be bytes.")
        self._assert_session_live()
        if len(payload) > self.limits.max_response_bytes:
            raise ToolPresetError(
                "Tool response exceeds the preset response-byte limit."
            )

    def _assert_session_live(self) -> None:
        elapsed_ms = (self._monotonic() - self._started_at) * 1_000
        if elapsed_ms > self.limits.max_session_duration_ms:
            raise ToolPresetError("Tool session duration limit has expired.")


class ToolPresetLoader:
    """Resolve and launch an explicitly enabled preset without a shell."""

    def __init__(self, catalog: PresetCatalog | None = None) -> None:
        self.catalog = catalog or PresetCatalog()

    def diagnostic(
        self,
        preset: ToolPreset,
        *,
        executable_resolver: Callable[[str], str | None] = shutil.which,
    ) -> ToolDiagnostic:
        return ToolDiagnostic(
            executable_found=executable_resolver(preset.command) is not None
        )

    def prepare_launch(
        self,
        workspace: Workspace,
        preset_id: str,
        *,
        configuration: Mapping[str, str] | None = None,
        secret_resolver: Callable[[str], str | None] | None = None,
        executable_resolver: Callable[[str], str | None] = shutil.which,
    ) -> ToolLaunchPlan:
        _require_safe_workspace(workspace)
        preset = self.catalog.get(preset_id)
        status = ToolEnablementStore(workspace).status(preset)
        if not status.enabled:
            suffix = (
                " Reconfirm the changed manifest."
                if status.requires_confirmation
                else ""
            )
            raise ToolPresetError(
                f"Tool preset is disabled for this workspace.{suffix}"
            )
        supplied = dict(configuration or {})
        _validate_configuration(preset, supplied)
        environment = _minimal_process_environment()
        environment.update(preset.fixed_environment)
        environment.update(supplied)
        for reference in preset.secret_references:
            name = str(reference["name"])
            secret = secret_resolver(name) if secret_resolver is not None else None
            if not secret:
                if reference["required"]:
                    raise ToolPresetError(
                        f"Required credential reference is unavailable: {name}"
                    )
                continue
            _validate_ephemeral_secret(secret)
            environment[name] = secret
        executable = executable_resolver(preset.command)
        if executable is None:
            raise ToolPresetError(
                f"Executable is not installed or not discoverable: {preset.command}"
            )
        executable_path = _validate_resolved_executable(executable)
        _validate_limits(preset.limits)
        return ToolLaunchPlan(
            preset_id=preset.preset_id,
            argv=(str(executable_path), *preset.args),
            cwd=workspace.root,
            environment=environment,
            limits=preset.limits,
        )

    def spawn(
        self,
        plan: ToolLaunchPlan,
        *,
        process_factory: Callable[..., Any] = subprocess.Popen,
    ) -> tuple[Any, ToolBudget]:
        """Spawn a prepared stdio process; callers must frame MCP within ToolBudget."""

        _validate_limits(plan.limits)
        workspace = Workspace.load(plan.cwd)
        _require_safe_workspace(workspace)
        if workspace.root != plan.cwd:
            raise ToolPresetError("Launch workspace changed after plan validation.")
        if not plan.argv or any("\x00" in argument for argument in plan.argv):
            raise ToolPresetError("Launch arguments contain invalid bytes.")
        executable = _validate_resolved_executable(plan.argv[0])
        if str(executable) != plan.argv[0]:
            raise ToolPresetError("Launch executable changed after plan validation.")
        process = process_factory(
            list(plan.argv),
            cwd=str(plan.cwd),
            env=dict(plan.environment),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            text=False,
        )
        return process, ToolBudget(plan.limits)


def _read_document(text: str, label: str) -> dict[str, object]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ToolPresetError(f"{label} is not valid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise ToolPresetError(f"{label} must contain a JSON object.")
    return value


def _validate_preset(value: dict[str, object], label: str) -> ToolPreset:
    _exact_keys(value, _TOP_LEVEL_KEYS, label)
    preset_id = value.get("id")
    if not isinstance(preset_id, str) or preset_id not in _CONTRACTS:
        raise ToolPresetError(f"{label} is not a reviewed external tool preset.")
    contract = _CONTRACTS[preset_id]
    if value["$schema"] != "./preset.schema.json":
        raise ToolPresetError(f"{label} has an unsupported schema reference.")
    if value["schemaVersion"] != "fikeya.tool-preset.v1":
        raise ToolPresetError(f"{label} has an unsupported schema version.")
    if value["enabledByDefault"] is not False:
        raise ToolPresetError(f"{label} must be disabled by default.")
    _require_exact(
        value["enablement"],
        {"mode": "explicit-user", "scope": "workspace", "confirmation": "required"},
        f"{label}.enablement",
    )
    transport = _object(value["transport"], f"{label}.transport")
    _exact_keys(transport, {"type", "command", "args", "shell"}, f"{label}.transport")
    _require_exact(transport["type"], "stdio", f"{label}.transport.type")
    _require_exact(transport["shell"], False, f"{label}.transport.shell")
    _require_exact(
        transport["command"], contract["command"], f"{label}.transport.command"
    )
    _require_exact(transport["args"], contract["args"], f"{label}.transport.args")
    command = str(transport["command"])
    if not _EXECUTABLE_NAME.fullmatch(command) or command.casefold() in _SHELL_NAMES:
        raise ToolPresetError(f"{label} contains an unsafe executable name.")
    args = transport["args"]
    if not isinstance(args, list) or any(
        not isinstance(argument, str)
        or "\x00" in argument
        or "\n" in argument
        or "\r" in argument
        for argument in args
    ):
        raise ToolPresetError(f"{label} transport arguments are invalid.")

    dependency = _object(value["dependency"], f"{label}.dependency")
    _require_exact(dependency, contract["dependency"], f"{label}.dependency")
    capabilities = _object(value["capabilities"], f"{label}.capabilities")
    _exact_keys(
        capabilities,
        {"effect", "allowedTools", "deniedCapabilities"},
        f"{label}.capabilities",
    )
    _require_exact(
        capabilities["effect"], contract["effect"], f"{label}.capabilities.effect"
    )
    _require_exact(
        capabilities["allowedTools"],
        contract["tools"],
        f"{label}.capabilities.allowedTools",
    )
    denied = capabilities["deniedCapabilities"]
    if (
        not isinstance(denied, list)
        or not denied
        or any(not isinstance(item, str) for item in denied)
    ):
        raise ToolPresetError(f"{label} must declare denied capabilities.")

    environment = _object(value["environment"], f"{label}.environment")
    _exact_keys(
        environment,
        {"fixed", "configuration", "secretReferences"},
        f"{label}.environment",
    )
    _require_exact(
        environment["fixed"], contract["fixed"], f"{label}.environment.fixed"
    )
    _require_exact(
        environment["configuration"],
        contract["configuration"],
        f"{label}.environment.configuration",
    )
    _require_exact(
        environment["secretReferences"],
        contract["secrets"],
        f"{label}.environment.secretReferences",
    )
    for name, item in _object(environment["fixed"], "fixed environment").items():
        if not _ENVIRONMENT_NAME.fullmatch(name) or not isinstance(item, str):
            raise ToolPresetError(
                f"{label} contains an invalid fixed environment entry."
            )

    limits_value = _object(value["limits"], f"{label}.limits")
    _exact_keys(limits_value, set(_LIMIT_BOUNDS), f"{label}.limits")
    for name, (minimum, maximum) in _LIMIT_BOUNDS.items():
        item = limits_value[name]
        if (
            isinstance(item, bool)
            or not isinstance(item, int)
            or not minimum <= item <= maximum
        ):
            raise ToolPresetError(
                f"{label}.{name} must be an integer from {minimum} to {maximum}."
            )
    policies = value["upstreamPolicyRequirements"]
    if (
        not isinstance(policies, list)
        or not policies
        or any(not isinstance(policy, str) or not policy for policy in policies)
    ):
        raise ToolPresetError(f"{label} must declare upstream policy requirements.")
    display_name = value["displayName"]
    summary = value["summary"]
    if not isinstance(display_name, str) or not 1 <= len(display_name) <= 80:
        raise ToolPresetError(f"{label} has an invalid display name.")
    if not isinstance(summary, str) or not 1 <= len(summary) <= 240:
        raise ToolPresetError(f"{label} has an invalid summary.")
    _reject_secret_values(value, label)
    limits = ToolLimits(
        startup_timeout_ms=int(limits_value["startupTimeoutMs"]),
        request_timeout_ms=int(limits_value["requestTimeoutMs"]),
        shutdown_timeout_ms=int(limits_value["shutdownTimeoutMs"]),
        max_concurrent_requests=int(limits_value["maxConcurrentRequests"]),
        max_requests_per_session=int(limits_value["maxRequestsPerSession"]),
        max_session_duration_ms=int(limits_value["maxSessionDurationMs"]),
        max_request_bytes=int(limits_value["maxRequestBytes"]),
        max_response_bytes=int(limits_value["maxResponseBytes"]),
    )
    _validate_limits(limits)
    return ToolPreset(
        preset_id=preset_id,
        display_name=display_name,
        summary=summary,
        command=command,
        args=tuple(str(argument) for argument in args),
        effect=str(capabilities["effect"]),
        allowed_tools=tuple(str(tool) for tool in capabilities["allowedTools"]),
        fixed_environment=dict(_object(environment["fixed"], "fixed environment")),
        configuration=tuple(
            dict(entry)
            for entry in _array_of_objects(
                environment["configuration"], "configuration"
            )
        ),
        secret_references=tuple(
            dict(entry)
            for entry in _array_of_objects(
                environment["secretReferences"], "secret references"
            )
        ),
        dependency={key: str(item) for key, item in dependency.items()},
        limits=limits,
        digest=sha256_text(stable_json(value)),
    )


def _safe_catalog_directory(directory: str | Path) -> Path:
    root = Path(directory).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ToolPresetError("Preset catalog path is not a directory.")
    _require_safe_root(root)
    return root


def _require_safe_workspace(workspace: Workspace) -> None:
    root = workspace.root.resolve(strict=True)
    _require_safe_root(root)
    expected_metadata = (root / ".fikeya").resolve(strict=True)
    try:
        expected_metadata.relative_to(root)
    except ValueError as error:
        raise ToolPresetError(
            "Workspace metadata escapes the workspace root."
        ) from error


def _require_safe_root(root: str | Path) -> None:
    resolved = Path(root).expanduser().resolve(strict=True)
    if resolved == Path(resolved.anchor):
        raise ToolPresetError("A filesystem root cannot be used as a tool workspace.")


def _validate_configuration(preset: ToolPreset, values: Mapping[str, str]) -> None:
    expected = {str(entry["name"]): entry for entry in preset.configuration}
    unknown = set(values) - set(expected)
    if unknown:
        raise ToolPresetError(
            f"Unknown tool configuration fields: {', '.join(sorted(unknown))}."
        )
    for name, entry in expected.items():
        value = values.get(name)
        if entry["required"] and not value:
            raise ToolPresetError(f"Required tool configuration is missing: {name}")
        if value is None:
            continue
        if (
            not isinstance(value, str)
            or "\x00" in value
            or "\r" in value
            or "\n" in value
        ):
            raise ToolPresetError(f"Tool configuration is invalid: {name}")
        if len(value.encode("utf-8")) > 16_384:
            raise ToolPresetError(f"Tool configuration is too large: {name}")
        if entry["format"] == "http-or-https-url-without-credentials":
            _validate_http_url(value, origin_only=False)
        elif (
            entry["format"]
            == "comma-separated-http-origins-without-credentials-or-paths"
        ):
            origins = value.split(",")
            if not origins or any(not origin.strip() for origin in origins):
                raise ToolPresetError(
                    "Crawler origins must be a non-empty comma-separated list."
                )
            for origin in origins:
                _validate_http_url(origin.strip(), origin_only=True)


def _validate_http_url(value: str, *, origin_only: bool) -> None:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ToolPresetError("Tool URLs must use HTTP or HTTPS and include a host.")
    if parsed.username or parsed.password:
        raise ToolPresetError("Tool URLs may not embed credentials.")
    if parsed.fragment or (
        origin_only and (parsed.query or parsed.path not in {"", "/"})
    ):
        raise ToolPresetError(
            "Crawler allowlist entries must be origins without paths or queries."
        )
    hostname = parsed.hostname.casefold()
    if origin_only and hostname in {"localhost", "localhost.localdomain"}:
        raise ToolPresetError("Crawler origins may not target localhost.")
    if origin_only:
        try:
            address = ipaddress.ip_address(hostname.strip("[]"))
        except ValueError:
            pass
        else:
            if not address.is_global:
                raise ToolPresetError(
                    "Crawler origins may not target non-public IP addresses."
                )


def _validate_ephemeral_secret(value: str) -> None:
    if not isinstance(value, str) or not value or len(value) > 16_384:
        raise ToolPresetError("Resolved tool credential has an invalid length.")
    if "\x00" in value or "\r" in value or "\n" in value:
        raise ToolPresetError(
            "Resolved tool credential contains invalid control characters."
        )


def _minimal_process_environment() -> dict[str, str]:
    allowed = {
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
    }
    return {name: value for name, value in os.environ.items() if name in allowed}


def _validate_resolved_executable(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ToolPresetError("Executable resolution must return an absolute path.")
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ToolPresetError("Resolved executable is not a regular file.")
    if resolved.suffix.casefold() in {".bat", ".cmd", ".ps1", ".sh"}:
        raise ToolPresetError(
            "Shell-script executable shims are not accepted; install a native executable."
        )
    if os.name != "nt" and not os.access(resolved, os.X_OK):
        raise ToolPresetError("Resolved executable is not executable by this user.")
    return resolved


def _validate_limits(limits: ToolLimits) -> None:
    for name, (minimum, maximum) in _LIMIT_BOUNDS.items():
        python_name = _camel_to_snake(name)
        value = getattr(limits, python_name)
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not minimum <= value <= maximum
        ):
            raise ToolPresetError(f"Unsafe process limit: {name}")


def _camel_to_snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ToolPresetError(f"{label} must be an object.")
    return value


def _array_of_objects(value: object, label: str) -> list[dict[str, object]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ToolPresetError(f"{label} must be an array of objects.")
    return value


def _exact_keys(value: dict[str, object], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ToolPresetError(f"{label} contains missing or unknown fields.")


def _require_exact(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise ToolPresetError(f"{label} does not match the reviewed contract.")


def _reject_secret_values(value: object, label: str) -> None:
    if isinstance(value, str):
        if _SECRET_VALUE.search(value):
            raise ToolPresetError(f"{label} contains secret-shaped material.")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _reject_secret_values(item, f"{label}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            _reject_secret_values(item, f"{label}.{key}")
