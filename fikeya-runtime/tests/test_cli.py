# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import io
import json
from pathlib import Path

from fikeya_runtime.cli import main
from fikeya_runtime.errors import SecretStoreUnavailable


def test_cli_init_and_provider_listing_make_no_network_calls(
    tmp_path: Path,
    capsys: object,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    initialized = json.loads(capsys.readouterr().out)
    assert initialized["created"] is True

    assert (
        main(
            [
                "--home",
                str(home),
                "provider",
                "configure",
                "local",
                "--kind",
                "ollama",
                "--model",
                "qwen",
                "--json",
            ]
        )
        == 0
    )
    configured = json.loads(capsys.readouterr().out)
    assert configured == {
        "kind": "ollama",
        "message": "Provider configured without persisting credential bytes.",
        "name": "local",
        "ok": True,
        "secretConfigured": False,
    }

    assert main(["--home", str(home), "provider", "list", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed["providers"][0]["name"] == "local"

    assert main(["--home", str(home), "provider", "test", "local", "--json"]) == 2
    denied = json.loads(capsys.readouterr().out)
    assert "Network probe denied" in denied["error"]


def test_cli_agent_requires_stdin_and_explicit_network_opt_in(
    tmp_path: Path,
    capsys: object,
    monkeypatch: object,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    capsys.readouterr()
    assert (
        main(
            [
                "--home",
                str(home),
                "provider",
                "configure",
                "local",
                "--kind",
                "ollama",
                "--model",
                "qwen",
                "--json",
            ]
        )
        == 0
    )
    capsys.readouterr()

    assert (
        main(
            [
                "--home",
                str(home),
                "agent",
                "run",
                str(workspace),
                "--provider",
                "local",
                "--json",
            ]
        )
        == 2
    )
    missing_stdin = json.loads(capsys.readouterr().out)
    assert "--prompt-stdin" in missing_stdin["error"]

    monkeypatch.setattr("sys.stdin", io.StringIO("content stays on stdin"))
    assert (
        main(
            [
                "--home",
                str(home),
                "agent",
                "run",
                str(workspace),
                "--provider",
                "local",
                "--prompt-stdin",
                "--json",
            ]
        )
        == 2
    )
    denied = json.loads(capsys.readouterr().out)
    assert "Model execution denied" in denied["error"]


def test_cli_doctor_reports_headless_keyring_without_blocking_runtime(
    tmp_path: Path,
    capsys: object,
    monkeypatch: object,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert main(["--home", str(home), "init", str(workspace), "--json"]) == 0
    capsys.readouterr()

    def unavailable_keyring(_self: object) -> None:
        raise SecretStoreUnavailable("No desktop keyring is available.")

    monkeypatch.setattr(
        "fikeya_runtime.cli.OSKeyringSecretStore._keyring",
        unavailable_keyring,
    )

    assert main(["--home", str(home), "doctor", str(workspace), "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    keyring_check = next(
        check for check in report["checks"] if check["name"] == "os-keyring"
    )
    assert report["ok"] is True
    assert keyring_check == {
        "detail": "No desktop keyring is available.",
        "name": "os-keyring",
        "ok": False,
        "optional": True,
    }
