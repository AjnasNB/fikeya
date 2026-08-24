# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import socket

import pytest


@pytest.fixture(autouse=True)
def deny_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make accidental network access fail every runtime test."""

    def denied(*arguments: object, **keyword_arguments: object) -> None:
        del arguments, keyword_arguments
        raise AssertionError("Tests must not open network connections.")

    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
