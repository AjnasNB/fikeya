from __future__ import annotations

import asyncio
import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from mcp import types as mcp_types

from fikeya_interop import (
    MemoryReceiptSink,
    PathPolicy,
    PermissionDeniedError,
    ProcessPolicy,
    ProcessSpec,
    ResourceLimits,
    ToolPolicy,
)
from fikeya_interop.errors import ProtocolError
from fikeya_interop.mcp_client import McpToolAdapter


class FakeMcpClient:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def list_tools(self, *, cursor: str | None = None, **kwargs: object) -> mcp_types.ListToolsResult:
        del kwargs
        self.calls.append(f"list:{cursor}")
        if cursor is None:
            return mcp_types.ListToolsResult(
                tools=[
                    mcp_types.Tool(
                        name="read_file",
                        title="Read file",
                        description="Read a bounded fixture",
                        input_schema={"type": "object"},
                        annotations=mcp_types.ToolAnnotations(read_only_hint=True),
                    ),
                    mcp_types.Tool(
                        name="hidden_admin",
                        input_schema={"type": "object"},
                        annotations=mcp_types.ToolAnnotations(destructive_hint=True),
                    ),
                ],
                next_cursor="page-2",
            )
        return mcp_types.ListToolsResult(
            tools=[
                mcp_types.Tool(
                    name="write_file",
                    title="Write file",
                    input_schema={"type": "object"},
                    annotations=mcp_types.ToolAnnotations(read_only_hint=False, destructive_hint=True),
                )
            ]
        )

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, object] | None = None,
        **kwargs: object,
    ) -> mcp_types.CallToolResult:
        del arguments, kwargs
        self.calls.append(f"call:{name}")
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(text="private-output-" * 40)],
            structured_content={"private": "structured-output"},
            is_error=False,
        )


class FakeMcpFactory:
    def __init__(self, client: FakeMcpClient) -> None:
        self.client = client

    @asynccontextmanager
    async def connect(self, spec: ProcessSpec, process_policy: ProcessPolicy, limits: ResourceLimits):
        del limits
        process_policy.validate(spec)
        yield self.client


def policy(workspace: Path) -> ProcessPolicy:
    return ProcessPolicy(
        root=PathPolicy(workspace),
        allowed_commands=frozenset({Path(sys.executable).name}),
    )


@pytest.mark.asyncio
async def test_mcp_adapter_filters_discovery_bounds_output_and_keeps_content_free_receipts(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    client = FakeMcpClient()
    receipts = MemoryReceiptSink()
    spec = ProcessSpec("workspace", sys.executable, cwd=workspace)

    async with McpToolAdapter(
        spec,
        policy(workspace),
        ToolPolicy(("workspace/read_file", "workspace/write_file")),
        ResourceLimits(max_output_bytes=64),
        receipts,
        connection_factory=FakeMcpFactory(client),
    ) as adapter:
        tools = await adapter.discover_tools()
        result = await adapter.call_tool("read_file", {"path": "notes.txt"})

    assert [tool.name for tool in tools] == ["read_file", "write_file"]
    assert result.truncated is True
    assert len(result.blocks[0].data.encode("utf-8")) <= 64
    assert result.structured_content is None
    receipt_json = json.dumps(receipts.as_dicts())
    assert "private-output" not in receipt_json
    assert "structured-output" not in receipt_json
    assert client.calls == ["list:None", "list:page-2", "call:read_file"]


@pytest.mark.asyncio
async def test_mcp_adapter_denies_side_effecting_tools_without_host_approval(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    client = FakeMcpClient()
    spec = ProcessSpec("workspace", sys.executable, cwd=workspace)

    async with McpToolAdapter(
        spec,
        policy(workspace),
        ToolPolicy(("workspace/*",)),
        ResourceLimits(),
        MemoryReceiptSink(),
        connection_factory=FakeMcpFactory(client),
    ) as adapter:
        await adapter.discover_tools()
        with pytest.raises(PermissionDeniedError, match="not approved"):
            await adapter.call_tool("write_file")


class RepeatingCursorClient(FakeMcpClient):
    async def list_tools(self, *, cursor: str | None = None, **kwargs: object) -> mcp_types.ListToolsResult:
        del cursor, kwargs
        return mcp_types.ListToolsResult(tools=[], next_cursor="same")


@pytest.mark.asyncio
async def test_mcp_adapter_rejects_repeated_pagination_cursors(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    spec = ProcessSpec("workspace", sys.executable, cwd=workspace)

    async with McpToolAdapter(
        spec,
        policy(workspace),
        ToolPolicy(("workspace/*",)),
        ResourceLimits(),
        MemoryReceiptSink(),
        connection_factory=FakeMcpFactory(RepeatingCursorClient()),
    ) as adapter:
        with pytest.raises(ProtocolError, match="repeated"):
            await adapter.discover_tools()


class BlockingMcpClient(FakeMcpClient):
    async def call_tool(
        self,
        name: str,
        arguments: dict[str, object] | None = None,
        **kwargs: object,
    ) -> mcp_types.CallToolResult:
        del name, arguments, kwargs
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


@pytest.mark.asyncio
async def test_mcp_tool_calls_are_cancellable(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    client = BlockingMcpClient()
    receipts = MemoryReceiptSink()
    spec = ProcessSpec("workspace", sys.executable, cwd=workspace)

    async with McpToolAdapter(
        spec,
        policy(workspace),
        ToolPolicy(("workspace/read_file",)),
        ResourceLimits(),
        receipts,
        connection_factory=FakeMcpFactory(client),
    ) as adapter:
        await adapter.discover_tools()
        task = asyncio.create_task(adapter.call_tool("read_file"))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert receipts.snapshot()[-1].status == "cancelled"
