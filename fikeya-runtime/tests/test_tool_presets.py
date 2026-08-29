# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import io
import json
import sqlite3
import sys
from pathlib import Path

import pytest

import fikeya_runtime.cli as cli_module
from fikeya_runtime.cli import main
from fikeya_runtime.errors import ToolPresetError
from fikeya_runtime.tool_presets import (
    PresetCatalog,
    ToolBudget,
    ToolEnablementStore,
    ToolLaunchPlan,
    ToolLimits,
    ToolPresetLoader,
)
from fikeya_runtime.workspace import initialize_workspace


def test_cli_lists_disabled_presets_and_requires_workspace_confirmation(
    tmp_path: Path,
    capsys: object,
) -> None:
    workspace_root = tmp_path / "project"
    workspace_root.mkdir()
    workspace, _ = initialize_workspace(workspace_root)

    assert main(["tool", "list", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert [tool["id"] for tool in listed["tools"]] == [
        "cockroach-browser",
        "cockroach-crawler",
    ]
    assert all(tool["enabled"] is False for tool in listed["tools"])
    assert all("not verified" in tool["provenanceWarning"] for tool in listed["tools"])
    assert all(tool["transport"] == "stdio" for tool in listed["tools"])
    assert all(tool["requiresExactApproval"] is True for tool in listed["tools"])
    assert listed["tools"][0]["brokerNamespace"] == "mcp.cockroach-browser"
    assert (
        "mcp.cockroach-browser.browser_capabilities"
        in listed["tools"][0]["brokerTools"]
    )

    assert (
        main(
            [
                "tool",
                "enable",
                "cockroach-crawler",
                "--workspace",
                str(workspace.root),
                "--json",
            ]
        )
        == 2
    )
    denied = json.loads(capsys.readouterr().out)
    assert "--confirm-workspace" in denied["error"]

    assert (
        main(
            [
                "tool",
                "enable",
                "cockroach-crawler",
                "--workspace",
                str(workspace.root),
                "--confirm-workspace",
                "--json",
            ]
        )
        == 0
    )
    enabled = json.loads(capsys.readouterr().out)
    assert enabled["tool"]["enabled"] is True
    assert enabled["workspaceId"] == workspace.config.workspace_id

    assert (
        main(
            [
                "tool",
                "status",
                "cockroach-crawler",
                "--workspace",
                str(workspace.root),
                "--json",
            ]
        )
        == 0
    )
    status = json.loads(capsys.readouterr().out)
    assert status["tools"][0]["enabled"] is True
    assert status["tools"][0]["runtimeState"] in {
        "configuration-missing",
        "credential-missing",
        "executable-missing",
        "preflight-ready",
    }

    assert (
        main(
            [
                "tool",
                "disable",
                "cockroach-crawler",
                "--workspace",
                str(workspace.root),
                "--json",
            ]
        )
        == 0
    )
    disabled = json.loads(capsys.readouterr().out)
    assert disabled["previouslyEnabled"] is True
    assert disabled["tool"]["enabled"] is False


def test_cli_tool_credentials_use_keyring_adapter_without_echoing_values(
    tmp_path: Path,
    capsys: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    credentials = _MemoryToolCredentials()
    monkeypatch.setattr(cli_module, "McpCredentialStore", lambda: credentials)
    credential = "bounded-test-credential-never-echoed"
    monkeypatch.setattr(sys, "stdin", io.StringIO(f"{credential}\n"))

    assert (
        main(
            [
                "tool",
                "credential-set",
                "cockroach-browser",
                "COCKROACH_BROWSER_TOKEN",
                "--workspace",
                str(workspace.root),
                "--secret-stdin",
                "--json",
            ]
        )
        == 0
    )
    configured_text = capsys.readouterr().out
    configured = json.loads(configured_text)
    assert configured["configured"] is True
    assert credential not in configured_text
    assert credentials.values == {
        (
            workspace.config.workspace_id,
            "cockroach-browser",
            "COCKROACH_BROWSER_TOKEN",
        ): credential
    }

    assert (
        main(
            [
                "tool",
                "status",
                "cockroach-browser",
                "--workspace",
                str(workspace.root),
                "--json",
            ]
        )
        == 0
    )
    status_text = capsys.readouterr().out
    status = json.loads(status_text)
    assert status["tools"][0]["credentials"] == [
        {
            "configured": True,
            "name": "COCKROACH_BROWSER_TOKEN",
            "required": True,
        }
    ]
    assert credential not in status_text

    assert (
        main(
            [
                "tool",
                "credential-remove",
                "cockroach-browser",
                "COCKROACH_BROWSER_TOKEN",
                "--workspace",
                str(workspace.root),
                "--json",
            ]
        )
        == 0
    )
    removed = json.loads(capsys.readouterr().out)
    assert removed["configured"] is False
    assert credentials.values == {}


def test_enablement_database_contains_only_non_secret_metadata(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    preset = PresetCatalog().get("cockroach-browser")
    store = ToolEnablementStore(workspace)
    store.enable(preset, confirmed=True)

    with sqlite3.connect(workspace.state_path) as connection:
        columns = {
            row[1]
            for row in connection.execute(
                "PRAGMA table_info(tool_enablements)"
            ).fetchall()
        }
        row = connection.execute("SELECT * FROM tool_enablements").fetchone()
    assert columns == {"preset_id", "preset_sha256", "enabled_at"}
    assert row is not None
    assert row[0] == "cockroach-browser"
    assert b"COCKROACH_BROWSER_TOKEN" not in workspace.state_path.read_bytes()


def test_manifest_change_disables_until_explicit_reconfirmation(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    catalog_path = tmp_path / "catalog"
    catalog_path.mkdir()
    document = _bundled_document("cockroach-browser")
    _write_document(catalog_path, document)
    original = PresetCatalog(catalog_path).get("cockroach-browser")
    store = ToolEnablementStore(workspace)
    store.enable(original, confirmed=True)

    document["summary"] = "A changed but still bounded reviewed-preset summary."
    _write_document(catalog_path, document)
    changed = PresetCatalog(catalog_path).get("cockroach-browser")
    status = store.status(changed)
    assert status.enabled is False
    assert status.requires_confirmation is True


@pytest.mark.parametrize(
    ("location", "value"),
    [
        (("transport", "command"), "cmd.exe"),
        (("transport", "shell"), True),
        (("limits", "maxResponseBytes"), 100_000_000),
    ],
)
def test_catalog_rejects_malicious_command_shell_and_limits(
    tmp_path: Path,
    location: tuple[str, str],
    value: object,
) -> None:
    catalog_path = tmp_path / "catalog"
    catalog_path.mkdir()
    document = _bundled_document("cockroach-browser")
    nested = document[location[0]]
    assert isinstance(nested, dict)
    nested[location[1]] = value
    _write_document(catalog_path, document)

    with pytest.raises(ToolPresetError):
        PresetCatalog(catalog_path)


def test_catalog_rejects_filesystem_root_and_symlink_escape(tmp_path: Path) -> None:
    with pytest.raises(ToolPresetError, match="filesystem root"):
        PresetCatalog(Path(tmp_path.anchor))

    catalog_path = tmp_path / "catalog"
    outside = tmp_path / "outside"
    catalog_path.mkdir()
    outside.mkdir()
    external = outside / "cockroach-browser.preset.json"
    external.write_text(
        json.dumps(_bundled_document("cockroach-browser")), encoding="utf-8"
    )
    link = catalog_path / "cockroach-browser.preset.json"
    try:
        link.symlink_to(external)
    except OSError:
        pytest.skip("This Windows account cannot create symbolic links.")
    with pytest.raises(ToolPresetError, match="escapes|symbolic"):
        PresetCatalog(catalog_path)


def test_prepare_and_spawn_are_shell_free_and_never_invoke_a_real_tool(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    preset = PresetCatalog().get("cockroach-browser")
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    executable = tmp_path / "cockroach-browser.exe"
    executable.write_bytes(b"not executed")
    executable.chmod(0o700)
    loader = ToolPresetLoader()
    plan = loader.prepare_launch(
        workspace,
        preset.preset_id,
        configuration={"COCKROACH_BROWSER_URL": "https://browser.example"},
        secret_resolver=lambda name: "ephemeral-test-value" if name else None,
        executable_resolver=lambda _command: str(executable),
    )
    assert plan.argv == (str(executable.resolve()), "mcp")
    assert "ephemeral-test-value" not in repr(plan)
    assert b"ephemeral-test-value" not in workspace.state_path.read_bytes()

    captured: dict[str, object] = {}

    def fake_process_factory(argv: list[str], **kwargs: object) -> object:
        captured["argv"] = argv
        captured.update(kwargs)
        return object()

    process, budget = loader.spawn(plan, process_factory=fake_process_factory)
    assert process is not None
    assert isinstance(budget, ToolBudget)
    assert captured["argv"] == [str(executable.resolve()), "mcp"]
    assert captured["shell"] is False
    assert captured["cwd"] == str(workspace.root)


def test_unsafe_budget_is_rejected_before_process_factory(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    executable = tmp_path / "tool.exe"
    executable.write_bytes(b"not executed")
    limits = _limits(max_request_bytes=8 * 1024 * 1024 + 1)
    plan = ToolLaunchPlan(
        preset_id="cockroach-browser",
        argv=(str(executable.resolve()),),
        cwd=workspace.root,
        limits=limits,
        environment={},
    )
    invoked = False

    def fake_process_factory(*_args: object, **_kwargs: object) -> object:
        nonlocal invoked
        invoked = True
        return object()

    with pytest.raises(ToolPresetError, match="Unsafe process limit"):
        ToolPresetLoader().spawn(plan, process_factory=fake_process_factory)
    assert invoked is False


def test_request_response_concurrency_count_and_timeout_budgets() -> None:
    clock = _Clock()
    budget = ToolBudget(
        _limits(
            max_concurrent_requests=1,
            max_requests_per_session=2,
            max_request_bytes=1_024,
            max_response_bytes=1_024,
            request_timeout_ms=100,
        ),
        monotonic=clock,
    )
    with (
        budget.request(b"one"),
        pytest.raises(ToolPresetError, match="concurrent"),
        budget.request(b"two"),
    ):
        pass
    with (
        pytest.raises(ToolPresetError, match="request-byte"),
        budget.request(b"x" * 1_025),
    ):
        pass
    with pytest.raises(ToolPresetError, match="response-byte"):
        budget.validate_response(b"x" * 1_025)
    with pytest.raises(ToolPresetError, match="timeout"), budget.request(b"two"):
        clock.value += 0.101


def test_bundled_presets_match_the_reviewed_integration_manifests() -> None:
    repository = Path(__file__).resolve().parents[2]
    integration = repository / "integrations" / "tool-presets"
    for preset_id in ("cockroach-browser", "cockroach-crawler"):
        expected = json.loads(
            (integration / f"{preset_id}.preset.json").read_text(encoding="utf-8")
        )
        assert _bundled_document(preset_id) == expected


class _MemoryToolCredentials:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str, str], str] = {}

    @staticmethod
    def _key(workspace: object, preset_id: str, name: str) -> tuple[str, str, str]:
        config = getattr(workspace, "config")
        return (str(config.workspace_id), preset_id, name)

    def set(
        self,
        workspace: object,
        preset_id: str,
        name: str,
        credential: str,
    ) -> None:
        self.values[self._key(workspace, preset_id, name)] = credential

    def configured(self, workspace: object, preset_id: str, name: str) -> bool:
        return self._key(workspace, preset_id, name) in self.values

    def remove(self, workspace: object, preset_id: str, name: str) -> None:
        self.values.pop(self._key(workspace, preset_id, name), None)


class _Clock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def _limits(**changes: int) -> ToolLimits:
    values = {
        "startup_timeout_ms": 1_000,
        "request_timeout_ms": 1_000,
        "shutdown_timeout_ms": 1_000,
        "max_concurrent_requests": 1,
        "max_requests_per_session": 10,
        "max_session_duration_ms": 60_000,
        "max_request_bytes": 1_024,
        "max_response_bytes": 1_024,
    }
    values.update(changes)
    return ToolLimits(**values)


def _bundled_document(preset_id: str) -> dict[str, object]:
    repository = Path(__file__).resolve().parents[2]
    path = (
        repository
        / "fikeya-runtime"
        / "src"
        / "fikeya_runtime"
        / "presets"
        / f"{preset_id}.preset.json"
    )
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _write_document(directory: Path, document: dict[str, object]) -> None:
    preset_id = document["id"]
    assert isinstance(preset_id, str)
    (directory / f"{preset_id}.preset.json").write_text(
        json.dumps(document), encoding="utf-8"
    )
