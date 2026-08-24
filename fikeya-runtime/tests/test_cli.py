# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
from pathlib import Path

from fikeya_runtime.cli import main


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
