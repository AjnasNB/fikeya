# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Workspace initialization and path-containment checks."""

from __future__ import annotations

import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigurationError, WorkspaceError
from .util import (
    atomic_write_text,
    read_json_object,
    stable_json,
    utc_now,
    validate_identifier,
)

WORKSPACE_DIRECTORY = ".fikeya"
WORKSPACE_CONFIG = "workspace.json"
STATE_DATABASE = "state.sqlite3"


@dataclass(frozen=True, slots=True)
class WorkspaceConfig:
    """Shareable workspace metadata. It never contains credentials."""

    workspace_id: str
    created_at: str
    schema_version: int = 1

    def as_json(self) -> dict[str, object]:
        """Return the stable persisted representation."""

        return {
            "createdAt": self.created_at,
            "schemaVersion": self.schema_version,
            "workspaceId": self.workspace_id,
        }

    @classmethod
    def from_json(cls, value: dict[str, object]) -> WorkspaceConfig:
        """Validate a persisted workspace configuration."""

        expected = {"createdAt", "schemaVersion", "workspaceId"}
        unknown = set(value) - expected
        if unknown:
            raise ConfigurationError(
                f"Workspace configuration contains unknown fields: {', '.join(sorted(unknown))}."
            )
        workspace_id = value.get("workspaceId")
        created_at = value.get("createdAt")
        schema_version = value.get("schemaVersion")
        if not isinstance(workspace_id, str):
            raise ConfigurationError("workspaceId must be a string.")
        if not isinstance(created_at, str) or not created_at.endswith("Z"):
            raise ConfigurationError("createdAt must be a UTC timestamp.")
        if schema_version != 1:
            raise ConfigurationError("Unsupported workspace schema version.")
        validate_identifier(workspace_id, "workspaceId")
        return cls(
            workspace_id=workspace_id,
            created_at=created_at,
            schema_version=schema_version,
        )


class WorkspaceBoundary:
    """Resolve caller-supplied paths without escaping an authorized root."""

    def __init__(self, root: str | Path) -> None:
        root_path = Path(root).expanduser().resolve(strict=True)
        if not root_path.is_dir():
            raise WorkspaceError(f"Workspace root is not a directory: {root_path}")
        self.root = root_path

    def resolve(self, relative_path: str | Path, *, must_exist: bool = False) -> Path:
        """Resolve a relative path and reject traversal or symlink escapes."""

        supplied = Path(relative_path)
        if supplied.is_absolute():
            raise WorkspaceError("Workspace paths must be relative.")
        candidate = (self.root / supplied).resolve(strict=must_exist)
        try:
            common = Path(os.path.commonpath((self.root, candidate)))
        except ValueError as error:
            raise WorkspaceError(
                "Path is on a different filesystem from the workspace."
            ) from error
        if os.path.normcase(str(common)) != os.path.normcase(str(self.root)):
            raise WorkspaceError(
                f"Path escapes the workspace boundary: {relative_path}"
            )
        return candidate


@dataclass(frozen=True, slots=True)
class Workspace:
    """An initialized Fikeya workspace and its local state paths."""

    root: Path
    config: WorkspaceConfig

    @property
    def metadata_directory(self) -> Path:
        """Return the local Fikeya metadata directory."""

        return self.root / WORKSPACE_DIRECTORY

    @property
    def state_path(self) -> Path:
        """Return the local SQLite state path."""

        return self.metadata_directory / STATE_DATABASE

    @property
    def boundary(self) -> WorkspaceBoundary:
        """Return a path boundary bound to this workspace."""

        return WorkspaceBoundary(self.root)

    @classmethod
    def load(cls, root: str | Path) -> Workspace:
        """Load and validate an initialized workspace."""

        resolved_root = Path(root).expanduser().resolve(strict=True)
        config_path = resolved_root / WORKSPACE_DIRECTORY / WORKSPACE_CONFIG
        if not config_path.is_file():
            raise WorkspaceError(
                f"No Fikeya workspace found at {resolved_root}. Run 'fikeya init'."
            )
        config = WorkspaceConfig.from_json(read_json_object(config_path))
        return cls(root=resolved_root, config=config)


def initialize_workspace(root: str | Path) -> tuple[Workspace, bool]:
    """Create local workspace metadata and initialize durable state."""

    resolved_root = Path(root).expanduser().resolve(strict=True)
    if not resolved_root.is_dir():
        raise WorkspaceError(f"Workspace root is not a directory: {resolved_root}")
    metadata_directory = resolved_root / WORKSPACE_DIRECTORY
    metadata_directory.mkdir(mode=0o700, exist_ok=True)
    config_path = metadata_directory / WORKSPACE_CONFIG
    created = not config_path.exists()
    if created:
        config = WorkspaceConfig(
            workspace_id=f"ws_{uuid.uuid4().hex}",
            created_at=utc_now(),
        )
        atomic_write_text(config_path, f"{stable_json(config.as_json())}\n")
    workspace = Workspace.load(resolved_root)
    ignore_path = metadata_directory / ".gitignore"
    expected_ignore = "state.sqlite3\nstate.sqlite3-*\n*.tmp\n"
    if not ignore_path.exists():
        atomic_write_text(ignore_path, expected_ignore, mode=0o644)
    from .state import StateStore

    StateStore(workspace.state_path).initialize()
    return workspace, created


def discover_workspace(start: str | Path) -> Workspace:
    """Walk parent directories to find an initialized workspace."""

    current = Path(start).expanduser().resolve(strict=True)
    if current.is_file():
        current = current.parent
    for candidate in (current, *current.parents):
        if (candidate / WORKSPACE_DIRECTORY / WORKSPACE_CONFIG).is_file():
            return Workspace.load(candidate)
    raise WorkspaceError(f"No initialized Fikeya workspace contains {current}.")


def runtime_home(explicit: str | Path | None = None) -> Path:
    """Return the per-user metadata location without storing credentials there."""

    if explicit is not None:
        return Path(explicit).expanduser().resolve(strict=False)
    override = os.environ.get("FIKEYA_HOME")
    if override:
        return Path(override).expanduser().resolve(strict=False)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "Fikeya"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Fikeya"
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "fikeya"
