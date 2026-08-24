"""MCP tool client backed by the official Python SDK."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import asdict
from typing import Any, Protocol

from mcp import Client, StdioServerParameters
from mcp.client.stdio import stdio_client

from .errors import LimitExceededError, PermissionDeniedError, ProtocolError
from .models import (
    ContentBlock,
    NormalizedToolResult,
    PermissionDecision,
    PermissionRequest,
    PermissionResolution,
    ProcessSpec,
    ResourceLimits,
    ToolDescriptor,
)
from .policy import ProcessPolicy, ToolPolicy
from .receipts import ReceiptSink, build_receipt, canonical_bytes

PermissionResolver = Callable[[PermissionRequest], Awaitable[PermissionResolution]]


async def _deny_permission(request: PermissionRequest) -> PermissionResolution:
    del request
    return PermissionResolution(PermissionDecision.DENY_ONCE)


class McpClientPort(Protocol):
    """The official MCP operations used by Fikeya."""

    async def list_tools(self, *, cursor: str | None = None, **kwargs: Any) -> Any: ...

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None, **kwargs: Any) -> Any: ...


class McpConnectionFactory(Protocol):
    """Injectable factory for deterministic MCP tests."""

    def connect(
        self,
        spec: ProcessSpec,
        process_policy: ProcessPolicy,
        limits: ResourceLimits,
    ) -> AbstractAsyncContextManager[McpClientPort]: ...


class OfficialMcpConnectionFactory:
    """Connect to a local MCP server through the official v2 stdio client."""

    @asynccontextmanager
    async def connect(
        self,
        spec: ProcessSpec,
        process_policy: ProcessPolicy,
        limits: ResourceLimits,
    ):
        validated = process_policy.validate(spec)
        parameters = StdioServerParameters(
            command=validated.command,
            args=list(validated.args),
            env=process_policy.build_environment(spec),
            cwd=validated.cwd,
        )
        transport = stdio_client(parameters)
        async with Client(transport, read_timeout_seconds=limits.request_timeout_seconds) as client:
            yield client


class McpToolAdapter:
    """Normalize discovery and tool calls across local MCP servers."""

    protocol = "mcp"

    def __init__(
        self,
        spec: ProcessSpec,
        process_policy: ProcessPolicy,
        tool_policy: ToolPolicy,
        limits: ResourceLimits,
        receipts: ReceiptSink,
        *,
        permission_resolver: PermissionResolver = _deny_permission,
        connection_factory: McpConnectionFactory | None = None,
    ) -> None:
        self._spec = spec
        self._process_policy = process_policy
        self._tool_policy = tool_policy
        self._limits = limits
        self._receipts = receipts
        self._permission_resolver = permission_resolver
        self._factory = connection_factory or OfficialMcpConnectionFactory()
        self._connection_context: AbstractAsyncContextManager[McpClientPort] | None = None
        self._client: McpClientPort | None = None
        self._tools: dict[str, ToolDescriptor] = {}

    async def __aenter__(self) -> McpToolAdapter:
        self._connection_context = self._factory.connect(
            self._spec,
            self._process_policy,
            self._limits,
        )
        self._client = await self._connection_context.__aenter__()
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self._connection_context is not None:
            await self._connection_context.__aexit__(exc_type, exc, traceback)
        self._connection_context = None
        self._client = None

    async def discover_tools(self) -> tuple[ToolDescriptor, ...]:
        client = self._require_client()
        started_ns = time.monotonic_ns()
        cursor: str | None = None
        seen_cursors: set[str] = set()
        seen_names: set[str] = set()
        discovered_count = 0
        descriptors: list[ToolDescriptor] = []
        status = "ok"
        try:
            while True:
                response = await asyncio.wait_for(
                    client.list_tools(cursor=cursor),
                    timeout=self._limits.request_timeout_seconds,
                )
                for tool in response.tools:
                    discovered_count += 1
                    if discovered_count > self._limits.max_tool_count:
                        raise LimitExceededError("MCP tool discovery exceeds the configured count")
                    name = str(tool.name)
                    if len(name.encode("utf-8")) > self._limits.max_tool_name_bytes:
                        raise LimitExceededError("MCP tool name exceeds the configured limit")
                    if name in seen_names:
                        raise ProtocolError(f"MCP server returned a duplicate tool name: {name}")
                    seen_names.add(name)
                    metadata = {
                        "name": name,
                        "title": tool.title,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                    }
                    if len(canonical_bytes(metadata)) > self._limits.max_message_bytes:
                        raise LimitExceededError("MCP tool metadata exceeds the configured limit")
                    if not self._tool_policy.allows(self._spec.identifier, name):
                        continue
                    annotations = tool.annotations
                    descriptor = ToolDescriptor(
                        server_id=self._spec.identifier,
                        name=name,
                        title=tool.title,
                        description=tool.description,
                        input_schema=tool.input_schema,
                        destructive=bool(annotations and annotations.destructive_hint),
                        read_only=bool(annotations and annotations.read_only_hint),
                    )
                    descriptors.append(descriptor)
                next_cursor = response.next_cursor
                if not next_cursor:
                    break
                if next_cursor in seen_cursors:
                    raise ProtocolError("MCP server repeated a pagination cursor")
                seen_cursors.add(next_cursor)
                cursor = next_cursor
            self._tools = {descriptor.name: descriptor for descriptor in descriptors}
            return tuple(descriptors)
        except Exception as error:
            status = type(error).__name__
            raise
        finally:
            self._receipts.record(
                build_receipt(
                    protocol=self.protocol,
                    peer_id=self._spec.identifier,
                    operation="tools/list",
                    started_ns=started_ns,
                    input_value={"allowlistCount": len(self._tool_policy.allowlist)},
                    output_value={"toolCount": len(descriptors)},
                    status=status,
                )
            )

    async def call_tool(self, name: str, arguments: Mapping[str, Any] | None = None) -> NormalizedToolResult:
        client = self._require_client()
        self._tool_policy.require(self._spec.identifier, name)
        descriptor = self._tools.get(name)
        if descriptor is None:
            raise ProtocolError("discover_tools must be called before call_tool")
        if not descriptor.read_only:
            resolution = await self._permission_resolver(
                PermissionRequest(
                    request_id=f"mcp-{self._spec.identifier}-{name}",
                    session_id=self._spec.identifier,
                    operation="mcp_tool_call",
                    title=f"Run {self._spec.identifier}/{name}",
                    reason="The MCP server did not mark this tool as read-only.",
                    cwd=self._process_policy.root.root,
                )
            )
            if resolution.decision not in {PermissionDecision.ALLOW_ONCE, PermissionDecision.ALLOW_SESSION}:
                raise PermissionDeniedError("MCP tool call was not approved")
        values = dict(arguments or {})
        if len(canonical_bytes(values)) > self._limits.max_message_bytes:
            raise LimitExceededError("MCP tool arguments exceed the configured limit")

        started_ns = time.monotonic_ns()
        status = "ok"
        normalized: NormalizedToolResult | None = None
        try:
            response = await asyncio.wait_for(
                client.call_tool(
                    name,
                    values,
                    read_timeout_seconds=self._limits.request_timeout_seconds,
                ),
                timeout=self._limits.request_timeout_seconds,
            )
            normalized = _normalize_tool_result(response, self._limits)
            status = "error" if normalized.is_error else "ok"
            return normalized
        except asyncio.TimeoutError as error:
            status = "timeout"
            raise ProtocolError(f"MCP tool call timed out: {name}") from error
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception as error:
            status = type(error).__name__
            raise
        finally:
            output_value = asdict(normalized) if normalized is not None else {"status": status}
            self._receipts.record(
                build_receipt(
                    protocol=self.protocol,
                    peer_id=self._spec.identifier,
                    operation=f"tools/call:{name}",
                    started_ns=started_ns,
                    input_value=values,
                    output_value=output_value,
                    status=status,
                    truncated=bool(normalized and normalized.truncated),
                )
            )

    def _require_client(self) -> McpClientPort:
        if self._client is None:
            raise ProtocolError("MCP adapter is not connected")
        return self._client


def _normalize_tool_result(response: Any, limits: ResourceLimits) -> NormalizedToolResult:
    blocks: list[ContentBlock] = []
    used = 0
    truncated = False
    for item in response.content:
        if len(blocks) >= limits.max_tool_count:
            raise LimitExceededError("MCP tool result contains too many content blocks")
        kind = str(getattr(item, "type", "unknown"))
        if kind == "text":
            block, consumed = _bounded_block("text", item.text, limits.max_output_bytes - used)
        elif kind in {"image", "audio"}:
            block, consumed = _bounded_block(
                kind,
                item.data,
                limits.max_output_bytes - used,
                mime_type=item.mime_type,
            )
        elif kind == "resource_link":
            block, consumed = _bounded_block(
                kind,
                item.name,
                limits.max_output_bytes - used,
                mime_type=item.mime_type,
                uri=str(item.uri),
            )
        elif kind == "resource":
            resource = item.resource
            data = resource.text if hasattr(resource, "text") else resource.blob
            if len(data.encode("utf-8")) > limits.max_resource_bytes:
                data = data.encode("utf-8")[: limits.max_resource_bytes].decode("utf-8", errors="ignore")
                truncated = True
            block, consumed = _bounded_block(
                kind,
                data,
                limits.max_output_bytes - used,
                mime_type=resource.mime_type,
                uri=str(resource.uri),
            )
        else:
            raise ProtocolError(f"unsupported MCP content block: {kind}")
        blocks.append(block)
        used += consumed
        truncated = truncated or block.truncated
        if used >= limits.max_output_bytes:
            truncated = True
            break

    structured = response.structured_content
    if structured is not None:
        remaining = limits.max_output_bytes - used
        encoded = canonical_bytes(structured)
        if len(encoded) > remaining:
            structured = None
            truncated = True
    return NormalizedToolResult(
        blocks=tuple(blocks),
        structured_content=structured,
        is_error=bool(response.is_error),
        truncated=truncated,
    )


def _bounded_block(
    kind: str,
    data: str,
    remaining: int,
    *,
    mime_type: str | None = None,
    uri: str | None = None,
) -> tuple[ContentBlock, int]:
    payload = data.encode("utf-8")
    if remaining <= 0:
        return ContentBlock(kind=kind, data="", mime_type=mime_type, uri=uri, truncated=True), 0
    truncated = len(payload) > remaining
    bounded = payload[:remaining].decode("utf-8", errors="ignore") if truncated else data
    consumed = len(bounded.encode("utf-8"))
    return (
        ContentBlock(
            kind=kind,
            data=bounded,
            mime_type=mime_type,
            uri=uri,
            truncated=truncated,
        ),
        consumed,
    )
