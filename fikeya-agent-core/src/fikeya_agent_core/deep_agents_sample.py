# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Deterministic, dependency-free host used to verify the optional adapter.

This module is a sample and test fixture. It is not a model, planner, or a
replacement for a host-supplied Deep Agents/LangGraph graph. It deliberately
has no tools and can only replay caller-provided structured decisions.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Iterable
from pathlib import PurePosixPath, PureWindowsPath

from .errors import ConfigurationError, ProtocolError
from .models import JsonValue, canonical_json, strict_json_loads


class DeterministicDecisionGraph:
    """Replay strict JSON decisions through the same async graph boundary."""

    sample_only = True

    def __init__(self, decisions: Iterable[dict[str, JsonValue]]) -> None:
        copied = tuple(_json_object(decision, "sample decision") for decision in decisions)
        if not copied:
            raise ConfigurationError("deterministic sample graph requires at least one decision")
        self._decisions = deque(copied)
        self._lock = asyncio.Lock()
        self.inputs: list[dict[str, JsonValue]] = []
        self.configs: list[dict[str, JsonValue]] = []

    @property
    def remaining(self) -> int:
        """Return the number of sample decisions that have not been replayed."""

        return len(self._decisions)

    async def ainvoke(
        self,
        input: dict[str, JsonValue],
        config: dict[str, object],
    ) -> dict[str, JsonValue]:
        """Return exactly one copied decision and record only strict JSON inputs."""

        graph_input = _json_object(input, "graph input")
        graph_config = _json_object(config, "graph config")
        async with self._lock:
            if not self._decisions:
                raise ProtocolError("deterministic sample graph has no decision remaining")
            self.inputs.append(graph_input)
            self.configs.append(graph_config)
            return {"fikeya_decision": self._decisions.popleft()}


def deterministic_read_sample_graph(path: str = "README.md") -> DeterministicDecisionGraph:
    """Create a plan/read/review sequence for public integration diagnostics."""

    if (
        not path
        or PurePosixPath(path).is_absolute()
        or PureWindowsPath(path).is_absolute()
        or ".." in path.replace("\\", "/").split("/")
    ):
        raise ConfigurationError("sample path must be a non-empty project-relative path")
    return DeterministicDecisionGraph(
        (
            {
                "kind": "plan",
                "content": "Read one project file through Fikeya, then review the broker receipt.",
            },
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {"path": path},
                    "callId": "call:deep-agents-sample-read",
                    "name": "workspace.read_file",
                },
            },
            {
                "kind": "review",
                "content": "The deterministic brokered read completed.",
                "reviewAction": "complete",
            },
        )
    )


def _json_object(value: object, label: str) -> dict[str, JsonValue]:
    try:
        decoded = strict_json_loads(canonical_json(value))
    except (TypeError, ValueError) as error:
        raise ProtocolError(f"{label} must be strict JSON") from error
    if not isinstance(decoded, dict) or any(not isinstance(key, str) for key in decoded):
        raise ProtocolError(f"{label} must be a JSON object")
    return decoded
