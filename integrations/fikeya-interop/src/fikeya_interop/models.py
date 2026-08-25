"""Fikeya-owned protocol-neutral interoperability models."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class ProcessSpec:
    """A shell-free stdio child process specification."""

    identifier: str
    command: str
    args: tuple[str, ...] = ()
    cwd: Path | None = None
    environment: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ResourceLimits:
    """Limits applied before untrusted peer data enters Fikeya."""

    max_message_bytes: int = 1_048_576
    max_output_bytes: int = 1_048_576
    max_resource_bytes: int = 1_048_576
    max_tool_count: int = 256
    max_tool_name_bytes: int = 256
    request_timeout_seconds: float = 120.0

    def __post_init__(self) -> None:
        values = (
            self.max_message_bytes,
            self.max_output_bytes,
            self.max_resource_bytes,
            self.max_tool_count,
            self.max_tool_name_bytes,
            self.request_timeout_seconds,
        )
        if any(value <= 0 for value in values):
            raise ValueError("resource limits must be positive")


@dataclass(frozen=True, slots=True)
class AgentCapabilities:
    """Capabilities normalized from ACP or another agent protocol."""

    protocol: str
    protocol_version: str
    start_session: bool = True
    resume_session: bool = False
    fork_session: bool = False
    cancel: bool = True
    permission_requests: bool = False
    mcp_http: bool = False
    mcp_sse: bool = False
    mcp_stdio: bool = False
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True, slots=True)
class SessionRef:
    """A protocol-neutral reference to a live or persisted agent session."""

    session_id: str
    protocol: str
    parent_session_id: str | None = None


class PermissionDecision(str, Enum):
    """Decisions that can be represented across ACP and app-server."""

    ALLOW_ONCE = "allow_once"
    ALLOW_SESSION = "allow_session"
    DENY_ONCE = "deny_once"
    DENY_SESSION = "deny_session"
    CANCEL = "cancel"


@dataclass(frozen=True, slots=True)
class PermissionRequest:
    """A bounded permission prompt; command output and file contents are excluded."""

    request_id: str
    session_id: str
    operation: str
    title: str
    reason: str | None = None
    cwd: Path | None = None
    choices: tuple[PermissionDecision, ...] = (
        PermissionDecision.ALLOW_ONCE,
        PermissionDecision.DENY_ONCE,
        PermissionDecision.CANCEL,
    )


@dataclass(frozen=True, slots=True)
class PermissionResolution:
    """A host decision plus an optional requested-permission subset."""

    decision: PermissionDecision
    granted_permissions: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ToolDescriptor:
    """A normalized MCP tool definition."""

    server_id: str
    name: str
    title: str | None
    description: str | None
    input_schema: Mapping[str, Any]
    destructive: bool
    read_only: bool


@dataclass(frozen=True, slots=True)
class ContentBlock:
    """A normalized, bounded MCP content block returned to the active caller."""

    kind: str
    data: str
    mime_type: str | None = None
    uri: str | None = None
    truncated: bool = False


@dataclass(frozen=True, slots=True)
class NormalizedToolResult:
    """An MCP result normalized independently of SDK-specific Pydantic models."""

    blocks: tuple[ContentBlock, ...]
    structured_content: Any = None
    is_error: bool = False
    truncated: bool = False


@dataclass(frozen=True, slots=True)
class InteropReceipt:
    """Content-free evidence for one external operation."""

    receipt_id: str
    protocol: str
    peer_id: str
    operation: str
    started_at: str
    duration_ms: int
    status: str
    input_digest: str
    output_digest: str
    input_bytes: int
    output_bytes: int
    truncated: bool = False
