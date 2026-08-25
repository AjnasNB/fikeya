# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Injected ports that keep providers and execution outside the core."""

from __future__ import annotations

from typing import Protocol

from .cancellation import CancellationToken
from .models import ProviderRequest, ProviderResult, ToolCall, ToolDefinition, ToolResult


class Provider(Protocol):
    """Generate one structured orchestration decision."""

    async def complete(self, request: ProviderRequest, cancellation: CancellationToken) -> ProviderResult: ...


class ExecutionBroker(Protocol):
    """Describe and execute tools through a separately secured implementation."""

    async def list_tools(self, cancellation: CancellationToken) -> tuple[ToolDefinition, ...]: ...

    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        """Execute exactly once per stable idempotency key, returning a cached result on duplicates."""
