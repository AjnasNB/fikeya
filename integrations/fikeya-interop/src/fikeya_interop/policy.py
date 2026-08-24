"""Root, executable, environment, and MCP tool policies."""

from __future__ import annotations

import fnmatch
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .errors import PermissionDeniedError
from .models import ProcessSpec

_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SENSITIVE_ENVIRONMENT = re.compile(
    r"(?:^|_)(?:api_?key|auth(?:orization)?|bearer|cookie|credential|oauth|password|secret|token)(?:$|_)",
    re.IGNORECASE,
)
_DEFAULT_INHERITED_ENVIRONMENT = frozenset(
    {
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    }
)


@dataclass(frozen=True, slots=True)
class PathPolicy:
    """Resolve peer-provided paths beneath one immutable workspace root."""

    root: Path

    def __post_init__(self) -> None:
        object.__setattr__(self, "root", self.root.resolve(strict=True))
        if not self.root.is_dir():
            raise ValueError("workspace root must be a directory")

    def resolve(self, value: str | Path, *, must_exist: bool = False) -> Path:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        resolved = candidate.resolve(strict=must_exist)
        try:
            resolved.relative_to(self.root)
        except ValueError as error:
            raise PermissionDeniedError("path is outside the configured workspace root") from error
        return resolved


@dataclass(frozen=True, slots=True)
class ProcessPolicy:
    """Validate a stdio peer without invoking a shell or forwarding secrets."""

    root: PathPolicy
    allowed_commands: frozenset[str]
    inherited_environment: frozenset[str] = _DEFAULT_INHERITED_ENVIRONMENT
    allowed_environment: frozenset[str] = field(default_factory=frozenset)
    max_args: int = 128
    max_arg_bytes: int = 16_384

    def validate(self, spec: ProcessSpec) -> ProcessSpec:
        command = spec.command.strip()
        if not command or "\x00" in command or "\n" in command or "\r" in command:
            raise PermissionDeniedError("invalid process command")
        command_name = Path(command).name.casefold()
        allowed = {value.casefold() for value in self.allowed_commands}
        if command.casefold() not in allowed and command_name not in allowed:
            raise PermissionDeniedError(f"process command is not allowlisted: {command_name}")
        if len(spec.args) > self.max_args:
            raise PermissionDeniedError("process argument count exceeds policy")
        if sum(len(argument.encode("utf-8")) for argument in spec.args) > self.max_arg_bytes:
            raise PermissionDeniedError("process arguments exceed policy")
        if any("\x00" in argument for argument in spec.args):
            raise PermissionDeniedError("process arguments contain a null byte")

        cwd = self.root.resolve(spec.cwd or self.root.root, must_exist=True)
        environment = self._validate_environment(spec.environment)
        return ProcessSpec(
            identifier=spec.identifier,
            command=command,
            args=tuple(spec.args),
            cwd=cwd,
            environment=environment,
        )

    def build_environment(self, spec: ProcessSpec) -> dict[str, str]:
        validated = self.validate(spec)
        environment = {
            name: value
            for name, value in os.environ.items()
            if name in self.inherited_environment and not _SENSITIVE_ENVIRONMENT.search(name)
        }
        environment.update(validated.environment)
        return environment

    def _validate_environment(self, values: Mapping[str, str]) -> dict[str, str]:
        result: dict[str, str] = {}
        for name, value in values.items():
            if not _ENVIRONMENT_NAME.fullmatch(name):
                raise PermissionDeniedError("invalid environment variable name")
            if _SENSITIVE_ENVIRONMENT.search(name):
                raise PermissionDeniedError("credentials must not be relayed through an agent process manifest")
            if name not in self.allowed_environment:
                raise PermissionDeniedError(f"environment variable is not allowlisted: {name}")
            if "\x00" in value:
                raise PermissionDeniedError("environment variable contains a null byte")
            result[name] = value
        return result


@dataclass(frozen=True, slots=True)
class ToolPolicy:
    """Allow MCP tools by explicit ``server/tool`` glob patterns."""

    allowlist: tuple[str, ...]

    def require(self, server_id: str, tool_name: str) -> None:
        qualified = f"{server_id}/{tool_name}"
        if not any(fnmatch.fnmatchcase(qualified, pattern) for pattern in self.allowlist):
            raise PermissionDeniedError(f"MCP tool is not allowlisted: {qualified}")
