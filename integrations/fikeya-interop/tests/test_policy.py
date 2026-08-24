from pathlib import Path

import pytest

from fikeya_interop import (
    PathPolicy,
    PermissionDeniedError,
    ProcessPolicy,
    ProcessSpec,
    ResourceLimits,
    ToolPolicy,
)


def test_path_policy_rejects_parent_escape(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    policy = PathPolicy(workspace)

    with pytest.raises(PermissionDeniedError, match="outside"):
        policy.resolve("../private.txt")


def test_process_policy_builds_a_secret_free_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("PATH", "safe-path")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-cross")
    policy = ProcessPolicy(
        root=PathPolicy(workspace),
        allowed_commands=frozenset({"codex"}),
        allowed_environment=frozenset({"RUST_LOG"}),
    )
    spec = ProcessSpec(
        identifier="codex",
        command="codex",
        args=("app-server", "--listen", "stdio://"),
        cwd=workspace,
        environment={"RUST_LOG": "warn"},
    )

    environment = policy.build_environment(spec)

    assert environment["PATH"] == "safe-path"
    assert environment["RUST_LOG"] == "warn"
    assert "OPENAI_API_KEY" not in environment


def test_process_policy_rejects_credentials_even_if_explicitly_allowlisted(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    policy = ProcessPolicy(
        root=PathPolicy(workspace),
        allowed_commands=frozenset({"agent"}),
        allowed_environment=frozenset({"API_TOKEN"}),
    )

    with pytest.raises(PermissionDeniedError, match="credentials"):
        policy.validate(
            ProcessSpec(
                identifier="agent",
                command="agent",
                cwd=workspace,
                environment={"API_TOKEN": "never"},
            )
        )


def test_tool_policy_defaults_to_deny() -> None:
    with pytest.raises(PermissionDeniedError, match="not allowlisted"):
        ToolPolicy(()).require("filesystem", "read_file")


def test_tool_policy_accepts_qualified_globs() -> None:
    ToolPolicy(("workspace/read_*",)).require("workspace", "read_file")


def test_resource_limits_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive"):
        ResourceLimits(max_output_bytes=0)
