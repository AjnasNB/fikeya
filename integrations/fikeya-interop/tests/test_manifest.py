from __future__ import annotations

import json
from pathlib import Path

import pytest

from fikeya_interop import PathPolicy, PermissionDeniedError, ProcessPolicy, ProtocolError, load_manifest

MANIFESTS = Path(__file__).parents[1] / "manifests"


@pytest.mark.parametrize(
    "name, protocol",
    [
        ("codex-app-server.json", "codex-app-server"),
        ("generic-acp.example.json", "acp"),
        ("generic-mcp.example.json", "mcp"),
    ],
)
def test_shipped_manifests_load_with_root_bound_working_directories(
    name: str, protocol: str, tmp_path: Path
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    manifest = load_manifest(MANIFESTS / name, workspace)

    assert manifest.protocol == protocol
    assert manifest.process.cwd == workspace.resolve()


def test_manifest_rejects_unknown_fields(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manifest_path = tmp_path / "invalid.json"
    manifest_path.write_text(
        json.dumps(
            {
                "version": 1,
                "identifier": "agent",
                "protocol": "acp",
                "command": "agent",
                "credential": "must-not-exist",
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ProtocolError, match="unknown fields"):
        load_manifest(manifest_path, workspace)


def test_manifest_credentials_are_rejected_by_process_policy(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manifest_path = tmp_path / "credential.json"
    manifest_path.write_text(
        json.dumps(
            {
                "version": 1,
                "identifier": "agent",
                "protocol": "acp",
                "command": "agent",
                "environment": {"API_TOKEN": "never"},
            }
        ),
        encoding="utf-8",
    )
    manifest = load_manifest(manifest_path, workspace)
    policy = ProcessPolicy(
        root=PathPolicy(workspace),
        allowed_commands=frozenset({"agent"}),
        allowed_environment=frozenset({"API_TOKEN"}),
    )

    with pytest.raises(PermissionDeniedError, match="credentials"):
        policy.validate(manifest.process)
