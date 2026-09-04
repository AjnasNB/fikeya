# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fikeya_runtime.artifact import (
    FIKEYA_ARTIFACT_SCHEMA,
    artifact_file_sha256,
    artifact_sha256,
    create_artifact_manifest,
)
from fikeya_runtime.errors import ConfigurationError
from fikeya_runtime.util import sha256_text


def test_artifact_manifest_is_content_free_sorted_and_deterministic(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtime"
    nested = root / "lib"
    nested.mkdir(parents=True)
    executable = root / "qarinah"
    executable.write_bytes(b"#!/usr/bin/env python3\n")
    helper = nested / "helper.py"
    helper.write_bytes(b"print('bounded fixture')\n")
    executable.chmod(0o755)
    helper.chmod(0o644)
    manifest = create_artifact_manifest(root.resolve())

    assert manifest == {
        "schema": FIKEYA_ARTIFACT_SCHEMA,
        "files": [
            {
                "path": "lib/helper.py",
                "size": len(b"print('bounded fixture')\n"),
                "mode": 0,
                "sha256": sha256_text("print('bounded fixture')\n"),
            },
            {
                "path": "qarinah",
                "size": len(b"#!/usr/bin/env python3\n"),
                "mode": 0,
                "sha256": sha256_text("#!/usr/bin/env python3\n"),
            },
        ],
    }
    assert artifact_file_sha256(executable.resolve()) == sha256_text(
        "#!/usr/bin/env python3\n"
    )
    assert artifact_sha256(root.resolve()) == artifact_sha256(root.resolve())


def test_artifact_manifest_normalizes_host_file_modes(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    artifact = root / "tool.cmd"
    artifact.write_bytes(b"@echo off\r\n")

    initial_manifest = create_artifact_manifest(root.resolve())
    initial_digest = artifact_sha256(root.resolve())

    artifact.chmod(0o755)
    changed_manifest = create_artifact_manifest(root.resolve())
    changed_digest = artifact_sha256(root.resolve())

    assert initial_manifest["files"][0]["mode"] == 0
    assert changed_manifest == initial_manifest
    assert changed_digest == initial_digest


def test_artifact_manifest_rejects_links_and_shared_hardlinks(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    target = root / "target"
    target.write_text("bounded", encoding="utf-8")
    link = root / "link"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("This platform does not permit the fixture symlink.")

    with pytest.raises(ConfigurationError, match="links or reparse"):
        create_artifact_manifest(root.resolve())

    link.unlink()
    hardlink = root / "hardlink"
    try:
        os.link(target, hardlink)
    except OSError:
        pytest.skip("This platform does not permit the fixture hardlink.")
    with pytest.raises(ConfigurationError, match="private regular"):
        create_artifact_manifest(root.resolve())


def test_artifact_manifest_rejects_empty_and_noncanonical_roots(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    with pytest.raises(ConfigurationError, match="at least one"):
        create_artifact_manifest(root.resolve())

    alias = tmp_path / "alias"
    try:
        alias.symlink_to(root, target_is_directory=True)
    except OSError:
        pytest.skip("This platform does not permit the fixture symlink.")
    with pytest.raises(ConfigurationError, match="must not itself"):
        create_artifact_manifest(alias.absolute())


def test_artifact_manifest_allows_a_linked_ancestor_but_not_linked_entries(
    tmp_path: Path,
) -> None:
    actual_parent = tmp_path / "actual-parent"
    actual_root = actual_parent / "runtime"
    actual_root.mkdir(parents=True)
    (actual_root / "sidecar.mjs").write_text("export {};\n", encoding="utf-8")
    linked_parent = tmp_path / "linked-parent"
    try:
        linked_parent.symlink_to(actual_parent, target_is_directory=True)
    except OSError:
        pytest.skip("This platform does not permit the fixture symlink.")

    assert create_artifact_manifest(linked_parent / "runtime") == (
        create_artifact_manifest(actual_root.resolve())
    )

    linked_entry = actual_root / "sidecar-alias.mjs"
    linked_entry.symlink_to(actual_root / "sidecar.mjs")
    with pytest.raises(ConfigurationError, match="links or reparse"):
        create_artifact_manifest(linked_parent / "runtime")
