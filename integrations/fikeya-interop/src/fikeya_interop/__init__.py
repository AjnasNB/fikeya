"""Bounded interoperability ports for Fikeya."""

from .acp import AcpAgentAdapter, FikeyaAcpHost
from .codex import CodexAppServerAdapter, codex_process_spec
from .errors import InteropError, LimitExceededError, PermissionDeniedError, ProtocolError
from .manifest import InteropManifest, load_manifest
from .mcp_client import McpToolAdapter
from .models import (
    AgentCapabilities,
    ContentBlock,
    InteropReceipt,
    NormalizedToolResult,
    PermissionDecision,
    PermissionRequest,
    PermissionResolution,
    ProcessSpec,
    ResourceLimits,
    SessionRef,
    ToolDescriptor,
)
from .policy import PathPolicy, ProcessPolicy, ToolPolicy
from .receipts import MemoryReceiptSink, canonical_digest

__all__ = [
    "AcpAgentAdapter",
    "AgentCapabilities",
    "CodexAppServerAdapter",
    "ContentBlock",
    "FikeyaAcpHost",
    "InteropError",
    "InteropManifest",
    "InteropReceipt",
    "LimitExceededError",
    "MemoryReceiptSink",
    "McpToolAdapter",
    "NormalizedToolResult",
    "PathPolicy",
    "PermissionDecision",
    "PermissionDeniedError",
    "PermissionRequest",
    "PermissionResolution",
    "ProcessPolicy",
    "ProcessSpec",
    "ProtocolError",
    "ResourceLimits",
    "SessionRef",
    "ToolDescriptor",
    "ToolPolicy",
    "canonical_digest",
    "codex_process_spec",
    "load_manifest",
]
