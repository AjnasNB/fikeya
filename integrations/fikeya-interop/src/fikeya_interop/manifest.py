"""Strict loader for credential-free interoperability manifests."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ProtocolError
from .models import ProcessSpec
from .policy import PathPolicy

_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_PROTOCOLS = frozenset({"acp", "codex-app-server", "mcp"})
_FIELDS = frozenset(
    {
        "$schema",
        "version",
        "identifier",
        "protocol",
        "command",
        "args",
        "workingDirectory",
        "environment",
        "toolAllowlist",
    }
)


@dataclass(frozen=True, slots=True)
class InteropManifest:
    """Validated process and tool configuration without credential fields."""

    version: int
    protocol: str
    process: ProcessSpec
    tool_allowlist: tuple[str, ...] = ()


def load_manifest(path: Path, workspace_root: Path, *, max_bytes: int = 1_048_576) -> InteropManifest:
    """Read and validate a local JSON manifest beneath a workspace root."""

    manifest_path = path.resolve(strict=True)
    payload = manifest_path.read_bytes()
    if len(payload) > max_bytes:
        raise ProtocolError("interop manifest exceeds the configured limit")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("interop manifest is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ProtocolError("interop manifest must be a JSON object")
    unexpected = set(value) - _FIELDS
    if unexpected:
        raise ProtocolError(f"interop manifest has unknown fields: {', '.join(sorted(unexpected))}")
    version = value.get("version")
    if version != 1:
        raise ProtocolError("unsupported interop manifest version")
    identifier = _require_string(value, "identifier")
    if not _IDENTIFIER.fullmatch(identifier):
        raise ProtocolError("interop manifest identifier is invalid")
    protocol = _require_string(value, "protocol")
    if protocol not in _PROTOCOLS:
        raise ProtocolError(f"unsupported interop protocol: {protocol}")
    command = _require_string(value, "command")
    args = _string_list(value.get("args", []), "args")
    working_directory = value.get("workingDirectory", ".")
    if not isinstance(working_directory, str) or Path(working_directory).is_absolute():
        raise ProtocolError("workingDirectory must be a relative path")
    root = PathPolicy(workspace_root)
    cwd = root.resolve(working_directory, must_exist=True)
    environment = value.get("environment", {})
    if not isinstance(environment, dict) or not all(
        isinstance(name, str) and isinstance(item, str) for name, item in environment.items()
    ):
        raise ProtocolError("environment must contain only string values")
    allowlist = _string_list(value.get("toolAllowlist", []), "toolAllowlist")
    return InteropManifest(
        version=version,
        protocol=protocol,
        process=ProcessSpec(
            identifier=identifier,
            command=command,
            args=tuple(args),
            cwd=cwd,
            environment=dict(environment),
        ),
        tool_allowlist=tuple(allowlist),
    )


def _require_string(value: dict[str, Any], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or not item:
        raise ProtocolError(f"interop manifest field must be a non-empty string: {name}")
    return item


def _string_list(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ProtocolError(f"interop manifest field must be a string array: {name}")
    return value
