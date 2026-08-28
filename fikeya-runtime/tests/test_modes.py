# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import pytest

from fikeya_runtime.errors import ConfigurationError
from fikeya_runtime.modes import AgentMode, mode_policy


@pytest.mark.parametrize("mode", list(AgentMode))
def test_every_public_mode_has_a_matching_policy(mode: AgentMode) -> None:
    policy = mode_policy(mode.value)
    assert policy.mode is mode
    assert policy.summary.endswith(".")
    assert policy.tools


def test_only_build_mode_can_modify_workspace_files() -> None:
    for mode in AgentMode:
        policy = mode_policy(mode)
        assert policy.allows("workspace.write_file") is (mode is AgentMode.BUILD)
        assert policy.allows("workspace.replace_text") is (mode is AgentMode.BUILD)
        assert policy.may_mutate_workspace is (mode is AgentMode.BUILD)


def test_process_and_browser_access_are_explicit() -> None:
    assert mode_policy(AgentMode.BUILD).allows("process.run")
    assert not mode_policy(AgentMode.REVIEW).allows("process.run")
    assert not mode_policy(AgentMode.ASK).allows("process.run")
    assert mode_policy(AgentMode.RESEARCH).allows("browser.snapshot")
    assert not mode_policy(AgentMode.RESEARCH).allows("browser.screenshot")
    assert mode_policy(AgentMode.BUILD).allows("browser.screenshot")
    assert not mode_policy(AgentMode.PLAN).allows("browser.snapshot")


def test_unknown_mode_fails_closed() -> None:
    with pytest.raises(ConfigurationError, match="Unsupported Fikeya agent mode"):
        mode_policy("unbounded")
