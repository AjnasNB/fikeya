# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Workspace-bound host for the optional decision-only Deep Agents adapter."""

from __future__ import annotations

from dataclasses import dataclass

from fikeya_agent_core import (
    AgentLimits,
    CheckpointStore,
    DeepAgentsCompatibilityAdapter,
    DeepAgentsGraph,
    DeepAgentsIntegrationDiagnostic,
    SqliteCheckpointStore,
    deep_agents_diagnostic,
)

from .coding import WorkspaceExecutionBroker
from .modes import AgentMode
from .workspace import Workspace


@dataclass(frozen=True, slots=True)
class DeepAgentsRuntimeDiagnostic:
    """Honest boundary report for one constructed workspace host."""

    core: DeepAgentsIntegrationDiagnostic
    checkpoint_store: str
    graph_source: str
    model_source: str
    tool_execution: str

    def as_json(self) -> dict[str, object]:
        """Return a content-free status object suitable for doctor output."""

        return {
            "checkpointStore": self.checkpoint_store,
            "core": self.core.as_json(),
            "endToEnd": [
                "graph decision decoding",
                "workspace tool validation",
                "durable exact approval",
                "brokered execution",
                "review checkpoint",
            ],
            "graphSource": self.graph_source,
            "hostSupplied": ["graph", "model", "provider credentials"],
            "modelSource": self.model_source,
            "toolExecution": self.tool_execution,
        }


class DeepAgentsWorkspaceHost:
    """Own a graph adapter and the only broker allowed to touch a workspace."""

    def __init__(
        self,
        adapter: DeepAgentsCompatibilityAdapter,
        broker: WorkspaceExecutionBroker,
        diagnostic: DeepAgentsRuntimeDiagnostic,
    ) -> None:
        self.adapter = adapter
        self.broker = broker
        self.diagnostic = diagnostic
        self._closed = False

    def close(self) -> None:
        """Close browser/process resources owned by the workspace broker."""

        if not self._closed:
            self.broker.close()
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        del exc_type, exc_value, traceback
        self.close()


def create_deep_agents_workspace_host(
    graph: DeepAgentsGraph,
    workspace: Workspace,
    *,
    checkpoints: CheckpointStore | None = None,
    limits: AgentLimits | None = None,
    mode: AgentMode | str = AgentMode.BUILD,
    allowed_executables: frozenset[str] | None = None,
    maximum_process_timeout_seconds: float = 120.0,
    allow_private_browser: bool = False,
    provider_name: str = "deep-agents",
    model_name: str = "host-configured",
) -> DeepAgentsWorkspaceHost:
    """Bind a host-supplied decision graph to Fikeya's real workspace broker.

    The graph is never given the broker or callable tools. The default
    checkpoint store is the initialized workspace SQLite database, where Agent
    Core uses its own ``agent_checkpoints`` table.
    """

    broker_options: dict[str, object] = {
        "allow_private_browser": allow_private_browser,
        "maximum_process_timeout_seconds": maximum_process_timeout_seconds,
        "mode": mode,
    }
    if allowed_executables is not None:
        broker_options["allowed_executables"] = allowed_executables
    broker = WorkspaceExecutionBroker(workspace, **broker_options)
    checkpoint_store = checkpoints or SqliteCheckpointStore(workspace.state_path)
    try:
        adapter = DeepAgentsCompatibilityAdapter(
            graph,
            broker,
            checkpoint_store,
            limits,
            provider_name=provider_name,
            model_name=model_name,
        )
    except Exception:
        broker.close()
        raise

    sample_only = bool(getattr(graph, "sample_only", False))
    diagnostic = DeepAgentsRuntimeDiagnostic(
        core=deep_agents_diagnostic(graph),
        checkpoint_store=(
            "workspace-sqlite" if isinstance(checkpoint_store, SqliteCheckpointStore) else "host-supplied"
        ),
        graph_source="deterministic-sample" if sample_only else "host-supplied-unverified",
        model_source="none" if sample_only else "host-supplied-unverified",
        tool_execution="fikeya-workspace-broker-only",
    )
    return DeepAgentsWorkspaceHost(adapter, broker, diagnostic)
