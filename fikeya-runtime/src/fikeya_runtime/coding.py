# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Integrated, approval-gated coding loop built on Fikeya Agent Core."""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
import threading
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from fikeya_agent_core import (
    AgentLimits,
    AgentNoProgressError,
    AgentOrchestrator,
    ApprovalDecision,
    ApprovalRequest,
    ApprovalResponse,
    CancellationToken,
    EvidenceCitation,
    EvidenceContext,
    InMemoryCheckpointStore,
    RuntimeProviderAdapter,
    Stage,
    ToolCall,
    ToolDefinition,
    ToolResult,
)

from .agent import AgentRunner, MemoryPreparation
from .browser import BrowserActionResult, BrowserEngine, BrowserSession
from .conversation import ConversationTurn, build_conversation_prompt
from .credentials import CredentialResolver
from .errors import (
    ApprovalError,
    FikeyaError,
    ProviderConnectivityError,
    ProviderError,
    ProviderHttpError,
)
from .events import EventType
from .inference import (
    MAX_REQUEST_BYTES,
    InferenceImage,
    InferenceRequest,
    ProviderCallResult,
    ProviderExecutor,
    provider_request_fingerprint,
    serialized_provider_request_bytes,
)
from .mcp_broker import McpBrokerRegistry
from .modes import AgentMode, ModePolicy, mode_policy
from .providers import ProviderProfile, ProviderStore
from .qarinah import select_qarinah_adapter
from .state import StateStore
from .tools import (
    ApprovalLedger,
    ToolBroker,
    ToolRequest,
    _minimal_environment,
    _resolve_trusted_executable,
)
from .util import sha256_text, stable_json
from .workspace import Workspace

ApprovalHandler = Callable[[dict[str, object]], Awaitable[ApprovalDecision]]
ProgressHandler = Callable[[dict[str, object]], None]

_DEFAULT_ALLOWED_EXECUTABLES = frozenset(
    {
        "bun",
        "cargo",
        "cmake",
        "ctest",
        "deno",
        "dotnet",
        "git",
        "go",
        "gradle",
        "gradlew",
        "java",
        "javac",
        "jest",
        "make",
        "mvn",
        "mvnw",
        "node",
        "npm",
        "npx",
        "pnpm",
        "pytest",
        "python",
        "python3",
        "rg",
        "ruff",
        "rustc",
        "swift",
        "tsc",
        "uv",
        "vitest",
        "yarn",
    }
)
_MCP_AGENT_MODES = frozenset({AgentMode.BUILD, AgentMode.RESEARCH})
_IGNORED_DIRECTORIES = frozenset(
    {
        ".fikeya",
        ".git",
        ".hg",
        ".pytest_cache",
        ".svn",
        "__pycache__",
        "node_modules",
    }
)
_IGNORED_DIRECTORIES_CASEFOLDED = frozenset(
    value.casefold() for value in _IGNORED_DIRECTORIES
)
_MUTATION_EXCLUDED_DIRECTORIES = frozenset(
    {
        ".build",
        ".cache",
        ".gradle",
        ".mypy_cache",
        ".next",
        ".nuxt",
        ".parcel-cache",
        ".ruff_cache",
        ".qarinah",
        ".svelte-kit",
        ".tox",
        ".tmp",
        ".turbo",
        ".venv",
        ".vite",
        "__pypackages__",
        "build",
        "coverage",
        "dist",
        "htmlcov",
        "out",
        "target",
        "venv",
    }
)
_MUTATION_EXCLUDED_DIRECTORIES_CASEFOLDED = frozenset(
    value.casefold() for value in _MUTATION_EXCLUDED_DIRECTORIES
)
_MUTATION_SOURCE_PRIORITY_DIRECTORIES = frozenset(
    {
        "app",
        "apps",
        "crates",
        "include",
        "lib",
        "packages",
        "source",
        "src",
        "test",
        "tests",
    }
)
_TEST_EXECUTABLES = frozenset(
    {
        "bun",
        "cargo",
        "ctest",
        "dotnet",
        "go",
        "gradle",
        "gradlew",
        "jest",
        "mvn",
        "mvnw",
        "npm",
        "npx",
        "pnpm",
        "pytest",
        "python",
        "python3",
        "uv",
        "vitest",
        "yarn",
    }
)
_DEDICATED_TEST_EXECUTABLES = frozenset({"ctest", "jest", "pytest", "vitest"})
_SHA256_PATTERN = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
_MAX_FILE_BYTES = 1_048_576
_MAX_LISTED_FILES = 1_000
_MAX_SEARCH_RESULTS = 200
_MAX_SEARCH_BYTES = 32 * 1024 * 1024
_MAX_MUTATION_SCAN_FILES = 5_000
_MAX_MUTATION_SCAN_FILE_BYTES = 16 * 1024 * 1024
_MAX_MUTATION_SCAN_TOTAL_BYTES = 256 * 1024 * 1024
_GIT_PRIORITY_TIMEOUT_SECONDS = 1.0
_MAX_GIT_PRIORITY_OUTPUT_BYTES = 2 * 1024 * 1024
_MAX_GIT_BASELINE_OUTPUT_BYTES = 32 * 1024 * 1024
_MAX_RECORDED_MUTATIONS = 1_000
_MAX_CHANGED_FILE_RECEIPT_BYTES = 240 * 1024
_MAX_PROCESS_MUTATION_RECEIPT_BYTES = 96 * 1024
_MAX_AGENT_TOOL_RESULT_BYTES = 256 * 1024
# This bounds retained logical state. RuntimeProviderAdapter independently compacts and
# measures the exact serialized wire body against MAX_REQUEST_BYTES before dispatch.
_MAX_AGENT_PROVIDER_CONTEXT_BYTES = 4 * 1024 * 1024
_MAX_CODING_PROTOCOL_LINE_BYTES = 1_024 * 1_024
_MAX_RECEIPT_BYTE_COUNT = 9_007_199_254_740_991
_MAX_LINE_DELTA_FILE_BYTES = 1_048_576
_MAX_LINE_DELTA_SNAPSHOT_BYTES = 32 * 1024 * 1024
_MAX_LINE_DELTA_LINES = 20_000
_MAX_LINE_DELTA_SEQUENCE_CELLS = 250_000
_CHANGED_FILE_SCOPE = "regular-project-files-v1"
_TOOL_TEXT_TRUNCATION_MARKER = (
    "\n[Fikeya truncated tool output to fit the agent limit.]"
)
_FINAL_OUTPUT_TRUNCATION_MARKER = (
    "\n[Fikeya truncated the answer to fit the JSONL transport limit.]"
)
_FINAL_PLAN_TRUNCATION_MARKER = (
    "\n[Fikeya truncated the plan to fit the JSONL transport limit.]"
)


@dataclass(frozen=True, slots=True)
class ToolExecutionReceipt:
    """Content-free result metadata for one approved tool execution."""

    call_id: str
    name: str
    status: str
    output_sha256: str
    duration_ms: int | None = None
    exit_code: int | None = None
    test: bool = False

    def as_json(self) -> dict[str, object]:
        return {
            "callId": self.call_id,
            "durationMs": self.duration_ms,
            "exitCode": self.exit_code,
            "name": self.name,
            "outputSha256": self.output_sha256,
            "status": self.status,
            "test": self.test,
        }


@dataclass(frozen=True, slots=True)
class ChangedFileReceipt:
    """Run-level identity and bounded line delta for one changed file."""

    path: str
    before_exists: bool
    after_exists: bool
    before_sha256: str | None
    after_sha256: str | None
    operation: str
    before_bytes: int | None
    after_bytes: int | None
    lines_added: int | None
    lines_deleted: int | None
    line_delta_status: str

    def as_json(self) -> dict[str, object]:
        return {
            "afterSha256": self.after_sha256,
            "afterBytes": self.after_bytes,
            "afterExists": self.after_exists,
            "beforeSha256": self.before_sha256,
            "beforeBytes": self.before_bytes,
            "beforeExists": self.before_exists,
            "lineDeltaStatus": self.line_delta_status,
            "linesAdded": self.lines_added,
            "linesDeleted": self.lines_deleted,
            "operation": self.operation,
            "path": self.path,
        }


@dataclass(frozen=True, slots=True)
class _FileSnapshot:
    """Ephemeral file identity; text is never serialized or persisted."""

    exists: bool
    sha256: str | None
    byte_count: int | None
    text: str | None
    line_delta_status: str

    @classmethod
    def missing(cls) -> _FileSnapshot:
        return cls(
            exists=False,
            sha256=None,
            byte_count=None,
            text="",
            line_delta_status="exact",
        )

    @classmethod
    def unmeasured(cls, byte_count: int | None, status: str) -> _FileSnapshot:
        return cls(
            exists=True,
            sha256=None,
            byte_count=byte_count,
            text=None,
            line_delta_status=status,
        )

    def without_text(self, status: str = "unavailable") -> _FileSnapshot:
        return _FileSnapshot(
            exists=self.exists,
            sha256=self.sha256,
            byte_count=self.byte_count,
            text=None,
            line_delta_status=status,
        )


@dataclass(frozen=True, slots=True)
class _GitWorktreeView:
    available: bool
    complete: bool
    head_oid: str | None
    paths: tuple[Path, ...]
    baseline_oids: dict[str, str | None]


class _WorkspaceFileSnapshot(dict[str, _FileSnapshot]):
    """Snapshot values plus ephemeral Git evidence used for cap reconciliation."""

    def __init__(self, git_view: _GitWorktreeView) -> None:
        super().__init__()
        self.git_view = git_view


@dataclass(frozen=True, slots=True)
class CodingRunFailure:
    """Bounded terminal failure classification without provider response content."""

    kind: str
    retryable: bool
    status_code: int | None = None

    def as_json(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "retryable": self.retryable,
            "statusCode": self.status_code,
        }


@dataclass(frozen=True, slots=True)
class CodingRunResult:
    """Ephemeral final answer plus a bounded, content-free execution outcome."""

    session_id: str
    status: str
    output: str
    plan: str
    steps: int
    memory: MemoryPreparation
    provider_call_ids: tuple[str, ...]
    usage: dict[str, object]
    tool_calls: tuple[ToolExecutionReceipt, ...]
    changed_files: tuple[ChangedFileReceipt, ...]
    changed_files_truncated: bool
    provider_attempt_ids: tuple[str, ...] = ()
    failure: CodingRunFailure | None = None

    def as_json(self) -> dict[str, object]:
        tests = [receipt.as_json() for receipt in self.tool_calls if receipt.test]
        return {
            "callId": self.provider_call_ids[-1] if self.provider_call_ids else None,
            "changedFiles": [receipt.as_json() for receipt in self.changed_files],
            "changedFilesTruncated": self.changed_files_truncated,
            "changedFilesScope": _CHANGED_FILE_SCOPE,
            "failure": self.failure.as_json() if self.failure is not None else None,
            "memory": {
                "coverage": self.memory.coverage,
                "evidenceCount": self.memory.evidence_count,
                "receiptId": self.memory.receipt_id,
                "responseSha256": self.memory.response_sha256,
                "status": self.memory.status,
            },
            "ok": self.status == "completed",
            "outcome": {
                "changedFiles": [receipt.as_json() for receipt in self.changed_files],
                "changedFilesTruncated": self.changed_files_truncated,
                "changedFilesScope": _CHANGED_FILE_SCOPE,
                "plan": self.plan,
                "steps": self.steps,
                "summary": self.output,
                "tests": tests,
                "toolCalls": [receipt.as_json() for receipt in self.tool_calls],
            },
            "output": self.output,
            "providerAttemptId": (
                self.provider_attempt_ids[-1] if self.provider_attempt_ids else None
            ),
            "providerAttemptIds": list(self.provider_attempt_ids),
            "providerCallIds": list(self.provider_call_ids),
            "sessionId": self.session_id,
            "status": self.status,
            "usage": self.usage,
        }


@dataclass(slots=True)
class _BrokerState:
    receipts: list[ToolExecutionReceipt] = field(default_factory=list)
    changed_files: dict[str, ChangedFileReceipt] = field(default_factory=dict)
    changed_files_truncated: bool = False
    original_file_snapshots: dict[str, _FileSnapshot] = field(default_factory=dict)
    original_snapshot_bytes: int = 0
    results: dict[str, ToolResult] = field(default_factory=dict)


def _json_byte_count(value: object) -> int:
    """Return the exact UTF-8 size emitted by the deterministic JSON serializer."""

    return len(stable_json(value).encode("utf-8"))


def _bounded_json_array_output(value: dict[str, object], field_name: str) -> str:
    """Retain the largest array prefix whose complete tool JSON fits Agent Core."""

    encoded = stable_json(value)
    if len(encoded.encode("utf-8")) <= _MAX_AGENT_TOOL_RESULT_BYTES:
        return encoded
    source = value.get(field_name)
    if not isinstance(source, list):
        raise FikeyaError("A bounded tool array payload had an invalid shape.")
    bounded = dict(value)
    bounded[field_name] = []
    bounded["truncated"] = True
    if _json_byte_count(bounded) > _MAX_AGENT_TOOL_RESULT_BYTES:
        raise FikeyaError("Tool result metadata exceeds the agent output limit.")
    low = 0
    high = len(source)
    while low < high:
        midpoint = (low + high + 1) // 2
        bounded[field_name] = source[:midpoint]
        if _json_byte_count(bounded) <= _MAX_AGENT_TOOL_RESULT_BYTES:
            low = midpoint
        else:
            high = midpoint - 1
    bounded[field_name] = source[:low]
    return stable_json(bounded)


def _bounded_json_text_output(
    value: dict[str, object], field_names: tuple[str, ...]
) -> str:
    """Bound JSON text fields using their escaped size in the complete payload."""

    encoded = stable_json(value)
    if len(encoded.encode("utf-8")) <= _MAX_AGENT_TOOL_RESULT_BYTES:
        return encoded
    bounded = dict(value)
    sources: dict[str, str] = {}
    for field_name in field_names:
        source = bounded.get(field_name)
        if isinstance(source, str) and source:
            sources[field_name] = source
            bounded[field_name] = _TOOL_TEXT_TRUNCATION_MARKER
    bounded["truncated"] = True
    if _json_byte_count(bounded) > _MAX_AGENT_TOOL_RESULT_BYTES:
        raise FikeyaError("Tool result metadata exceeds the agent output limit.")
    remaining_fields = len(sources)
    for field_name, source in sources.items():
        current_bytes = _json_byte_count(bounded)
        target_bytes = current_bytes + (
            (_MAX_AGENT_TOOL_RESULT_BYTES - current_bytes) // remaining_fields
        )
        bounded[field_name] = source
        if _json_byte_count(bounded) > target_bytes:
            low = 0
            high = len(source)
            while low < high:
                midpoint = (low + high + 1) // 2
                bounded[field_name] = source[:midpoint] + _TOOL_TEXT_TRUNCATION_MARKER
                if _json_byte_count(bounded) <= target_bytes:
                    low = midpoint
                else:
                    high = midpoint - 1
            bounded[field_name] = source[:low] + _TOOL_TEXT_TRUNCATION_MARKER
        remaining_fields -= 1
    if _json_byte_count(bounded) > _MAX_AGENT_TOOL_RESULT_BYTES:
        raise FikeyaError("Tool result could not be bounded to the agent limit.")
    return stable_json(bounded)


def _bound_agent_tool_result(result: ToolResult) -> ToolResult:
    """Enforce the Agent Core byte cap even for external broker implementations."""

    if len(result.output.encode("utf-8")) <= _MAX_AGENT_TOOL_RESULT_BYTES:
        return result
    return ToolResult(
        result.call_id,
        "error",
        "Tool result exceeded the agent output limit and was rejected safely.",
    )


class WorkspaceExecutionBroker:
    """Typed workspace and process operations behind Agent Core approvals."""

    def __init__(
        self,
        workspace: Workspace,
        *,
        allowed_executables: frozenset[str] = _DEFAULT_ALLOWED_EXECUTABLES,
        maximum_process_timeout_seconds: float = 120.0,
        mode: AgentMode | str = AgentMode.BUILD,
        allow_private_browser: bool = False,
        browser_engine: BrowserEngine | str = "playwright",
        browser_session: BrowserSession | None = None,
        mcp_registry: McpBrokerRegistry | None = None,
    ) -> None:
        if (
            isinstance(maximum_process_timeout_seconds, bool)
            or not 0.1 <= maximum_process_timeout_seconds <= 300
        ):
            raise ValueError(
                "maximum_process_timeout_seconds must be between 0.1 and 300 seconds."
            )
        self.workspace = workspace
        self.state = _BrokerState()
        self.mode_policy: ModePolicy = mode_policy(mode)
        self.allow_private_browser = allow_private_browser
        self.browser_engine = browser_engine
        self._browser = browser_session
        self._browser_executor: ThreadPoolExecutor | None = None
        self._mcp = mcp_registry or McpBrokerRegistry(workspace)
        self.maximum_process_timeout_seconds = maximum_process_timeout_seconds
        self._process_broker = ToolBroker(
            boundary=workspace.boundary,
            approvals=ApprovalLedger(StateStore(workspace.state_path)),
            allowed_executables=set(allowed_executables),
            execution_enabled=True,
            maximum_output_bytes=131_072,
        )

    async def list_tools(
        self, cancellation: CancellationToken
    ) -> tuple[ToolDefinition, ...]:
        cancellation.raise_if_cancelled()
        tools = (
            ToolDefinition(
                "workspace.list_files",
                "List bounded project-relative files. Generated and metadata directories are omitted.",
                {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "workspace.read_file",
                "Read one UTF-8 project file, optionally by inclusive one-based line range.",
                {
                    "type": "object",
                    "required": ["path"],
                    "properties": {
                        "endLine": {"type": "integer", "minimum": 1},
                        "path": {"type": "string"},
                        "startLine": {"type": "integer", "minimum": 1},
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "workspace.search_text",
                "Search bounded UTF-8 project files for a literal string.",
                {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "path": {"type": "string"},
                        "query": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "workspace.replace_text",
                "Replace exactly one literal occurrence after verifying the current file SHA-256.",
                {
                    "type": "object",
                    "required": ["expectedSha256", "newText", "oldText", "path"],
                    "properties": {
                        "expectedSha256": {"type": "string"},
                        "newText": {"type": "string"},
                        "oldText": {"type": "string"},
                        "path": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "workspace.write_file",
                "Create or replace one UTF-8 file. Existing files require their current SHA-256.",
                {
                    "type": "object",
                    "required": ["content", "expectedSha256", "path"],
                    "properties": {
                        "content": {"type": "string"},
                        "expectedSha256": {"type": ["string", "null"]},
                        "path": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "process.run",
                "Run one allowlisted executable without a shell inside the project. Use this for tests and linters.",
                {
                    "type": "object",
                    "required": ["arguments", "cwd", "executable"],
                    "properties": {
                        "arguments": {"type": "array", "items": {"type": "string"}},
                        "cwd": {"type": "string"},
                        "executable": {"type": "string"},
                        "timeoutSeconds": {
                            "type": "number",
                            "minimum": 0.1,
                            "maximum": self.maximum_process_timeout_seconds,
                        },
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.assert_text",
                "Require bounded visible page text before continuing the approved plan.",
                {
                    "type": "object",
                    "required": ["text"],
                    "properties": {"text": {"type": "string"}},
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.navigate",
                "Navigate the isolated browser to one approved HTTP or HTTPS URL.",
                {
                    "type": "object",
                    "required": ["url"],
                    "properties": {"url": {"type": "string"}},
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.snapshot",
                "Inspect a bounded accessibility or visible-text snapshot of the active page.",
                {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["accessible", "text"],
                        }
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.click",
                "Click one selector in the active page after an exact approval.",
                {
                    "type": "object",
                    "required": ["selector"],
                    "properties": {"selector": {"type": "string"}},
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.type",
                "Enter bounded text into one selector after an exact approval.",
                {
                    "type": "object",
                    "required": ["selector", "text"],
                    "properties": {
                        "clear": {"type": "boolean"},
                        "selector": {"type": "string"},
                        "text": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.scroll",
                "Scroll the active page by bounded pixel deltas.",
                {
                    "type": "object",
                    "required": ["deltaY"],
                    "properties": {
                        "deltaX": {"type": "integer"},
                        "deltaY": {"type": "integer"},
                    },
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.screenshot",
                "Capture one viewport PNG to an approved project-relative path.",
                {
                    "type": "object",
                    "required": ["path"],
                    "properties": {"path": {"type": "string"}},
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.wait",
                "Wait for a bounded number of milliseconds in the active page.",
                {
                    "type": "object",
                    "required": ["milliseconds"],
                    "properties": {"milliseconds": {"type": "integer"}},
                    "additionalProperties": False,
                },
            ),
            ToolDefinition(
                "browser.close",
                "Close the isolated browser session.",
                {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            ),
        )
        available = [tool for tool in tools if self.mode_policy.allows(tool.name)]
        if self.mode_policy.mode in _MCP_AGENT_MODES:
            available.extend(await self._mcp.list_tools(cancellation))
        return tuple(available)

    async def execute(
        self,
        call: ToolCall,
        cancellation: CancellationToken,
        *,
        idempotency_key: str,
    ) -> ToolResult:
        cancellation.raise_if_cancelled()
        cached = self.state.results.get(idempotency_key)
        if cached is not None:
            return cached
        if not self._allows_tool(call.name):
            result = ToolResult(
                call.call_id,
                "error",
                f"Tool is unavailable in {self.mode_policy.mode.value} mode.",
            )
            self.state.results[idempotency_key] = result
            self.state.receipts.append(
                ToolExecutionReceipt(
                    call_id=call.call_id,
                    name=call.name,
                    status=result.status,
                    output_sha256=sha256_text(result.output),
                    test=False,
                )
            )
            return result
        try:
            if call.name == "workspace.list_files":
                result = self._list_files(call)
            elif call.name == "workspace.read_file":
                result = self._read_file(call)
            elif call.name == "workspace.search_text":
                result = self._search_text(call)
            elif call.name == "workspace.replace_text":
                result = self._replace_text(call)
            elif call.name == "workspace.write_file":
                result = self._write_file(call)
            elif call.name == "process.run":
                result = await asyncio.to_thread(self._run_process, call, cancellation)
            elif call.name.startswith("browser."):
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(
                    self._browser_worker(), self._run_browser, call, cancellation
                )
            elif self._mcp.owns(call.name):
                result = await self._mcp.execute(call, cancellation)
            else:
                result = ToolResult(call.call_id, "error", "Unknown broker tool.")
        except (ApprovalError, FikeyaError, OSError, UnicodeError, ValueError) as error:
            result = ToolResult(call.call_id, "error", _safe_error(error))
        result = _bound_agent_tool_result(result)
        for index, receipt in enumerate(self.state.receipts):
            if receipt.call_id == call.call_id:
                self.state.receipts[index] = replace(
                    receipt,
                    output_sha256=sha256_text(result.output),
                    status=result.status,
                )
                break
        self.state.results[idempotency_key] = result
        if not any(item.call_id == call.call_id for item in self.state.receipts):
            process_arguments = (
                call.arguments.get("arguments") if call.name == "process.run" else None
            )
            process_executable = (
                call.arguments.get("executable") if call.name == "process.run" else None
            )
            self.state.receipts.append(
                ToolExecutionReceipt(
                    call_id=call.call_id,
                    name=call.name,
                    status=result.status,
                    output_sha256=sha256_text(result.output),
                    test=(
                        isinstance(process_executable, str)
                        and isinstance(process_arguments, list)
                        and all(isinstance(value, str) for value in process_arguments)
                        and _is_test_command(process_executable, process_arguments)
                    ),
                )
            )
        # Once any tool has produced a deterministic result, cache and receipt it before
        # honoring cancellation at the orchestrator's next state-machine boundary. This
        # closes the post-effect window for direct writes, browser captures, MCP calls,
        # and managed processes without re-running an uncertain side effect.
        return result

    def close(self) -> None:
        """Release optional browser and MCP processes owned by this broker."""

        try:
            executor = self._browser_executor
            if executor is None:
                if self._browser is not None:
                    self._browser.close()
                    self._browser = None
            else:
                try:
                    executor.submit(self._close_browser).result(timeout=30)
                finally:
                    executor.shutdown(wait=True, cancel_futures=True)
                    self._browser_executor = None
        finally:
            self._mcp.close()

    def _allows_tool(self, name: str) -> bool:
        if name.startswith("mcp."):
            return self.mode_policy.mode in _MCP_AGENT_MODES
        return self.mode_policy.allows(name)

    def _browser_worker(self) -> ThreadPoolExecutor:
        if self._browser_executor is None:
            self._browser_executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="fikeya-browser",
            )
        return self._browser_executor

    def _close_browser(self) -> None:
        if self._browser is not None:
            self._browser.close()
            self._browser = None

    def _browser_session(self) -> BrowserSession:
        if self._browser is None:
            self._browser = BrowserSession(
                self.workspace.root,
                allow_private=self.allow_private_browser,
                engine=self.browser_engine,
            )
        return self._browser

    def _run_browser(
        self, call: ToolCall, cancellation: CancellationToken
    ) -> ToolResult:
        cancellation.raise_if_cancelled()
        session = self._browser_session()
        result: BrowserActionResult
        file_change: ChangedFileReceipt | None = None
        if call.name == "browser.navigate":
            arguments = _exact_arguments(
                call, required=frozenset({"url"}), optional=frozenset()
            )
            result = session.navigate(_required_string(arguments, "url"))
        elif call.name == "browser.assert_text":
            arguments = _exact_arguments(
                call, required=frozenset({"text"}), optional=frozenset()
            )
            expected = _required_string(arguments, "text")
            if len(expected.encode("utf-8")) > 4_096:
                raise ValueError("Browser text assertion exceeds 4096 UTF-8 bytes.")
            result = session.inspect("text")
            if result.text is None or expected not in result.text:
                raise ValueError("Expected browser text was not present.")
        elif call.name == "browser.snapshot":
            arguments = _exact_arguments(
                call, required=frozenset(), optional=frozenset({"kind"})
            )
            kind = _optional_string(arguments, "kind", default="accessible")
            if kind not in {"accessible", "text"}:
                raise ValueError("Browser snapshot kind must be accessible or text.")
            result = session.inspect(kind)  # type: ignore[arg-type]
        elif call.name == "browser.click":
            arguments = _exact_arguments(
                call, required=frozenset({"selector"}), optional=frozenset()
            )
            result = session.click(_required_string(arguments, "selector"))
        elif call.name == "browser.type":
            arguments = _exact_arguments(
                call,
                required=frozenset({"selector", "text"}),
                optional=frozenset({"clear"}),
            )
            clear = arguments.get("clear", True)
            if not isinstance(clear, bool):
                raise ValueError("Browser clear must be boolean.")
            result = session.type(
                _required_string(arguments, "selector"),
                _required_string(arguments, "text", allow_empty=True),
                clear=clear,
            )
        elif call.name == "browser.scroll":
            arguments = _exact_arguments(
                call,
                required=frozenset({"deltaY"}),
                optional=frozenset({"deltaX"}),
            )
            result = session.scroll(
                _required_integer(arguments, "deltaY"),
                delta_x=_optional_integer(arguments, "deltaX", default=0),
            )
        elif call.name == "browser.screenshot":
            arguments = _exact_arguments(
                call, required=frozenset({"path"}), optional=frozenset()
            )
            supplied = _required_string(arguments, "path")
            target = self._file(supplied, must_exist=False)
            before = _capture_file_snapshot(target)
            relative = target.relative_to(self.workspace.root).as_posix()
            screenshot_error: Exception | None = None
            try:
                result = session.screenshot(relative)
            except Exception as error:  # noqa: BLE001 - reconcile any post-write failure.
                screenshot_error = error
            try:
                after = _capture_file_snapshot(target)
                if not _snapshots_equal(before, after):
                    file_change = _changed_file_receipt(relative, before, after)
                    self._record_run_file_change(relative, before, after)
            except Exception:  # Never replace the browser's original failure.
                self.state.changed_files_truncated = True
                if screenshot_error is None:
                    raise
            if screenshot_error is not None:
                raise screenshot_error
        elif call.name == "browser.wait":
            arguments = _exact_arguments(
                call, required=frozenset({"milliseconds"}), optional=frozenset()
            )
            result = session.wait(
                _required_integer(arguments, "milliseconds"),
                cancellation_requested=lambda: cancellation.cancelled,
            )
        elif call.name == "browser.close":
            _exact_arguments(call, required=frozenset(), optional=frozenset())
            result = session.close()
            self._browser = None
        else:
            raise ValueError("Unknown browser operation.")
        payload = result.as_json()
        if file_change is not None:
            payload["fileChange"] = file_change.as_json()
        output = _bounded_json_text_output(payload, ("text",))
        return ToolResult(call.call_id, "ok", output, "application/json")

    def _list_files(self, call: ToolCall) -> ToolResult:
        arguments = _exact_arguments(
            call, required=frozenset(), optional=frozenset({"path"})
        )
        relative = _optional_string(arguments, "path", default=".")
        directory = self.workspace.boundary.resolve(relative, must_exist=True)
        if not directory.is_dir():
            raise ValueError("The list path is not a directory.")
        values: list[str] = []
        for root, directories, files in os.walk(directory, followlinks=False):
            directories[:] = sorted(
                name for name in directories if not _is_ignored_directory(name)
            )
            for name in sorted(files):
                candidate = Path(root) / name
                resolved = self.workspace.boundary.resolve(
                    candidate.relative_to(self.workspace.root), must_exist=True
                )
                if resolved.is_file():
                    values.append(resolved.relative_to(self.workspace.root).as_posix())
                    if len(values) >= _MAX_LISTED_FILES:
                        break
            if len(values) >= _MAX_LISTED_FILES:
                break
        output = _bounded_json_array_output(
            {"files": values, "truncated": len(values) >= _MAX_LISTED_FILES},
            "files",
        )
        return ToolResult(call.call_id, "ok", output, "application/json")

    def _read_file(self, call: ToolCall) -> ToolResult:
        arguments = _exact_arguments(
            call,
            required=frozenset({"path"}),
            optional=frozenset({"endLine", "startLine"}),
        )
        path = self._readable_file(_required_string(arguments, "path"))
        payload = _read_bounded_utf8(path)
        lines = payload.splitlines(keepends=True)
        start = _optional_integer(arguments, "startLine", default=1)
        end = _optional_integer(arguments, "endLine", default=max(1, len(lines)))
        if start < 1 or end < start:
            raise ValueError("The requested line range is invalid.")
        selected = "".join(lines[start - 1 : end])
        output = _bounded_json_text_output(
            {
                "content": selected,
                "endLine": min(end, len(lines)),
                "path": path.relative_to(self.workspace.root).as_posix(),
                "sha256": f"sha256:{_file_sha256(path)}",
                "startLine": start,
                "totalLines": len(lines),
                "truncated": False,
            },
            ("content",),
        )
        return ToolResult(call.call_id, "ok", output, "application/json")

    def _search_text(self, call: ToolCall) -> ToolResult:
        arguments = _exact_arguments(
            call,
            required=frozenset({"query"}),
            optional=frozenset({"path"}),
        )
        query = _required_string(arguments, "query")
        if len(query) > 4_096:
            raise ValueError("Search query exceeds 4096 characters.")
        relative = _optional_string(arguments, "path", default=".")
        target = self.workspace.boundary.resolve(relative, must_exist=True)
        candidates = [target] if target.is_file() else _candidate_files(target)
        scanned_bytes = 0
        matches: list[dict[str, object]] = []
        truncated = False
        for candidate in candidates:
            relative_path = candidate.relative_to(self.workspace.root)
            if any(_is_ignored_directory(part) for part in relative_path.parts):
                continue
            try:
                path = self.workspace.boundary.resolve(relative_path, must_exist=True)
            except FikeyaError:
                continue
            if not path.is_file():
                continue
            size = path.stat().st_size
            if size > _MAX_FILE_BYTES or scanned_bytes + size > _MAX_SEARCH_BYTES:
                truncated = True
                continue
            scanned_bytes += size
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (UnicodeDecodeError, OSError):
                continue
            for line_number, line in enumerate(lines, 1):
                if query in line:
                    matches.append(
                        {
                            "line": line_number,
                            "path": path.relative_to(self.workspace.root).as_posix(),
                            "text": line[:1_024],
                        }
                    )
                    if len(matches) >= _MAX_SEARCH_RESULTS:
                        truncated = True
                        break
            if len(matches) >= _MAX_SEARCH_RESULTS:
                break
        output = _bounded_json_array_output(
            {"matches": matches, "truncated": truncated}, "matches"
        )
        return ToolResult(call.call_id, "ok", output, "application/json")

    def _replace_text(self, call: ToolCall) -> ToolResult:
        arguments = _exact_arguments(
            call,
            required=frozenset({"expectedSha256", "newText", "oldText", "path"}),
            optional=frozenset(),
        )
        path = self._file(_required_string(arguments, "path"), must_exist=True)
        expected = _required_hash(arguments, "expectedSha256")
        old_text = _required_string(arguments, "oldText")
        new_text = _required_string(arguments, "newText", allow_empty=True)
        current = _read_bounded_utf8(path)
        before = _snapshot_from_utf8_text(current)
        if before.sha256 != expected:
            raise ValueError(
                "File changed after it was inspected; read it again before editing."
            )
        if current.count(old_text) != 1:
            raise ValueError("oldText must match exactly one occurrence.")
        updated = current.replace(old_text, new_text, 1)
        self._atomic_write(path, updated, expected_before=before)
        return self._changed_result(call, path, before)

    def _write_file(self, call: ToolCall) -> ToolResult:
        arguments = _exact_arguments(
            call,
            required=frozenset({"content", "expectedSha256", "path"}),
            optional=frozenset(),
        )
        supplied_path = _required_string(arguments, "path")
        path = self._file(supplied_path, must_exist=False)
        content = _required_string(arguments, "content", allow_empty=True)
        expected_value = arguments["expectedSha256"]
        if expected_value is not None and not isinstance(expected_value, str):
            raise ValueError("expectedSha256 must be a hash or null.")
        expected = (
            _normalize_hash(expected_value) if isinstance(expected_value, str) else None
        )
        if path.exists() and not path.is_file():
            raise ValueError("The write target is not a regular file.")
        before = _capture_file_snapshot(path)
        if (expected is None and before.exists) or (
            expected is not None and before.sha256 != expected
        ):
            raise ValueError(
                "Write precondition failed; inspect the current file before replacing it."
            )
        self._atomic_write(path, content, expected_before=before)
        return self._changed_result(call, path, before)

    def _run_process(
        self, call: ToolCall, cancellation: CancellationToken
    ) -> ToolResult:
        arguments = _exact_arguments(
            call,
            required=frozenset({"arguments", "cwd", "executable"}),
            optional=frozenset({"timeoutSeconds"}),
        )
        executable = _required_string(arguments, "executable")
        values = arguments["arguments"]
        if (
            not isinstance(values, list)
            or len(values) > 127
            or any(not isinstance(value, str) for value in values)
        ):
            raise ValueError(
                "Process arguments must be an array of at most 127 strings."
            )
        cwd = _required_string(arguments, "cwd", allow_empty=True) or "."
        timeout = arguments.get(
            "timeoutSeconds",
            min(120.0, self.maximum_process_timeout_seconds),
        )
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise TypeError("timeoutSeconds must be numeric.")
        if not 0.1 <= float(timeout) <= self.maximum_process_timeout_seconds:
            raise ValueError(
                f"timeoutSeconds must be between 0.1 and {self.maximum_process_timeout_seconds:g}."
            )
        (
            before_snapshot,
            before_paths_complete,
            before_snapshot_complete,
            before_incomplete_scopes,
        ) = _workspace_file_snapshot(self.workspace)
        request = ToolRequest(
            (executable, *values), cwd=cwd, timeout_seconds=float(timeout)
        )
        token = self._process_broker.approve(
            request, ttl_seconds=max(1.0, min(600.0, float(timeout) + 10))
        )
        workspace_mutations: dict[str, object] = {
            "changes": [],
            "complete": False,
            "paths": [],
            "scope": _CHANGED_FILE_SCOPE,
            "truncated": True,
        }
        started_at = time.monotonic()
        process_error: Exception | None = None
        outcome = None
        try:
            outcome = self._process_broker.execute(
                request,
                dry_run=False,
                approval_token=token,
                cancellation_requested=lambda: cancellation.cancelled,
            )
        except (ApprovalError, FikeyaError, OSError, UnicodeError, ValueError) as error:
            process_error = error
        finally:
            try:
                workspace_mutations = self._capture_process_mutations(
                    before_snapshot,
                    before_paths_complete=before_paths_complete,
                    before_snapshot_complete=before_snapshot_complete,
                    before_incomplete_scopes=before_incomplete_scopes,
                )
            except Exception:  # noqa: BLE001 - preserve the original process result.
                # Mutation evidence must never mask the original process result.
                self.state.changed_files_truncated = True
        if process_error is not None:
            output = _bounded_json_text_output(
                {
                    "durationMs": max(
                        0, round((time.monotonic() - started_at) * 1_000)
                    ),
                    "error": _safe_error(process_error),
                    "exitCode": None,
                    "stderr": "",
                    "stdout": "",
                    "truncated": True,
                    "workspaceMutations": workspace_mutations,
                },
                ("error", "stdout", "stderr"),
            )
            receipt = ToolExecutionReceipt(
                call_id=call.call_id,
                duration_ms=max(0, round((time.monotonic() - started_at) * 1_000)),
                exit_code=None,
                name=call.name,
                output_sha256=sha256_text(output),
                status="error",
                test=_is_test_command(executable, values),
            )
            self.state.receipts.append(receipt)
            return ToolResult(call.call_id, "error", output, "application/json")
        assert outcome is not None
        output = _bounded_json_text_output(
            {
                "durationMs": outcome.duration_ms,
                "exitCode": outcome.exit_code,
                "stderr": outcome.stderr,
                "stdout": outcome.stdout,
                "truncated": outcome.truncated,
                "workspaceMutations": workspace_mutations,
            },
            ("stdout", "stderr"),
        )
        test = _is_test_command(executable, values)
        receipt = ToolExecutionReceipt(
            call_id=call.call_id,
            duration_ms=outcome.duration_ms,
            exit_code=outcome.exit_code,
            name=call.name,
            output_sha256=sha256_text(output),
            status="ok" if outcome.exit_code == 0 else "error",
            test=test,
        )
        self.state.receipts.append(receipt)
        return ToolResult(call.call_id, receipt.status, output, "application/json")

    def _capture_process_mutations(
        self,
        before_snapshot: dict[str, _FileSnapshot],
        *,
        before_paths_complete: bool,
        before_snapshot_complete: bool,
        before_incomplete_scopes: frozenset[str],
    ) -> dict[str, object]:
        (
            after_snapshot,
            after_paths_complete,
            after_snapshot_complete,
            after_incomplete_scopes,
        ) = _workspace_file_snapshot(self.workspace)
        _reconcile_git_snapshot_boundaries(
            self.workspace.root, before_snapshot, after_snapshot
        )
        if not before_snapshot_complete or not after_snapshot_complete:
            self.state.changed_files_truncated = True
        mutated_paths = _measured_mutation_paths(
            before_snapshot,
            after_snapshot,
            before_complete=before_paths_complete,
            after_complete=after_paths_complete,
            before_incomplete_scopes=before_incomplete_scopes,
            after_incomplete_scopes=after_incomplete_scopes,
        )
        recorded_mutations = mutated_paths[:_MAX_RECORDED_MUTATIONS]
        mutation_receipts: list[ChangedFileReceipt] = []
        mutation_receipt_bytes = 0
        for relative_path in recorded_mutations:
            before = before_snapshot.get(relative_path, _FileSnapshot.missing())
            after = after_snapshot.get(relative_path, _FileSnapshot.missing())
            receipt = _changed_file_receipt(relative_path, before, after)
            self._record_run_file_change(relative_path, before, after)
            projected_bytes = len(
                stable_json(
                    {"change": receipt.as_json(), "path": relative_path}
                ).encode("utf-8")
            )
            if (
                mutation_receipt_bytes + projected_bytes
                <= _MAX_PROCESS_MUTATION_RECEIPT_BYTES
            ):
                mutation_receipts.append(receipt)
                mutation_receipt_bytes += projected_bytes
        truncated = len(mutated_paths) > _MAX_RECORDED_MUTATIONS or len(
            mutation_receipts
        ) != len(recorded_mutations)
        if truncated:
            self.state.changed_files_truncated = True
        return {
            "changes": [receipt.as_json() for receipt in mutation_receipts],
            "complete": before_snapshot_complete
            and after_snapshot_complete
            and not truncated,
            "paths": [receipt.path for receipt in mutation_receipts],
            "scope": _CHANGED_FILE_SCOPE,
            "truncated": truncated,
        }

    def _file(self, relative: str, *, must_exist: bool) -> Path:
        if not relative or relative == ".":
            raise ValueError("A file path is required.")
        path = self.workspace.boundary.resolve(relative, must_exist=must_exist)
        if any(
            _is_mutation_excluded_directory(part)
            for part in path.relative_to(self.workspace.root).parts
        ):
            raise ValueError(
                "Runtime, VCS, Qarinah, dependency, environment, build, and cache "
                "state are not editable project files."
            )
        return path

    def _readable_file(self, relative: str) -> Path:
        if not relative or relative == ".":
            raise ValueError("A file path is required.")
        path = self.workspace.boundary.resolve(relative, must_exist=True)
        if any(
            part.casefold() == ".fikeya"
            for part in path.relative_to(self.workspace.root).parts
        ):
            raise ValueError("Runtime-owned .fikeya state is not readable by tools.")
        if not path.is_file():
            raise ValueError("The read target is not a regular file.")
        return path

    def _atomic_write(
        self,
        path: Path,
        content: str,
        *,
        expected_before: _FileSnapshot,
    ) -> None:
        payload = content.encode("utf-8")
        if len(payload) > _MAX_FILE_BYTES:
            raise ValueError(f"File content exceeds {_MAX_FILE_BYTES} UTF-8 bytes.")
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            if not expected_before.exists:
                try:
                    # A same-directory hard link publishes the fully written inode
                    # atomically and fails rather than replacing a concurrent create.
                    os.link(temporary_name, path)
                except FileExistsError as error:
                    raise ValueError(
                        "Write precondition failed; the file was created concurrently."
                    ) from error
                os.unlink(temporary_name)
                return
            current = _capture_file_snapshot(path)
            if not _snapshots_equal(current, expected_before):
                raise ValueError(
                    "Write precondition failed; the file changed concurrently."
                )
            os.chmod(temporary_name, path.stat().st_mode)
            os.replace(temporary_name, path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)

    def _changed_result(
        self, call: ToolCall, path: Path, before: _FileSnapshot
    ) -> ToolResult:
        after = _capture_file_snapshot(path)
        relative = path.relative_to(self.workspace.root).as_posix()
        immediate = _changed_file_receipt(relative, before, after)
        self._record_run_file_change(relative, before, after)
        output = stable_json(immediate.as_json())
        return ToolResult(call.call_id, "ok", output, "application/json")

    def _record_run_file_change(
        self,
        relative: str,
        before: _FileSnapshot,
        after: _FileSnapshot,
    ) -> None:
        original = self.state.original_file_snapshots.get(relative)
        if original is None:
            if len(self.state.changed_files) >= _MAX_RECORDED_MUTATIONS:
                self.state.changed_files_truncated = True
                return
            original = before
            retained_bytes = (
                before.byte_count
                if before.text is not None and before.byte_count is not None
                else 0
            )
            if (
                retained_bytes > 0
                and self.state.original_snapshot_bytes + retained_bytes
                > _MAX_LINE_DELTA_SNAPSHOT_BYTES
            ):
                original = before.without_text()
                retained_bytes = 0
            self.state.original_file_snapshots[relative] = original
            self.state.original_snapshot_bytes += retained_bytes

        if _snapshots_equal(original, after):
            released = self.state.original_file_snapshots.pop(relative)
            if released.text is not None and released.byte_count is not None:
                self.state.original_snapshot_bytes -= released.byte_count
            self.state.changed_files.pop(relative, None)
            return

        self.state.changed_files[relative] = _changed_file_receipt(
            relative, original, after
        )


class _RecordingExecutor:
    """Retain only content-free receipts for every provider stage call."""

    def __init__(
        self,
        delegate: ProviderExecutor,
        state: StateStore,
        session_id: str,
    ) -> None:
        self.delegate = delegate
        self.state = state
        self.session_id = session_id
        self.attempt_ids: list[str] = []
        self._attempt_receipt_ids: list[str | None] = []
        self.call_ids: list[str] = []

    def execute(
        self,
        profile: ProviderProfile,
        credential: str | None,
        request: InferenceRequest,
        *,
        allow_network: bool,
        timeout: float,
        cancellation: CancellationToken,
    ) -> ProviderCallResult:
        fingerprint = provider_request_fingerprint(profile, request)
        requested = self.state.append_event(
            self.session_id,
            EventType.PROVIDER_REQUESTED,
            {
                "apiMode": profile.api_mode,
                "model": profile.model,
                "provider": profile.name,
                "requestBytes": fingerprint.request_bytes,
                "requestSha256": fingerprint.request_sha256,
            },
        )
        self.attempt_ids.append(requested.event_id)
        self._attempt_receipt_ids.append(None)
        result = self.delegate.execute(
            profile,
            credential,
            request,
            allow_network=allow_network,
            timeout=timeout,
            cancellation=cancellation,
        )
        usage = result.usage
        call_id = self.state.record_provider_call(
            self.session_id,
            provider_name=profile.name,
            model_name=profile.model,
            api_mode=profile.api_mode,
            request_sha256=result.request_sha256,
            response_sha256=result.response_sha256,
            request_bytes=result.request_bytes,
            response_bytes=result.response_bytes,
            status_code=result.status_code,
            duration_ms=result.duration_ms,
            usage_measurement=usage.measurement,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cached_input_tokens=usage.cached_input_tokens,
        )
        self.call_ids.append(call_id)
        self._attempt_receipt_ids[-1] = call_id
        if usage.measurement == "provider-reported":
            assert usage.input_tokens is not None
            assert usage.output_tokens is not None
            assert usage.cached_input_tokens is not None
            self.state.record_usage(
                self.session_id,
                provider_name=profile.name,
                model_name=profile.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cached_input_tokens=usage.cached_input_tokens,
            )
        payload: dict[str, object] = {
            "callId": call_id,
            "durationMs": result.duration_ms,
            "responseBytes": result.response_bytes,
            "responseSha256": result.response_sha256,
            "statusCode": result.status_code,
            "usageMeasurement": usage.measurement,
        }
        if usage.measurement == "provider-reported":
            payload.update(
                {
                    "cachedInputTokens": usage.cached_input_tokens,
                    "inputTokens": usage.input_tokens,
                    "outputTokens": usage.output_tokens,
                }
            )
        self.state.append_event(
            self.session_id,
            EventType.PROVIDER_RESULT,
            payload,
            causation_id=requested.event_id,
        )
        return result


class CodingAgentRunner:
    """Connect runtime providers, Qarinah, Agent Core, approvals, and tools."""

    def __init__(
        self,
        workspace: Workspace,
        providers: ProviderStore,
        *,
        executor: ProviderExecutor | None = None,
        credentials: CredentialResolver | None = None,
        allowed_executables: frozenset[str] | None = None,
        mcp_registry_factory: Callable[[Workspace], McpBrokerRegistry] | None = None,
    ) -> None:
        self.workspace = workspace
        self.providers = providers
        self.executor = executor or ProviderExecutor()
        self.credentials = credentials or CredentialResolver(providers)
        self.state = StateStore(workspace.state_path)
        self.allowed_executables = allowed_executables or _DEFAULT_ALLOWED_EXECUTABLES
        self.mcp_registry_factory = mcp_registry_factory or McpBrokerRegistry

    async def run(
        self,
        *,
        provider_name: str,
        prompt: str,
        allow_network: bool,
        timeout: float,
        max_output_tokens: int,
        cancellation: CancellationToken,
        approval_handler: ApprovalHandler,
        progress_handler: ProgressHandler | None = None,
        memory_mode: str = "auto",
        context_max_characters: int = 12_000,
        history: tuple[ConversationTurn, ...] = (),
        images: tuple[InferenceImage, ...] = (),
        mode: AgentMode | str = AgentMode.BUILD,
        allow_private_browser: bool = False,
        browser_engine: BrowserEngine | str = "playwright",
    ) -> CodingRunResult:
        """Run a complete reviewed loop, pausing for each exact approval."""

        policy = mode_policy(mode)
        broker: WorkspaceExecutionBroker | None = None
        recording: _RecordingExecutor | None = None
        orchestrator: AgentOrchestrator | None = None
        profile = self.providers.get(provider_name)
        session = self.state.create_session(
            metadata={
                "mode": "coding-agent",
                "agentMode": policy.mode.value,
                "model": profile.model,
                "provider": profile.name,
                "priorConversationTurns": len(history),
            }
        )
        memory_runner = AgentRunner(
            self.workspace,
            self.providers,
            executor=self.executor,
            credentials=self.credentials,
            memory=(
                select_qarinah_adapter(
                    workspace_root=self.workspace.root, state=self.state
                )
                if memory_mode != "off"
                else None
            ),
        )
        try:
            system, memory = memory_runner.prepare_memory(
                session.session_id,
                prompt,
                memory_mode=memory_mode,
                maximum_characters=context_max_characters,
            )
            evidence = _memory_evidence(system, memory)
            recording = _RecordingExecutor(
                self.executor, self.state, session.session_id
            )
            provider = RuntimeProviderAdapter(
                recording,
                profile,
                lambda: self.credentials.resolve(profile),
                allow_network=allow_network,
                timeout_seconds=timeout,
                request_factory=lambda provider_prompt, provider_system, maximum_tokens: (
                    InferenceRequest(
                        prompt=provider_prompt,
                        system=provider_system,
                        max_output_tokens=maximum_tokens,
                        images=images,
                    )
                ),
                request_sizer=lambda request: serialized_provider_request_bytes(
                    profile, request
                ),
                request_size_limit_bytes=MAX_REQUEST_BYTES,
            )
            broker = WorkspaceExecutionBroker(
                self.workspace,
                allowed_executables=self.allowed_executables,
                maximum_process_timeout_seconds=timeout,
                mode=policy.mode,
                allow_private_browser=allow_private_browser,
                browser_engine=browser_engine,
                mcp_registry=self.mcp_registry_factory(self.workspace),
            )
            maximum_output_bytes = max(256, min(4_194_304, max_output_tokens * 4))
            orchestrator = AgentOrchestrator(
                provider,
                broker,
                # The loop stays in one supervised process, so prompts and tool outputs never
                # enter the workspace database. Runtime SQLite retains content-free receipts.
                InMemoryCheckpointStore(),
                AgentLimits(
                    max_context_bytes=_MAX_AGENT_PROVIDER_CONTEXT_BYTES,
                    max_output_bytes=maximum_output_bytes,
                    max_tool_result_bytes=_MAX_AGENT_TOOL_RESULT_BYTES,
                    provider_timeout_seconds=timeout,
                    # The broker owns process-tree cleanup. Keep the orchestration timeout
                    # beyond the maximum approved tool runtime so wait_for never abandons it.
                    broker_timeout_seconds=min(600.0, timeout + 15.0),
                ),
            )
            orchestrator.start(
                build_conversation_prompt(history, prompt),
                evidence=evidence,
                session_id=session.session_id,
            )
            await self._advance(
                orchestrator,
                session.session_id,
                cancellation,
                approval_handler,
                broker,
                progress_handler,
            )
            current = orchestrator.state(session.session_id)
            if current.stage == Stage.CANCELLED:
                self.state.cancel_session(
                    session.session_id, current.failure_code or "cancelled"
                )
            elif current.stage == Stage.COMPLETED:
                self.state.complete_session(
                    session.session_id, "reviewed coding outcome returned"
                )
            elif current.stage == Stage.FAILED:
                self.state.fail_session(
                    session.session_id, current.failure_code or "coding loop failed"
                )
            else:
                self.state.cancel_session(
                    session.session_id, current.failure_code or current.stage.value
                )
            return _result(current, memory, recording, broker)
        except Exception as error:
            try:
                if self.state.get_session(session.session_id).status == "active":
                    current = (
                        orchestrator.state(session.session_id)
                        if orchestrator is not None
                        else None
                    )
                    if current is not None and current.stage == Stage.FAILED:
                        self.state.fail_session(
                            session.session_id,
                            current.failure_code or "coding loop failed",
                        )
                    else:
                        self.state.cancel_session(
                            session.session_id, "coding loop failed"
                        )
            except Exception as cleanup_error:  # noqa: BLE001 - cleanup must not mask the failure.
                error.add_note(
                    f"Session cleanup also failed with {type(cleanup_error).__name__}."
                )
            if (
                broker is not None
                and recording is not None
                and orchestrator is not None
                and (
                    recording.attempt_ids
                    or broker.state.receipts
                    or broker.state.changed_files
                    or broker.state.changed_files_truncated
                )
            ):
                current = orchestrator.state(session.session_id)
                if current.stage in {Stage.CANCELLED, Stage.FAILED}:
                    return _result(current, memory, recording, broker, error=error)
            raise
        finally:
            if broker is not None:
                broker.close()

    async def _advance(
        self,
        orchestrator: AgentOrchestrator,
        session_id: str,
        cancellation: CancellationToken,
        approval_handler: ApprovalHandler,
        broker: WorkspaceExecutionBroker,
        progress_handler: ProgressHandler | None,
    ) -> None:
        approval: ApprovalResponse | None = None
        recorded_receipts = 0
        while True:
            try:
                async for event in orchestrator.stream(
                    session_id,
                    approval=approval,
                    cancellation=cancellation,
                ):
                    if progress_handler is not None:
                        progress_handler(
                            {
                                "event": event.kind.value,
                                "sequence": event.sequence,
                                "stage": event.stage.value,
                                "type": "progress",
                            }
                        )
            finally:
                for receipt in broker.state.receipts[recorded_receipts:]:
                    self.state.append_event(
                        session_id,
                        EventType.TOOL_RESULT,
                        {
                            "callId": receipt.call_id,
                            "durationMs": receipt.duration_ms,
                            "exitCode": receipt.exit_code,
                            "outputSha256": receipt.output_sha256,
                            "status": receipt.status,
                            "test": receipt.test,
                            "toolName": receipt.name,
                        },
                    )
                recorded_receipts = len(broker.state.receipts)
            approval = None
            current = orchestrator.state(session_id)
            if current.stage != Stage.AWAITING_APPROVAL:
                return
            request = current.pending_approval
            call = current.pending_call
            if request is None or call is None:
                raise FikeyaError(
                    "Agent Core paused without an exact approval request."
                )
            self.state.append_event(
                session_id,
                EventType.TOOL_REQUESTED,
                {
                    "argumentsSha256": request.arguments_sha256,
                    "callId": request.call_id,
                    "requestId": request.request_id,
                    "toolName": request.tool_name,
                },
            )
            public_request = _approval_json(request, call)
            decision = await approval_handler(public_request)
            self.state.append_event(
                session_id,
                EventType.TOOL_APPROVED,
                {
                    "callId": request.call_id,
                    "decision": decision.value,
                    "requestId": request.request_id,
                    "toolName": request.tool_name,
                },
            )
            approval = ApprovalResponse(
                request.request_id,
                request.session_id,
                request.call_id,
                request.tool_name,
                request.arguments_sha256,
                request.expected_revision,
                decision,
            )


def _result(
    state: Any,
    memory: MemoryPreparation,
    recording: _RecordingExecutor,
    broker: WorkspaceExecutionBroker,
    *,
    error: BaseException | None = None,
) -> CodingRunResult:
    completed_attempt_receipts = tuple(
        call_id for call_id in recording._attempt_receipt_ids if call_id is not None
    )
    if completed_attempt_receipts != tuple(recording.call_ids):
        raise FikeyaError("Provider attempt-to-receipt accounting is inconsistent.")
    receipts = recording.state.provider_call_receipts(state.session_id)
    reported = bool(receipts) and all(
        item["usageMeasurement"] == "provider-reported" for item in receipts
    )
    totals = recording.state.usage_totals(state.session_id)
    usage: dict[str, object] = {
        "cachedInputTokens": totals["cachedInputTokens"] if reported else None,
        "inputTokens": totals["inputTokens"] if reported else None,
        "measurement": "provider-reported" if reported else "unavailable",
        "outputTokens": totals["outputTokens"] if reported else None,
    }
    status = (
        "completed"
        if state.stage == Stage.COMPLETED
        else "cancelled"
        if state.stage == Stage.CANCELLED
        else "failed"
    )
    failure = _coding_run_failure(status, state.failure_code, error)
    output = state.final_output or (
        "The run was cancelled before a reviewed answer was produced. "
        "Completed tool and changed-file evidence is retained below."
        if status == "cancelled"
        else (
            "The run failed before a reviewed answer was produced. "
            "Completed tool and changed-file evidence is retained below."
            if status == "failed"
            else ""
        )
    )
    changed_files, changed_files_bounded = _bound_changed_file_receipts(
        sorted(broker.state.changed_files.values(), key=lambda item: item.path)
    )
    return _bound_coding_run_result(
        CodingRunResult(
            session_id=state.session_id,
            status=status,
            output=output,
            plan=state.plan,
            steps=state.step_count,
            memory=memory,
            provider_call_ids=tuple(recording.call_ids),
            usage=usage,
            tool_calls=tuple(broker.state.receipts),
            changed_files=changed_files,
            changed_files_truncated=(
                broker.state.changed_files_truncated or changed_files_bounded
            ),
            provider_attempt_ids=tuple(recording.attempt_ids),
            failure=failure,
        )
    )


def _coding_run_failure(
    status: str,
    failure_code: str | None,
    error: BaseException | None,
) -> CodingRunFailure | None:
    if status != "failed":
        return None
    if isinstance(error, ProviderHttpError):
        return CodingRunFailure(error.kind, error.retryable, error.status_code)
    if isinstance(error, ProviderConnectivityError):
        return CodingRunFailure(error.kind, error.retryable)
    if isinstance(error, AgentNoProgressError) or failure_code == "agent_no_progress":
        return CodingRunFailure("agent_no_progress", False)
    if isinstance(error, ProviderError):
        return CodingRunFailure("provider", False)
    return CodingRunFailure("runtime", False)


def _bound_changed_file_receipts(
    receipts: list[ChangedFileReceipt],
) -> tuple[tuple[ChangedFileReceipt, ...], bool]:
    """Keep the duplicated legacy/final protocol result safely below transport limits."""

    retained: list[ChangedFileReceipt] = []
    retained_bytes = 0
    for receipt in receipts:
        receipt_bytes = len(stable_json(receipt.as_json()).encode("utf-8"))
        if retained_bytes + receipt_bytes > _MAX_CHANGED_FILE_RECEIPT_BYTES:
            return tuple(retained), True
        retained.append(receipt)
        retained_bytes += receipt_bytes
    return tuple(retained), False


def _coding_protocol_byte_count(result: CodingRunResult) -> int:
    """Measure the exact result line consumed by the desktop JSONL parser."""

    return _json_byte_count({"type": "result", **result.as_json()})


def _fit_result_text(
    source: str,
    marker: str,
    make_candidate: Callable[[str], CodingRunResult],
) -> str:
    """Retain the longest text prefix whose fully duplicated result still fits."""

    if (
        _coding_protocol_byte_count(make_candidate(source))
        <= _MAX_CODING_PROTOCOL_LINE_BYTES
    ):
        return source
    if not source:
        return ""
    if (
        _coding_protocol_byte_count(make_candidate(marker))
        > _MAX_CODING_PROTOCOL_LINE_BYTES
    ):
        if (
            _coding_protocol_byte_count(make_candidate(""))
            <= _MAX_CODING_PROTOCOL_LINE_BYTES
        ):
            return ""
        raise FikeyaError("Coding result metadata exceeds the JSONL transport limit.")
    low = 0
    high = len(source)
    while low < high:
        midpoint = (low + high + 1) // 2
        candidate = source[:midpoint] + marker
        if (
            _coding_protocol_byte_count(make_candidate(candidate))
            <= _MAX_CODING_PROTOCOL_LINE_BYTES
        ):
            low = midpoint
        else:
            high = midpoint - 1
    return source[:low] + marker


def _bound_coding_run_result(result: CodingRunResult) -> CodingRunResult:
    """Fit one complete coding result in the desktop's one-line JSONL cap."""

    if _coding_protocol_byte_count(result) <= _MAX_CODING_PROTOCOL_LINE_BYTES:
        return result
    output_placeholder = _FINAL_OUTPUT_TRUNCATION_MARKER if result.output else ""
    plan_placeholder = _FINAL_PLAN_TRUNCATION_MARKER if result.plan else ""
    bounded = replace(
        result,
        output=output_placeholder,
        plan=plan_placeholder,
    )
    if _coding_protocol_byte_count(bounded) > _MAX_CODING_PROTOCOL_LINE_BYTES:
        source_changes = result.changed_files
        bounded = replace(bounded, changed_files=(), changed_files_truncated=True)
        if _coding_protocol_byte_count(bounded) > _MAX_CODING_PROTOCOL_LINE_BYTES:
            raise FikeyaError(
                "Coding result metadata exceeds the JSONL transport limit."
            )
        low = 0
        high = len(source_changes)
        while low < high:
            midpoint = (low + high + 1) // 2
            candidate = replace(
                bounded,
                changed_files=source_changes[:midpoint],
                changed_files_truncated=True,
            )
            if (
                _coding_protocol_byte_count(candidate)
                <= _MAX_CODING_PROTOCOL_LINE_BYTES
            ):
                low = midpoint
            else:
                high = midpoint - 1
        bounded = replace(
            bounded,
            changed_files=source_changes[:low],
            changed_files_truncated=True,
        )
    fitted_output = _fit_result_text(
        result.output,
        _FINAL_OUTPUT_TRUNCATION_MARKER,
        lambda value: replace(bounded, output=value),
    )
    bounded = replace(bounded, output=fitted_output)
    fitted_plan = _fit_result_text(
        result.plan,
        _FINAL_PLAN_TRUNCATION_MARKER,
        lambda value: replace(bounded, plan=value),
    )
    bounded = replace(bounded, plan=fitted_plan)
    if _coding_protocol_byte_count(bounded) > _MAX_CODING_PROTOCOL_LINE_BYTES:
        raise FikeyaError(
            "Coding result could not be bounded to the JSONL transport limit."
        )
    return bounded


def _approval_json(request: ApprovalRequest, call: ToolCall) -> dict[str, object]:
    return {
        "arguments": call.arguments,
        "argumentsSha256": request.arguments_sha256,
        "callId": request.call_id,
        "expectedRevision": request.expected_revision,
        "requestId": request.request_id,
        "sessionId": request.session_id,
        "summary": request.summary,
        "toolName": request.tool_name,
        "type": "approval",
    }


def _memory_evidence(
    system: str | None, memory: MemoryPreparation
) -> EvidenceContext | None:
    if (
        memory.status != "used"
        or system is None
        or memory.receipt_id is None
        or memory.response_sha256 is None
    ):
        return None
    try:
        envelope = json.loads(system.split("\n\n", 1)[1])
        content = envelope["projectContextJson"]
    except (IndexError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise FikeyaError("Qarinah returned an invalid context envelope.") from error
    if not isinstance(content, str):
        raise FikeyaError("Qarinah context envelope did not contain text.")
    digest = _normalize_hash(memory.response_sha256)
    citation = EvidenceCitation(
        memory.receipt_id, digest, f"qarinah:{memory.receipt_id}"
    )
    return EvidenceContext.from_content(content, (citation,))


def _exact_arguments(
    call: ToolCall,
    *,
    required: frozenset[str],
    optional: frozenset[str],
) -> dict[str, object]:
    arguments = call.arguments
    keys = set(arguments)
    if not required <= keys or keys - required - optional:
        raise ValueError("Tool arguments do not match the declared schema.")
    return arguments  # type: ignore[return-value]


def _required_string(
    arguments: dict[str, object], name: str, *, allow_empty: bool = False
) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ValueError(
            f"{name} must be a {'string' if allow_empty else 'non-empty string'}."
        )
    return value


def _optional_string(arguments: dict[str, object], name: str, *, default: str) -> str:
    value = arguments.get(name, default)
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string.")
    return value


def _optional_integer(arguments: dict[str, object], name: str, *, default: int) -> int:
    value = arguments.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer.")
    return value


def _required_integer(arguments: dict[str, object], name: str) -> int:
    value = arguments.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer.")
    return value


def _required_hash(arguments: dict[str, object], name: str) -> str:
    return _normalize_hash(_required_string(arguments, name))


def _normalize_hash(value: str) -> str:
    if not _SHA256_PATTERN.fullmatch(value):
        raise ValueError("SHA-256 value is invalid.")
    return value.removeprefix("sha256:")


def _read_bounded_utf8(path: Path) -> str:
    if not path.is_file():
        raise ValueError("The requested path is not a regular file.")
    payload = path.read_bytes()
    if len(payload) > _MAX_FILE_BYTES:
        raise ValueError(f"File exceeds {_MAX_FILE_BYTES} bytes.")
    return payload.decode("utf-8")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _snapshot_from_utf8_text(value: str) -> _FileSnapshot:
    payload = value.encode("utf-8")
    retain_text = len(value.splitlines(keepends=True)) <= _MAX_LINE_DELTA_LINES
    return _FileSnapshot(
        exists=True,
        sha256=hashlib.sha256(payload).hexdigest(),
        byte_count=len(payload),
        text=value if retain_text else None,
        line_delta_status="exact" if retain_text else "too-large",
    )


def _capture_file_snapshot(path: Path, *, retain_text: bool = True) -> _FileSnapshot:
    """Capture one-handle identity plus an optional bounded UTF-8 preimage."""

    try:
        named = path.lstat()
    except FileNotFoundError:
        return _FileSnapshot.missing()
    if not stat.S_ISREG(named.st_mode):
        raise ValueError("The snapshot target is not a regular file.")
    if named.st_size > _MAX_MUTATION_SCAN_FILE_BYTES:
        return _FileSnapshot.unmeasured(
            _bounded_receipt_byte_count(named.st_size), "too-large"
        )

    payload_parts: list[bytes] = []
    digest = hashlib.sha256()
    byte_count = 0
    with path.open("rb") as stream:
        opened_before = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened_before.st_mode):
            raise ValueError("The snapshot target is not a regular file.")
        if (
            opened_before.st_dev != named.st_dev
            or opened_before.st_ino != named.st_ino
            or opened_before.st_size > _MAX_MUTATION_SCAN_FILE_BYTES
        ):
            return _FileSnapshot.unmeasured(
                _bounded_receipt_byte_count(opened_before.st_size), "unavailable"
            )
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            byte_count += len(chunk)
            if byte_count > _MAX_MUTATION_SCAN_FILE_BYTES:
                return _FileSnapshot.unmeasured(None, "unavailable")
            digest.update(chunk)
            if retain_text and byte_count <= _MAX_LINE_DELTA_FILE_BYTES:
                payload_parts.append(chunk)
        opened_after = os.fstat(stream.fileno())
    if (
        byte_count != opened_before.st_size
        or opened_after.st_size != opened_before.st_size
        or opened_after.st_mtime_ns != opened_before.st_mtime_ns
        or opened_after.st_ctime_ns != opened_before.st_ctime_ns
        or opened_after.st_dev != opened_before.st_dev
        or opened_after.st_ino != opened_before.st_ino
    ):
        return _FileSnapshot.unmeasured(
            _bounded_receipt_byte_count(opened_after.st_size), "unavailable"
        )
    digest_value = digest.hexdigest()
    if byte_count > _MAX_LINE_DELTA_FILE_BYTES or not retain_text:
        return _FileSnapshot(
            exists=True,
            sha256=digest_value,
            byte_count=_bounded_receipt_byte_count(byte_count),
            text=None,
            line_delta_status=(
                "too-large"
                if byte_count > _MAX_LINE_DELTA_FILE_BYTES
                else "unavailable"
            ),
        )
    payload = b"".join(payload_parts)
    if b"\0" in payload:
        return _FileSnapshot(
            exists=True,
            sha256=digest_value,
            byte_count=len(payload),
            text=None,
            line_delta_status="binary",
        )
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return _FileSnapshot(
            exists=True,
            sha256=digest_value,
            byte_count=len(payload),
            text=None,
            line_delta_status="binary",
        )
    if len(text.splitlines(keepends=True)) > _MAX_LINE_DELTA_LINES:
        return _FileSnapshot(
            exists=True,
            sha256=digest_value,
            byte_count=len(payload),
            text=None,
            line_delta_status="too-large",
        )
    return _FileSnapshot(
        exists=True,
        sha256=digest_value,
        byte_count=len(payload),
        text=text,
        line_delta_status="exact",
    )


def _bounded_receipt_byte_count(value: int) -> int | None:
    return value if 0 <= value <= _MAX_RECEIPT_BYTE_COUNT else None


def _line_delta(
    before: _FileSnapshot, after: _FileSnapshot
) -> tuple[int | None, int | None, str]:
    if before.text is not None and after.text is not None:
        before_lines = before.text.splitlines(keepends=True)
        after_lines = after.text.splitlines(keepends=True)
        prefix = 0
        shared_length = min(len(before_lines), len(after_lines))
        while prefix < shared_length and before_lines[prefix] == after_lines[prefix]:
            prefix += 1
        suffix = 0
        remaining_before = len(before_lines) - prefix
        remaining_after = len(after_lines) - prefix
        while (
            suffix < remaining_before
            and suffix < remaining_after
            and before_lines[-(suffix + 1)] == after_lines[-(suffix + 1)]
        ):
            suffix += 1
        before_end = len(before_lines) - suffix if suffix else len(before_lines)
        after_end = len(after_lines) - suffix if suffix else len(after_lines)
        before_core = before_lines[prefix:before_end]
        after_core = after_lines[prefix:after_end]
        if not before_core or not after_core:
            return len(after_core), len(before_core), "exact"
        if len(before_core) * len(after_core) > _MAX_LINE_DELTA_SEQUENCE_CELLS:
            if set(before_core).isdisjoint(after_core):
                return len(after_core), len(before_core), "exact"
            return None, None, "too-large"
        matcher = difflib.SequenceMatcher(
            None,
            before_core,
            after_core,
            autojunk=False,
        )
        lines_added = 0
        lines_deleted = 0
        for (
            tag,
            before_start,
            before_end,
            after_start,
            after_end,
        ) in matcher.get_opcodes():
            if tag in {"replace", "delete"}:
                lines_deleted += before_end - before_start
            if tag in {"replace", "insert"}:
                lines_added += after_end - after_start
        return lines_added, lines_deleted, "exact"

    statuses = {before.line_delta_status, after.line_delta_status}
    if "binary" in statuses:
        return None, None, "binary"
    if "too-large" in statuses:
        return None, None, "too-large"
    return None, None, "unavailable"


def _changed_file_receipt(
    relative: str, before: _FileSnapshot, after: _FileSnapshot
) -> ChangedFileReceipt:
    if not before.exists and after.exists:
        operation = "add"
    elif before.exists and not after.exists:
        operation = "delete"
    elif before.exists and after.exists:
        operation = "edit"
    else:
        raise ValueError("A changed-file receipt requires a before or after identity.")
    lines_added, lines_deleted, line_delta_status = _line_delta(before, after)
    return ChangedFileReceipt(
        path=relative,
        before_exists=before.exists,
        after_exists=after.exists,
        before_sha256=(
            f"sha256:{before.sha256}" if before.sha256 is not None else None
        ),
        after_sha256=(f"sha256:{after.sha256}" if after.sha256 is not None else None),
        operation=operation,
        before_bytes=before.byte_count,
        after_bytes=after.byte_count,
        lines_added=lines_added,
        lines_deleted=lines_deleted,
        line_delta_status=line_delta_status,
    )


def _snapshots_equal(left: _FileSnapshot, right: _FileSnapshot) -> bool:
    if left.exists != right.exists:
        return False
    if not left.exists:
        return True
    return (
        left.sha256 is not None
        and right.sha256 is not None
        and left.sha256 == right.sha256
    )


def _measured_mutation_paths(
    before: dict[str, _FileSnapshot],
    after: dict[str, _FileSnapshot],
    *,
    before_complete: bool,
    after_complete: bool,
    before_incomplete_scopes: frozenset[str] = frozenset(),
    after_incomplete_scopes: frozenset[str] = frozenset(),
) -> list[str]:
    measured: list[str] = []
    for relative in sorted(before.keys() | after.keys()):
        before_value = before.get(relative)
        after_value = after.get(relative)
        # An unrelated unreadable subtree must not hide a known regular-file
        # mutation. Absence is ambiguous only inside the scope that failed.
        before_ambiguous = before_value is None and (
            _path_in_incomplete_scope(relative, before_incomplete_scopes)
            or (not before_complete and not before_incomplete_scopes)
        )
        after_ambiguous = after_value is None and (
            _path_in_incomplete_scope(relative, after_incomplete_scopes)
            or (not after_complete and not after_incomplete_scopes)
        )
        if before_ambiguous or after_ambiguous:
            continue
        before_value = before_value or _FileSnapshot.missing()
        after_value = after_value or _FileSnapshot.missing()
        if before_value.exists != after_value.exists:
            measured.append(relative)
            continue
        if not before_value.exists:
            continue
        if before_value.sha256 is not None and after_value.sha256 is not None:
            if before_value.sha256 != after_value.sha256:
                measured.append(relative)
            continue
        if before_value.byte_count != after_value.byte_count:
            measured.append(relative)
    return measured


def _path_in_incomplete_scope(relative: str, scopes: frozenset[str]) -> bool:
    return any(
        not scope or relative == scope or relative.startswith(f"{scope}/")
        for scope in scopes
    )


def _run_bounded_git(
    root: Path,
    arguments: list[str],
    *,
    maximum_output_bytes: int,
    stdin_bytes: bytes | None = None,
) -> bytes | None:
    """Run a read-only Git query with bounded time, output, and environment."""

    if not (root / ".git").exists():
        return None
    try:
        executable = _resolve_trusted_executable("git", workspace_root=root)
    except FikeyaError:
        return None
    environment = _minimal_environment()
    environment.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    try:
        process = subprocess.Popen(
            [
                executable,
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.quotepath=false",
                *arguments,
            ],
            cwd=root,
            stdin=subprocess.PIPE if stdin_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError:
        return None

    output = bytearray()
    overflow = threading.Event()

    def read_output() -> None:
        assert process.stdout is not None
        try:
            while True:
                chunk = process.stdout.read(65_536)
                if not chunk:
                    return
                remaining = maximum_output_bytes + 1 - len(output)
                if remaining > 0:
                    output.extend(chunk[:remaining])
                if len(output) > maximum_output_bytes or len(chunk) > remaining:
                    overflow.set()
                    return
        finally:
            process.stdout.close()

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    write_failed = threading.Event()
    writer: threading.Thread | None = None
    if stdin_bytes is not None:
        assert process.stdin is not None

        def write_input() -> None:
            assert process.stdin is not None
            try:
                process.stdin.write(stdin_bytes)
            except (OSError, ValueError):
                write_failed.set()
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    write_failed.set()

        writer = threading.Thread(target=write_input, daemon=True)
        writer.start()
    deadline = time.monotonic() + _GIT_PRIORITY_TIMEOUT_SECONDS
    timed_out = False
    while (
        process.poll() is None
        and not overflow.is_set()
        and not write_failed.is_set()
    ):
        if time.monotonic() >= deadline:
            timed_out = True
            break
        time.sleep(0.01)
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    reader.join(timeout=0.5)
    if writer is not None:
        writer.join(timeout=0.5)
    if reader.is_alive():
        if process.stdout is not None:
            process.stdout.close()
        reader.join(timeout=0.25)
    if writer is not None and writer.is_alive():
        if process.stdin is not None:
            process.stdin.close()
        writer.join(timeout=0.25)
    if (
        timed_out
        or write_failed.is_set()
        or overflow.is_set()
        or reader.is_alive()
        or (writer is not None and writer.is_alive())
        or process.returncode != 0
    ):
        return None
    return bytes(output)


def _safe_git_relative_path(encoded: bytes) -> Path | None:
    relative = Path(os.fsdecode(encoded))
    if (
        relative.is_absolute()
        or any(part in {"", ".", ".."} for part in relative.parts)
        or any(_is_mutation_excluded_directory(part) for part in relative.parts[:-1])
    ):
        return None
    return relative


def _git_worktree_view(root: Path) -> _GitWorktreeView:
    """Read a complete bounded porcelain view for priority and reconciliation."""

    output = _run_bounded_git(
        root,
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--ignored=no",
            "--",
            ".",
        ],
        maximum_output_bytes=_MAX_GIT_PRIORITY_OUTPUT_BYTES,
    )
    if output is None:
        return _GitWorktreeView(False, False, None, (), {})

    records = output.split(b"\0")
    paths: set[Path] = set()
    baseline_oids: dict[str, str | None] = {}
    head_oid: str | None = None
    complete = True
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if record.startswith(b"# branch.oid "):
            candidate = record.removeprefix(b"# branch.oid ").decode(
                "ascii", errors="ignore"
            )
            if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", candidate):
                head_oid = candidate
            continue
        if record.startswith(b"# "):
            continue
        if record.startswith(b"1 "):
            fields = record.split(b" ", 8)
            if len(fields) != 9:
                complete = False
                continue
            relative = _safe_git_relative_path(fields[8])
            if relative is None:
                continue
            baseline = fields[6].decode("ascii", errors="ignore")
            paths.add(relative)
            baseline_oids[relative.as_posix()] = (
                baseline
                if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", baseline)
                and set(baseline) != {"0"}
                else None
            )
            continue
        if record.startswith(b"2 "):
            fields = record.split(b" ", 9)
            if len(fields) != 10 or index >= len(records):
                complete = False
                continue
            current = _safe_git_relative_path(fields[9])
            original = _safe_git_relative_path(records[index])
            index += 1
            baseline = fields[6].decode("ascii", errors="ignore")
            baseline_value = (
                baseline
                if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", baseline)
                and set(baseline) != {"0"}
                else None
            )
            if current is not None:
                paths.add(current)
                baseline_oids[current.as_posix()] = None
            if original is not None:
                paths.add(original)
                baseline_oids[original.as_posix()] = baseline_value
            continue
        if record.startswith(b"? "):
            relative = _safe_git_relative_path(record[2:])
            if relative is not None:
                paths.add(relative)
                baseline_oids[relative.as_posix()] = None
            continue
        # Unmerged or unknown records cannot support baseline reconstruction.
        complete = False

    ordered = tuple(sorted(paths, key=_mutation_priority_path_sort_key))
    return _GitWorktreeView(True, complete, head_oid, ordered, baseline_oids)


def _mutation_priority_path_sort_key(path: Path) -> tuple[int, int, str, str]:
    value = path.as_posix()
    source_priority = any(
        part.casefold() in _MUTATION_SOURCE_PRIORITY_DIRECTORIES
        for part in path.parts[:-1]
    )
    return (0 if source_priority else 1, len(path.parts), value.casefold(), value)


def _git_blob_snapshots(root: Path, object_ids: set[str]) -> dict[str, _FileSnapshot]:
    valid_ids = sorted(
        value
        for value in object_ids
        if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value)
    )
    if not valid_ids:
        return {}
    output = _run_bounded_git(
        root,
        ["cat-file", "--batch"],
        maximum_output_bytes=_MAX_GIT_BASELINE_OUTPUT_BYTES,
        stdin_bytes=("\n".join(valid_ids) + "\n").encode("ascii"),
    )
    if output is None:
        return {}

    snapshots: dict[str, _FileSnapshot] = {}
    offset = 0
    for expected in valid_ids:
        header_end = output.find(b"\n", offset)
        if header_end < 0:
            return {}
        fields = output[offset:header_end].split(b" ")
        if len(fields) != 3 or fields[1] != b"blob":
            return {}
        returned = fields[0].decode("ascii", errors="ignore")
        try:
            size = int(fields[2])
        except ValueError:
            return {}
        content_start = header_end + 1
        content_end = content_start + size
        if returned != expected or content_end >= len(output):
            return {}
        content = output[content_start:content_end]
        if output[content_end : content_end + 1] != b"\n":
            return {}
        snapshots[expected] = _FileSnapshot(
            exists=True,
            sha256=hashlib.sha256(content).hexdigest(),
            byte_count=size,
            text=None,
            line_delta_status="unavailable",
        )
        offset = content_end + 1
    return snapshots


def _reconcile_git_snapshot_boundaries(
    root: Path,
    before: dict[str, _FileSnapshot],
    after: dict[str, _FileSnapshot],
) -> None:
    """Recover a clean tracked pre-state that fell beyond the filesystem cap."""

    if not isinstance(before, _WorkspaceFileSnapshot) or not isinstance(
        after, _WorkspaceFileSnapshot
    ):
        return
    # Anything measured before has an exact lexical path we can recheck after the
    # process. This closes the dirty-to-clean and untracked-to-deleted cap cases
    # without assuming that absence from Git status means filesystem absence.
    for relative, before_value in tuple(before.items()):
        if relative in after or before_value.sha256 is None:
            continue
        candidate = root / Path(relative)
        try:
            after[relative] = _capture_file_snapshot(candidate, retain_text=False)
        except ValueError:
            # A former regular file that is now absent or non-regular is absent
            # from the declared regular-file content scope.
            after[relative] = _FileSnapshot.missing()
        except OSError:
            # Leave the path absent so the enclosing incomplete scope suppresses
            # a claim when the current identity cannot be read safely.
            continue

    before_view = before.git_view
    after_view = after.git_view
    if (
        not before_view.available
        or not after_view.available
        or not before_view.complete
        or not after_view.complete
        or before_view.head_oid is None
        or before_view.head_oid != after_view.head_oid
    ):
        return

    before_dirty = {path.as_posix() for path in before_view.paths}
    required: dict[str, str] = {}
    for relative, baseline_oid in after_view.baseline_oids.items():
        if relative in before or relative in before_dirty:
            continue
        if baseline_oid is None:
            before[relative] = _FileSnapshot.missing()
        else:
            required[relative] = baseline_oid
    baselines = _git_blob_snapshots(root, set(required.values()))
    for relative, object_id in required.items():
        baseline = baselines.get(object_id)
        if baseline is not None:
            before[relative] = baseline


def _candidate_files(root: Path) -> list[Path]:
    values: list[Path] = []
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(
            name for name in directories if not _is_ignored_directory(name)
        )
        values.extend(Path(directory) / name for name in sorted(files))
        if len(values) >= _MAX_LISTED_FILES:
            break
    return values[:_MAX_LISTED_FILES]


def _workspace_file_snapshot(
    workspace: Workspace,
) -> tuple[dict[str, _FileSnapshot], bool, bool, frozenset[str]]:
    """Hash the bounded regular-project-file content scope around a process.

    Tool-managed dependency, virtual-environment, build, coverage, and cache trees
    are outside this scope. Source-shaped directories are traversed first so the
    global cap protects the files most likely to contain authored project code.
    """

    git_view = _git_worktree_view(workspace.root)
    values: dict[str, _FileSnapshot] = _WorkspaceFileSnapshot(git_view)
    scanned_bytes = 0
    retained_text_bytes = 0
    paths_complete = True
    evidence_complete = True
    incomplete_scopes: set[str] = set()

    def incomplete_scope(path: object) -> str:
        if not isinstance(path, (str, os.PathLike)):
            return ""
        try:
            candidate = Path(path)
            relative = candidate.relative_to(workspace.root).as_posix()
        except (OSError, ValueError):
            return ""
        return "" if relative == "." else relative

    def mark_walk_error(error: OSError) -> None:
        nonlocal paths_complete, evidence_complete
        paths_complete = False
        evidence_complete = False
        incomplete_scopes.add(incomplete_scope(error.filename))

    def scan_candidate(candidate: Path, *, optional: bool) -> bool:
        nonlocal paths_complete, evidence_complete, scanned_bytes
        nonlocal retained_text_bytes
        try:
            lexical_relative = candidate.relative_to(workspace.root).as_posix()
        except ValueError:
            if optional:
                return True
            paths_complete = False
            evidence_complete = False
            incomplete_scopes.add("")
            return True
        if lexical_relative in values:
            return True
        if len(values) >= _MAX_MUTATION_SCAN_FILES:
            return False
        try:
            if _path_is_link_like(candidate):
                evidence_complete = False
                values[lexical_relative] = _FileSnapshot.unmeasured(None, "unavailable")
                return True
            resolved = workspace.boundary.resolve(
                candidate.relative_to(workspace.root), must_exist=True
            )
            if not resolved.is_file():
                return True
            size = candidate.lstat().st_size
            if size > _MAX_MUTATION_SCAN_FILE_BYTES:
                values[lexical_relative] = _FileSnapshot.unmeasured(
                    _bounded_receipt_byte_count(size), "too-large"
                )
                evidence_complete = False
                return True
            if scanned_bytes + size > _MAX_MUTATION_SCAN_TOTAL_BYTES:
                values[lexical_relative] = _FileSnapshot.unmeasured(
                    _bounded_receipt_byte_count(size), "unavailable"
                )
                evidence_complete = False
                return True
            retain_text = (
                size <= _MAX_LINE_DELTA_FILE_BYTES
                and retained_text_bytes + size <= _MAX_LINE_DELTA_SNAPSHOT_BYTES
            )
            snapshot = _capture_file_snapshot(resolved, retain_text=retain_text)
            if not snapshot.exists:
                paths_complete = False
                evidence_complete = False
                incomplete_scopes.add(lexical_relative)
                return True
            values[lexical_relative] = snapshot
            scanned_bytes += snapshot.byte_count or size
            if snapshot.sha256 is None:
                evidence_complete = False
            if snapshot.text is not None:
                retained_text_bytes += snapshot.byte_count or 0
        except FileNotFoundError:
            if optional:
                values[lexical_relative] = _FileSnapshot.missing()
            else:
                paths_complete = False
                evidence_complete = False
                incomplete_scopes.add(lexical_relative)
        except (FikeyaError, OSError, ValueError):
            paths_complete = False
            evidence_complete = False
            incomplete_scopes.add(lexical_relative)
        return True

    for relative in git_view.paths:
        if not scan_candidate(workspace.root / relative, optional=True):
            return values, False, False, frozenset({""})

    for directory, directories, files in os.walk(
        workspace.root, followlinks=False, onerror=mark_walk_error
    ):
        safe_directories: list[str] = []
        for name in sorted(directories, key=_mutation_scan_directory_sort_key):
            if _is_mutation_excluded_directory(name):
                continue
            try:
                if _path_is_link_like(Path(directory) / name):
                    if len(values) >= _MAX_MUTATION_SCAN_FILES:
                        return values, False, False, frozenset({""})
                    evidence_complete = False
                    relative = (
                        (Path(directory) / name).relative_to(workspace.root).as_posix()
                    )
                    values[relative] = _FileSnapshot.unmeasured(None, "unavailable")
                    continue
            except OSError:
                paths_complete = False
                evidence_complete = False
                incomplete_scopes.add(
                    (Path(directory) / name).relative_to(workspace.root).as_posix()
                )
                continue
            safe_directories.append(name)
        directories[:] = safe_directories
        for name in sorted(files):
            if not scan_candidate(Path(directory) / name, optional=False):
                return values, False, False, frozenset({""})
    return values, paths_complete, evidence_complete, frozenset(incomplete_scopes)


def _path_is_link_like(path: Path) -> bool:
    metadata = path.lstat()
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    file_attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(
        reparse_flag and file_attributes & reparse_flag
    )


def _is_ignored_directory(name: str) -> bool:
    return name.casefold() in _IGNORED_DIRECTORIES_CASEFOLDED


def _is_mutation_excluded_directory(name: str) -> bool:
    normalized = name.casefold()
    return (
        normalized in _IGNORED_DIRECTORIES_CASEFOLDED
        or normalized in _MUTATION_EXCLUDED_DIRECTORIES_CASEFOLDED
        or normalized.endswith(".egg-info")
    )


def _mutation_scan_directory_sort_key(name: str) -> tuple[int, str, str]:
    normalized = name.casefold()
    return (
        0 if normalized in _MUTATION_SOURCE_PRIORITY_DIRECTORIES else 1,
        normalized,
        name,
    )


def _is_unittest_command(arguments: list[str]) -> bool:
    """Return whether ``python -m unittest`` selects and executes tests."""

    tokens = [argument.casefold() for argument in arguments]
    informational = {
        "--co",
        "--collect-only",
        "--help",
        "--list-tests",
        "--version",
        "-h",
    }
    if any(token in informational for token in tokens):
        return False
    discover = bool(tokens) and tokens[0] == "discover"
    if discover:
        tokens = tokens[1:]

    flags = {
        "--buffer",
        "--catch",
        "--failfast",
        "--locals",
        "--quiet",
        "--verbose",
        "-b",
        "-c",
        "-f",
        "-q",
        "-v",
    }
    value_options = (
        {
            "--pattern",
            "--start-directory",
            "--top-level-directory",
            "-k",
            "-p",
            "-s",
            "-t",
        }
        if discover
        else {"-k"}
    )
    long_value_options = {option for option in value_options if option.startswith("--")}
    positional_count = 0
    options_ended = False
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if options_ended:
            positional_count += 1
            index += 1
            continue
        if token == "--":
            options_ended = True
            index += 1
            continue
        if token in flags or (
            token.startswith("-")
            and not token.startswith("--")
            and len(token) > 2
            and set(token[1:]) <= set("vqfcb")
        ):
            index += 1
            continue
        if token in value_options:
            if index + 1 >= len(tokens) or tokens[index + 1] == "--":
                return False
            index += 2
            continue
        if token.startswith("-k") and token != "-k":
            index += 1
            continue
        if any(
            token.startswith(f"{option}=") and len(token) > len(option) + 1
            for option in long_value_options
        ):
            index += 1
            continue
        if token.startswith("-"):
            return False
        positional_count += 1
        index += 1

    # Discovery accepts start, pattern, and top-level directory positionally.
    return not discover or positional_count <= 3


def _is_test_command(executable: str, arguments: list[str]) -> bool:
    normalized = Path(executable).stem.lower()
    if normalized not in _TEST_EXECUTABLES:
        return False
    tokens = [argument.casefold() for argument in arguments]
    if normalized in _DEDICATED_TEST_EXECUTABLES:
        informational_only = {
            "ctest": {
                "-n",
                "--help",
                "--list-presets",
                "--print-labels",
                "--show-only",
                "--version",
            },
            "jest": {"--help", "--listtests", "--showconfig", "--version"},
            "pytest": {
                "--co",
                "--collect-only",
                "--fixtures",
                "--fixtures-per-test",
                "--funcargs",
                "--help",
                "--markers",
                "--setup-only",
                "--setup-plan",
                "--trace-config",
                "--version",
                "-h",
            },
            "vitest": {"--help", "--list", "--version", "list"},
        }[normalized]
        informational_prefixes = {
            "ctest": ("--show-only=",),
            "jest": ("--listtests=", "--showconfig="),
            "pytest": (
                "--collect-only=",
                "--fixtures=",
                "--fixtures-per-test=",
            ),
            "vitest": ("--list=",),
        }[normalized]
        return not any(
            token in informational_only
            or any(token.startswith(prefix) for prefix in informational_prefixes)
            for token in tokens
        )
    if normalized in {"cargo", "go", "dotnet"}:
        if not tokens or tokens[0] != "test":
            return False
        non_executing = {
            "cargo": {"--no-run"},
            "dotnet": {"--list-tests", "-t"},
            "go": {"-list"},
        }[normalized]
        if any(token in non_executing for token in tokens[1:]):
            return False
        if (
            normalized == "cargo"
            and "--" in tokens
            and "--list" in tokens[tokens.index("--") + 1 :]
        ):
            return False
        return not (
            normalized == "go"
            and any(token.startswith("-list=") for token in tokens[1:])
        )
    if normalized in {"gradle", "gradlew"}:
        return not any(token in {"--dry-run", "-m"} for token in tokens) and any(
            token == "test" or token.endswith(":test") for token in tokens
        )
    if normalized in {"mvn", "mvnw"}:
        skipped = any(
            token in {
                "-dskiptests",
                "-dskiptests=true",
                "-dmaven.test.skip=true",
            }
            for token in tokens
        )
        return not skipped and any(token in {"test", "verify"} for token in tokens)
    if normalized in {"npm", "pnpm", "yarn", "bun"}:
        if not tokens or tokens[0].startswith("-"):
            return False
        if tokens[0] == "test" or tokens[0].startswith("test:"):
            return True
        return (
            len(tokens) >= 2
            and tokens[0] in {"run", "run-script"}
            and (tokens[1] == "test" or tokens[1].startswith("test:"))
        )
    if normalized == "npx":
        if not tokens or tokens[0].startswith("-"):
            return False
        return _is_test_command(Path(arguments[0]).stem, arguments[1:]) or (
            Path(tokens[0]).stem == "playwright" and tokens[1:2] == ["test"]
        )
    if normalized in {"python", "python3"}:
        if len(tokens) >= 2 and tokens[0] == "-m":
            if Path(arguments[1]).stem.casefold() == "unittest":
                return _is_unittest_command(arguments[2:])
            return _is_test_command(Path(arguments[1]).stem, arguments[2:])
        return False
    if normalized == "uv":
        return (
            len(arguments) >= 2
            and tokens[0] == "run"
            and not tokens[1].startswith("-")
            and _is_test_command(Path(arguments[1]).stem, arguments[2:])
        )
    return False


def _safe_error(error: Exception) -> str:
    message = str(error).replace(str(Path.home()), "<home>")
    return message[:2_048] or type(error).__name__
