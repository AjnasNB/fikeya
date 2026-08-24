# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

from pathlib import Path

import pytest

from fikeya_runtime.errors import WorkspaceError
from fikeya_runtime.workspace import Workspace, WorkspaceBoundary, initialize_workspace


def test_initialize_is_idempotent_and_creates_private_local_state(tmp_path: Path) -> None:
    workspace, created = initialize_workspace(tmp_path)
    reloaded, created_again = initialize_workspace(tmp_path)

    assert {
        "created": created,
        "created_again": created_again,
        "workspace_id_stable": workspace.config.workspace_id == reloaded.config.workspace_id,
        "config_exists": (tmp_path / ".fikeya" / "workspace.json").is_file(),
        "state_exists": workspace.state_path.is_file(),
        "ignore": (tmp_path / ".fikeya" / ".gitignore").read_text(encoding="utf-8"),
        "loaded": Workspace.load(tmp_path).config.workspace_id,
    } == {
        "created": True,
        "created_again": False,
        "workspace_id_stable": True,
        "config_exists": True,
        "state_exists": True,
        "ignore": "state.sqlite3\nstate.sqlite3-*\n*.tmp\n",
        "loaded": workspace.config.workspace_id,
    }


def test_boundary_rejects_absolute_and_parent_traversal(tmp_path: Path) -> None:
    boundary = WorkspaceBoundary(tmp_path)

    with pytest.raises(WorkspaceError, match="relative"):
        boundary.resolve(tmp_path / "file.txt")
    with pytest.raises(WorkspaceError, match="escapes"):
        boundary.resolve("../outside.txt")


def test_boundary_resolves_a_safe_nonexistent_output(tmp_path: Path) -> None:
    boundary = WorkspaceBoundary(tmp_path)

    assert boundary.resolve("generated/result.txt") == (
        tmp_path / "generated" / "result.txt"
    ).resolve()
