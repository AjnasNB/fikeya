# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import socket
import sys
from pathlib import Path

import pytest


_AGENT_CORE_SOURCE = Path(__file__).resolve().parents[2] / "fikeya-agent-core" / "src"
if _AGENT_CORE_SOURCE.is_dir():
    sys.path.insert(0, str(_AGENT_CORE_SOURCE))


@pytest.fixture(autouse=True)
def deny_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make accidental network access fail every runtime test."""

    def denied(*arguments: object, **keyword_arguments: object) -> None:
        del arguments, keyword_arguments
        raise AssertionError("Tests must not open network connections.")

    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
