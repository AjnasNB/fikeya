# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import sys

import pytest

import fikeya_agent_core
from fikeya_agent_core import (
    ConfigurationError,
    DeepAgentsCompatibilityAdapter,
    DeepAgentsProviderAdapter,
    DeterministicDecisionGraph,
    deep_agents_diagnostic,
    deterministic_read_sample_graph,
    require_deep_agents_dependencies,
)


def test_optional_integration_is_exported_from_the_supported_package_surface() -> None:
    expected = {
        "DeepAgentsCompatibilityAdapter",
        "DeepAgentsProviderAdapter",
        "DeterministicDecisionGraph",
        "deep_agents_dependency_status",
        "deep_agents_diagnostic",
        "deterministic_read_sample_graph",
        "require_deep_agents_dependencies",
    }

    assert expected <= set(fikeya_agent_core.__all__)
    assert DeepAgentsCompatibilityAdapter is not None
    assert DeepAgentsProviderAdapter is not None


def test_diagnostic_reports_graph_compatibility_without_importing_optional_packages() -> None:
    graph = deterministic_read_sample_graph("src/example.py")

    diagnostic = deep_agents_diagnostic(graph)
    payload = diagnostic.as_json()

    assert diagnostic.graph_compatible is True
    assert diagnostic.graph_supplied is True
    assert diagnostic.install_extra == "fikeya-agent-core[deep-agents]"
    assert payload["adapterApiVersion"] == 1
    assert payload["toolBoundary"] == "fikeya-propose-only"
    assert payload["dependencies"]["pythonSupported"] is (sys.version_info >= (3, 11))  # type: ignore[index]


@pytest.mark.asyncio
async def test_deterministic_sample_is_strict_repeatable_and_has_no_model_or_tools() -> None:
    graph = deterministic_read_sample_graph("README.md")
    config = {
        "configurable": {"thread_id": "sample", "checkpoint_ns": "provider/plan"},
        "metadata": {"fikeya_tool_boundary": "propose-only"},
    }
    graph_input = {"messages": [], "fikeya": {"stage": "plan"}}

    plan = await graph.ainvoke(graph_input, config)
    tool = await graph.ainvoke(graph_input, config)
    review = await graph.ainvoke(graph_input, config)

    assert plan["fikeya_decision"]["kind"] == "plan"  # type: ignore[index]
    assert tool["fikeya_decision"]["toolCall"]["name"] == "workspace.read_file"  # type: ignore[index]
    assert review["fikeya_decision"]["reviewAction"] == "complete"  # type: ignore[index]
    assert graph.remaining == 0
    assert graph.sample_only is True
    assert not hasattr(graph, "model")
    assert not hasattr(graph, "tools")


def test_sample_rejects_absolute_and_parent_traversal_paths() -> None:
    for path in ("", "../secret.txt", "/etc/passwd", "C:\\secret.txt"):
        with pytest.raises(ConfigurationError):
            deterministic_read_sample_graph(path)


def test_deterministic_graph_rejects_an_empty_script() -> None:
    with pytest.raises(ConfigurationError, match="at least one decision"):
        DeterministicDecisionGraph(())


def test_dependency_gate_explains_python_310_without_breaking_native_core(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("fikeya_agent_core.deep_agents.sys.version_info", (3, 10))

    with pytest.raises(ConfigurationError, match="requires Python 3.11"):
        require_deep_agents_dependencies()
