# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Mechanical tool boundaries for Fikeya's user-visible agent modes."""

from __future__ import annotations

import enum
from dataclasses import dataclass

from .errors import ConfigurationError


class AgentMode(str, enum.Enum):
    """Stable mode identifiers shared by the CLI, Desktop, and runtime."""

    ASK = "ask"
    PLAN = "plan"
    BUILD = "build"
    REVIEW = "review"
    RESEARCH = "research"


_WORKSPACE_READ_TOOLS = frozenset(
    {
        "workspace.list_files",
        "workspace.read_file",
        "workspace.search_text",
    }
)
_WORKSPACE_WRITE_TOOLS = frozenset(
    {
        "workspace.replace_text",
        "workspace.write_file",
    }
)
_BROWSER_READ_TOOLS = frozenset(
    {
        "browser.navigate",
        "browser.snapshot",
        "browser.scroll",
        "browser.screenshot",
        "browser.wait",
        "browser.close",
    }
)
_BROWSER_INTERACTION_TOOLS = frozenset(
    {
        "browser.click",
        "browser.type",
    }
)


@dataclass(frozen=True, slots=True)
class ModePolicy:
    """A deny-by-default capability set for one agent mode."""

    mode: AgentMode
    summary: str
    tools: frozenset[str]
    may_mutate_workspace: bool
    may_run_processes: bool
    may_interact_with_web_pages: bool

    def allows(self, tool_name: str) -> bool:
        return tool_name in self.tools


MODE_POLICIES: dict[AgentMode, ModePolicy] = {
    AgentMode.ASK: ModePolicy(
        mode=AgentMode.ASK,
        summary="Answer from project evidence without changing files or running processes.",
        tools=_WORKSPACE_READ_TOOLS,
        may_mutate_workspace=False,
        may_run_processes=False,
        may_interact_with_web_pages=False,
    ),
    AgentMode.PLAN: ModePolicy(
        mode=AgentMode.PLAN,
        summary="Inspect the project and produce an audited plan without execution.",
        tools=_WORKSPACE_READ_TOOLS,
        may_mutate_workspace=False,
        may_run_processes=False,
        may_interact_with_web_pages=False,
    ),
    AgentMode.BUILD: ModePolicy(
        mode=AgentMode.BUILD,
        summary="Build, test, and verify through exact one-use approvals.",
        tools=(
            _WORKSPACE_READ_TOOLS
            | _WORKSPACE_WRITE_TOOLS
            | _BROWSER_READ_TOOLS
            | _BROWSER_INTERACTION_TOOLS
            | {"process.run"}
        ),
        may_mutate_workspace=True,
        may_run_processes=True,
        may_interact_with_web_pages=True,
    ),
    AgentMode.REVIEW: ModePolicy(
        mode=AgentMode.REVIEW,
        summary="Audit code and run approved checks without editing project files.",
        tools=_WORKSPACE_READ_TOOLS | {"process.run"},
        may_mutate_workspace=False,
        may_run_processes=True,
        may_interact_with_web_pages=False,
    ),
    AgentMode.RESEARCH: ModePolicy(
        mode=AgentMode.RESEARCH,
        summary="Inspect project and web evidence without editing project files.",
        tools=(
            _WORKSPACE_READ_TOOLS
            | _BROWSER_READ_TOOLS
            | _BROWSER_INTERACTION_TOOLS
        ),
        may_mutate_workspace=False,
        may_run_processes=False,
        may_interact_with_web_pages=True,
    ),
}


def mode_policy(value: AgentMode | str) -> ModePolicy:
    """Return a validated, deny-by-default policy for a public mode value."""

    try:
        mode = value if isinstance(value, AgentMode) else AgentMode(value)
    except (TypeError, ValueError) as error:
        raise ConfigurationError(f"Unsupported Fikeya agent mode: {value!r}.") from error
    return MODE_POLICIES[mode]

