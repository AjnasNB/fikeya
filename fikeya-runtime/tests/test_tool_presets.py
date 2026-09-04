# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import io
import json
import os
import sqlite3
import subprocess
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
from fikeya_runtime.workspace import Workspace, initialize_workspace

_NPM_PRESET_FIXTURES = {
    "cockroach-browser": {
        "package": "cockroach-browser",
        "version": "0.5.0-rc.1",
        "entrypoint": "dist/cli.js",
    },
    "cockroach-crawler": {
        "package": "cockroach-crawler",
        "version": "0.7.0",
        "entrypoint": "bin/cockroach-mcp.js",
    },
}


def _npm_cmd_install(
    tmp_path: Path,
    preset_id: str,
    *,
    layout: str = "local",
    version: str | None = None,
    target: str | None = None,
    shim_body: str | None = None,
) -> tuple[Path, Path]:
    fixture = _NPM_PRESET_FIXTURES[preset_id]
    package_name = fixture["package"]
    entrypoint_name = fixture["entrypoint"]
    windows_entrypoint = entrypoint_name.replace("/", "\\")
    command = preset_id if preset_id == "cockroach-browser" else "cockroach-mcp"
    prefix = tmp_path / f"npm-{layout}-{preset_id}"
    if layout == "local":
        package_root = prefix / "node_modules" / package_name
        bin_root = prefix / "node_modules" / ".bin"
        target_fragment = f"..\\{package_name}\\{windows_entrypoint}"
    elif layout == "global":
        package_root = prefix / "node_modules" / package_name
        bin_root = prefix
        target_fragment = f"node_modules\\{package_name}\\{windows_entrypoint}"
    else:
        raise AssertionError(f"unexpected npm test layout: {layout}")
    entrypoint = package_root / entrypoint_name
    entrypoint.parent.mkdir(parents=True, exist_ok=True)
    entrypoint.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    (package_root / "package.json").write_text(
        json.dumps(
            {
                "name": package_name,
                "version": version or fixture["version"],
                "bin": {command: entrypoint_name},
            }
        ),
        encoding="utf-8",
    )
    bin_root.mkdir(parents=True, exist_ok=True)
    shim = bin_root / f"{command}.cmd"
    selected_target = target or target_fragment
    generated = (
        "@ECHO off\r\n"
        "GOTO start\r\n"
        ":find_dp0\r\n"
        "SET dp0=%~dp0\r\n"
        "EXIT /b\r\n"
        ":start\r\n"
        "SETLOCAL\r\n"
        "CALL :find_dp0\r\n\r\n"
        'IF EXIST "%dp0%\\node.exe" (\r\n'
        '  SET "_prog=%dp0%\\node.exe"\r\n'
        ") ELSE (\r\n"
        '  SET "_prog=node"\r\n'
        "  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n"
        ")\r\n\r\n"
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "
        f'"%_prog%"  "%dp0%\\{selected_target}" %*\r\n'
    )
    shim.write_text(shim_body or generated, encoding="utf-8", newline="")
    return shim, entrypoint.resolve()


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
    assert all(
        tool["executionTrust"] == "trusted-local-executable" for tool in listed["tools"]
    )
    assert all(tool["osSandboxed"] is False for tool in listed["tools"])
    assert all(
        "does not restrict" in tool["sandboxWarning"] for tool in listed["tools"]
    )
    assert all(tool["processTreeContained"] is True for tool in listed["tools"])
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
    monkeypatch: pytest.MonkeyPatch,
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
    monkeypatch.setenv("HOME", str(tmp_path / "sensitive-home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "sensitive-profile"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "sensitive-appdata"))
    plan = loader.prepare_launch(
        workspace,
        preset.preset_id,
        configuration={"COCKROACH_BROWSER_URL": "https://browser.example"},
        secret_resolver=lambda name: "ephemeral-test-value" if name else None,
        executable_resolver=lambda _command: str(executable),
    )
    assert plan.argv == (str(executable.resolve()), "mcp")
    assert "HOME" not in plan.environment
    assert "USERPROFILE" not in plan.environment
    assert "LOCALAPPDATA" not in plan.environment
    assert "ephemeral-test-value" not in repr(plan)
    assert b"ephemeral-test-value" not in workspace.state_path.read_bytes()

    captured: dict[str, object] = {}

    def fake_process_factory(argv: list[str], **kwargs: object) -> object:
        captured["argv"] = argv
        captured.update(kwargs)
        return object()

    process, budget, process_tree = loader.spawn(
        plan, process_factory=fake_process_factory
    )
    assert process is not None
    assert isinstance(budget, ToolBudget)
    assert process_tree.process is process
    assert process_tree.contained is False
    assert captured["argv"] == [str(executable.resolve()), "mcp"]
    assert captured["shell"] is False
    assert captured["cwd"] == str(workspace.root)
    if os.name == "nt":
        assert captured["creationflags"] == subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        assert captured["start_new_session"] is True


@pytest.mark.parametrize(
    ("preset_id", "layout"),
    [("cockroach-browser", "local"), ("cockroach-crawler", "global")],
)
def test_prepare_launch_unwraps_reviewed_npm_cmd_shims_without_a_shell(
    tmp_path: Path, preset_id: str, layout: str
) -> None:
    root = tmp_path / f"project-{preset_id}"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    preset = PresetCatalog().get(preset_id)
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    shim, entrypoint = _npm_cmd_install(tmp_path, preset_id, layout=layout)
    loader = ToolPresetLoader()
    kwargs: dict[str, object] = {
        "configuration": (
            {"COCKROACH_ALLOWED_ORIGINS": "https://example.com"}
            if preset_id == "cockroach-crawler"
            else {"COCKROACH_BROWSER_URL": "http://127.0.0.1:43110"}
        ),
        "executable_resolver": lambda _command: str(shim),
    }
    if preset_id == "cockroach-browser":
        kwargs["secret_resolver"] = lambda _name: "ephemeral-test-token"

    plan = loader.prepare_launch(workspace, preset_id, **kwargs)

    assert Path(plan.argv[0]).name.casefold() in {"node", "node.exe"}
    assert plan.argv[1] == str(entrypoint)
    assert plan.argv[2:] == (("mcp",) if preset_id == "cockroach-browser" else ())
    assert plan.npm_shim == shim.resolve()
    assert (
        loader.diagnostic(
            preset, executable_resolver=lambda _command: str(shim)
        ).executable_found
        is True
    )

    captured: dict[str, object] = {}

    def fake_process_factory(argv: list[str], **spawn_kwargs: object) -> object:
        captured["argv"] = argv
        captured.update(spawn_kwargs)
        return object()

    loader.spawn(plan, process_factory=fake_process_factory)
    assert captured["argv"] == list(plan.argv)
    assert captured["shell"] is False


@pytest.mark.parametrize(
    ("version", "accepted"),
    [
        ("0.5.0-rc.1", True),
        ("0.5.0-rc.2", True),
        ("0.5.0-rc.1+fikeya.1", True),
        ("0.5.0", True),
        ("0.5.7", True),
        ("0.4.1", False),
        ("0.5.0-beta.99", False),
        ("0.5.0-rc.0", False),
        ("0.5.0-rc.01", False),
        ("0.5.1-alpha.1", False),
        ("0.6.0-rc.1", False),
        ("0.6.0", False),
        (f"0.5.0-{'x' * 33}", False),
        ("0.5.0-" + ".".join(["x"] * 17), False),
        ("1000000000.5.0", False),
        (f"0.5.0-rc.1+{'x' * 129}", False),
    ],
)
def test_browser_npm_package_enforces_reviewed_prerelease_range(
    tmp_path: Path, version: str, accepted: bool
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    preset = PresetCatalog().get("cockroach-browser")
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    shim, entrypoint = _npm_cmd_install(
        tmp_path, preset.preset_id, version=version
    )
    loader = ToolPresetLoader()

    def prepare() -> ToolLaunchPlan:
        return loader.prepare_launch(
            workspace,
            preset.preset_id,
            configuration={"COCKROACH_BROWSER_URL": "http://127.0.0.1:43110"},
            secret_resolver=lambda _name: "ephemeral-test-token",
            executable_resolver=lambda _command: str(shim),
        )

    if accepted:
        assert prepare().argv[1] == str(entrypoint)
    else:
        with pytest.raises(ToolPresetError, match="outside the reviewed range"):
            prepare()


def test_npm_cmd_unwrap_rejects_arbitrary_batch_content(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    preset = PresetCatalog().get("cockroach-crawler")
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    shim, _entrypoint = _npm_cmd_install(
        tmp_path,
        preset.preset_id,
        shim_body="@echo off\r\nnode attacker.js %*\r\n",
    )
    loader = ToolPresetLoader()

    with pytest.raises(ToolPresetError, match="reviewed npm-generated form"):
        loader.prepare_launch(
            workspace,
            preset.preset_id,
            configuration={"COCKROACH_ALLOWED_ORIGINS": "https://example.com"},
            executable_resolver=lambda _command: str(shim),
        )
    assert (
        loader.diagnostic(
            preset, executable_resolver=lambda _command: str(shim)
        ).executable_found
        is False
    )


def test_npm_cmd_unwrap_rejects_target_or_version_substitution(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    preset = PresetCatalog().get("cockroach-crawler")
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    wrong_target, _entrypoint = _npm_cmd_install(
        tmp_path,
        preset.preset_id,
        target="..\\other-package\\bin\\cockroach-mcp.js",
    )
    loader = ToolPresetLoader()
    with pytest.raises((OSError, ToolPresetError)):
        loader.prepare_launch(
            workspace,
            preset.preset_id,
            configuration={"COCKROACH_ALLOWED_ORIGINS": "https://example.com"},
            executable_resolver=lambda _command: str(wrong_target),
        )

    wrong_version, _entrypoint = _npm_cmd_install(
        tmp_path / "version",
        preset.preset_id,
        version="0.8.0",
    )
    with pytest.raises(ToolPresetError, match="outside the reviewed range"):
        loader.prepare_launch(
            workspace,
            preset.preset_id,
            configuration={"COCKROACH_ALLOWED_ORIGINS": "https://example.com"},
            executable_resolver=lambda _command: str(wrong_version),
        )


def test_spawn_revalidates_npm_package_binding_after_prepare(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    preset = PresetCatalog().get("cockroach-crawler")
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    shim, entrypoint = _npm_cmd_install(tmp_path, preset.preset_id)
    loader = ToolPresetLoader()
    plan = loader.prepare_launch(
        workspace,
        preset.preset_id,
        configuration={"COCKROACH_ALLOWED_ORIGINS": "https://example.com"},
        executable_resolver=lambda _command: str(shim),
    )
    package_manifest = entrypoint.parents[1] / "package.json"
    document = json.loads(package_manifest.read_text(encoding="utf-8"))
    document["version"] = "0.8.0"
    package_manifest.write_text(json.dumps(document), encoding="utf-8")
    invoked = False

    def fake_process_factory(*_args: object, **_kwargs: object) -> object:
        nonlocal invoked
        invoked = True
        return object()

    with pytest.raises(ToolPresetError, match="outside the reviewed range"):
        loader.spawn(plan, process_factory=fake_process_factory)
    assert invoked is False


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
    def _key(workspace: Workspace, preset_id: str, name: str) -> tuple[str, str, str]:
        config = workspace.config
        return (str(config.workspace_id), preset_id, name)

    def set(
        self,
        workspace: Workspace,
        preset_id: str,
        name: str,
        credential: str,
    ) -> None:
        self.values[self._key(workspace, preset_id, name)] = credential

    def configured(self, workspace: Workspace, preset_id: str, name: str) -> bool:
        return self._key(workspace, preset_id, name) in self.values

    def remove(self, workspace: Workspace, preset_id: str, name: str) -> None:
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
