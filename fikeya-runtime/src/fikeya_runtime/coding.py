# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Integrated, approval-gated coding loop built on Fikeya Agent Core."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fikeya_agent_core import (
    AgentLimits,
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

from .agent import AgentRunner, MemoryPreparation, MemoryProvider
from .browser import BrowserActionResult, BrowserEngine, BrowserSession
from .conversation import ConversationTurn, build_conversation_prompt
from .credentials import CredentialResolver
from .errors import ApprovalError, FikeyaError, ProviderOutputLimitError
from .events import EventType
from .inference import (
    InferenceImage,
    InferenceRequest,
    ProviderCallResult,
    ProviderExecutor,
    provider_request_fingerprint,
)
from .mcp_broker import McpBrokerRegistry
from .modes import AgentMode, ModePolicy, mode_policy
from .providers import ProviderProfile, ProviderStore
from .qarinah import select_qarinah_adapter
from .state import StateStore
from .tools import ApprovalLedger, ToolBroker, ToolRequest
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
    {".fikeya", ".git", ".hg", ".svn", "__pycache__", "node_modules"}
)
_IGNORED_DIRECTORIES_CASEFOLDED = frozenset(
    value.casefold() for value in _IGNORED_DIRECTORIES
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
_SHA256_PATTERN = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
_MAX_FILE_BYTES = 1_048_576
_MAX_LISTED_FILES = 1_000
_MAX_SEARCH_RESULTS = 200
_MAX_SEARCH_BYTES = 32 * 1024 * 1024
_MAX_MUTATION_SCAN_FILES = 5_000
_MAX_MUTATION_SCAN_FILE_BYTES = 16 * 1024 * 1024
_MAX_MUTATION_SCAN_TOTAL_BYTES = 256 * 1024 * 1024
_MAX_RECORDED_MUTATIONS = 1_000


@dataclass(frozen=True, slots=True)
class ToolExecutionReceipt:
    """Content-free result metadata for one approved tool execution."""

    call_id: str
    name: str
    status: str
    arguments_sha256: str
    output_sha256: str
    duration_ms: int | None = None
    exit_code: int | None = None
    test: bool = False

    def as_json(self) -> dict[str, object]:
        return {
            "argumentsSha256": self.arguments_sha256,
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
    """Before/after identity for one file changed by an approved operation."""

    path: str
    before_sha256: str | None
    after_sha256: str | None

    def as_json(self) -> dict[str, object]:
        return {
            "afterSha256": self.after_sha256,
            "beforeSha256": self.before_sha256,
            "path": self.path,
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

    def as_json(self) -> dict[str, object]:
        tests = [receipt.as_json() for receipt in self.tool_calls if receipt.test]
        return {
            "callId": self.provider_call_ids[-1],
            "changedFiles": [receipt.as_json() for receipt in self.changed_files],
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
                "plan": self.plan,
                "steps": self.steps,
                "summary": self.output,
                "tests": tests,
                "toolCalls": [receipt.as_json() for receipt in self.tool_calls],
            },
            "output": self.output,
            "providerCallIds": list(self.provider_call_ids),
            "sessionId": self.session_id,
            "status": self.status,
            "usage": self.usage,
        }


@dataclass(slots=True)
class _BrokerState:
    receipts: list[ToolExecutionReceipt] = field(default_factory=list)
    changed_files: dict[str, ChangedFileReceipt] = field(default_factory=dict)
    results: dict[str, ToolResult] = field(default_factory=dict)


class WorkspaceExecutionBroker:
    """Typed workspace and process operations behind Agent Core approvals."""

    def __init__(
        self,
        workspace: Workspace,
        *,
        allowed_executables: frozenset[str] = _DEFAULT_ALLOWED_EXECUTABLES,
        allowed_tools: frozenset[str] | None = None,
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
        self.allowed_tools = allowed_tools
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
        available = [
            tool
            for tool in tools
            if self.mode_policy.allows(tool.name)
            and (self.allowed_tools is None or tool.name in self.allowed_tools)
        ]
        mcp_permitted = self.allowed_tools is None or any(
            name.startswith("mcp.") for name in self.allowed_tools
        )
        if self.mode_policy.mode in _MCP_AGENT_MODES and mcp_permitted:
            mcp_tools = await self._mcp.list_tools(cancellation)
            available.extend(
                tool
                for tool in mcp_tools
                if self.allowed_tools is None or tool.name in self.allowed_tools
            )
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
                    arguments_sha256=sha256_text(stable_json(call.arguments)),
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
        cancellation.raise_if_cancelled()
        self.state.results[idempotency_key] = result
        if not any(item.call_id == call.call_id for item in self.state.receipts):
            self.state.receipts.append(
                ToolExecutionReceipt(
                    arguments_sha256=sha256_text(stable_json(call.arguments)),
                    call_id=call.call_id,
                    name=call.name,
                    status=result.status,
                    output_sha256=sha256_text(result.output),
                    test=False,
                )
            )
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
        if self.allowed_tools is not None and name not in self.allowed_tools:
            return False
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
            before = _file_sha256(target) if target.exists() else None
            relative = target.relative_to(self.workspace.root).as_posix()
            result = session.screenshot(relative)
            after = _file_sha256(target)
            self.state.changed_files[relative] = ChangedFileReceipt(
                path=relative,
                before_sha256=(f"sha256:{before}" if before is not None else None),
                after_sha256=f"sha256:{after}",
            )
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
        cancellation.raise_if_cancelled()
        return ToolResult(
            call.call_id, "ok", stable_json(result.as_json()), "application/json"
        )

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
        output = stable_json(
            {"files": values, "truncated": len(values) >= _MAX_LISTED_FILES}
        )
        return ToolResult(call.call_id, "ok", output, "application/json")

    def _read_file(self, call: ToolCall) -> ToolResult:
        arguments = _exact_arguments(
            call,
            required=frozenset({"path"}),
            optional=frozenset({"endLine", "startLine"}),
        )
        path = self._file(_required_string(arguments, "path"), must_exist=True)
        payload = _read_bounded_utf8(path)
        lines = payload.splitlines(keepends=True)
        start = _optional_integer(arguments, "startLine", default=1)
        end = _optional_integer(arguments, "endLine", default=max(1, len(lines)))
        if start < 1 or end < start:
            raise ValueError("The requested line range is invalid.")
        selected = "".join(lines[start - 1 : end])
        output = stable_json(
            {
                "content": selected,
                "endLine": min(end, len(lines)),
                "path": path.relative_to(self.workspace.root).as_posix(),
                "sha256": f"sha256:{_file_sha256(path)}",
                "startLine": start,
                "totalLines": len(lines),
            }
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
        output = stable_json({"matches": matches, "truncated": truncated})
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
        before = _file_sha256(path)
        if before != expected:
            raise ValueError(
                "File changed after it was inspected; read it again before editing."
            )
        if current.count(old_text) != 1:
            raise ValueError("oldText must match exactly one occurrence.")
        updated = current.replace(old_text, new_text, 1)
        self._atomic_write(path, updated)
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
        before = _file_sha256(path) if path.exists() else None
        if path.exists() and not path.is_file():
            raise ValueError("The write target is not a regular file.")
        if before != expected:
            raise ValueError(
                "Write precondition failed; inspect the current file before replacing it."
            )
        self._atomic_write(path, content)
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
        before_snapshot, before_snapshot_complete = _workspace_file_snapshot(
            self.workspace
        )
        request = ToolRequest(
            (executable, *values), cwd=cwd, timeout_seconds=float(timeout)
        )
        token = self._process_broker.approve(
            request, ttl_seconds=max(1.0, min(600.0, float(timeout) + 10))
        )
        outcome = self._process_broker.execute(
            request,
            dry_run=False,
            approval_token=token,
            cancellation_requested=lambda: cancellation.cancelled,
        )
        after_snapshot, after_snapshot_complete = _workspace_file_snapshot(
            self.workspace
        )
        mutated_paths = sorted(
            path
            for path in before_snapshot.keys() | after_snapshot.keys()
            if before_snapshot.get(path) != after_snapshot.get(path)
        )
        recorded_mutations = mutated_paths[:_MAX_RECORDED_MUTATIONS]
        for relative_path in recorded_mutations:
            before_hash = before_snapshot.get(relative_path)
            after_hash = after_snapshot.get(relative_path)
            existing = self.state.changed_files.get(relative_path)
            original_before = (
                existing.before_sha256
                if existing is not None
                else f"sha256:{before_hash}"
                if before_hash is not None
                else None
            )
            final_after = f"sha256:{after_hash}" if after_hash is not None else None
            if original_before == final_after:
                self.state.changed_files.pop(relative_path, None)
                continue
            self.state.changed_files[relative_path] = ChangedFileReceipt(
                path=relative_path,
                before_sha256=original_before,
                after_sha256=final_after,
            )
        output = stable_json(
            {
                "durationMs": outcome.duration_ms,
                "exitCode": outcome.exit_code,
                "stderr": outcome.stderr,
                "stdout": outcome.stdout,
                "truncated": outcome.truncated,
                "workspaceMutations": {
                    "complete": before_snapshot_complete
                    and after_snapshot_complete
                    and len(mutated_paths) <= _MAX_RECORDED_MUTATIONS,
                    "paths": recorded_mutations,
                    "truncated": len(mutated_paths) > _MAX_RECORDED_MUTATIONS,
                },
            }
        )
        test = _is_test_command(executable, values)
        receipt = ToolExecutionReceipt(
            arguments_sha256=sha256_text(stable_json(call.arguments)),
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

    def _file(self, relative: str, *, must_exist: bool) -> Path:
        if not relative or relative == ".":
            raise ValueError("A file path is required.")
        path = self.workspace.boundary.resolve(relative, must_exist=must_exist)
        if any(
            part.casefold() == ".fikeya"
            for part in path.relative_to(self.workspace.root).parts
        ):
            raise ValueError("Fikeya metadata is not an editable project file.")
        return path

    def _atomic_write(self, path: Path, content: str) -> None:
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
            if path.exists():
                os.chmod(temporary_name, path.stat().st_mode)
            os.replace(temporary_name, path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)

    def _changed_result(
        self, call: ToolCall, path: Path, before: str | None
    ) -> ToolResult:
        after = _file_sha256(path)
        relative = path.relative_to(self.workspace.root).as_posix()
        self.state.changed_files[relative] = ChangedFileReceipt(
            path=relative,
            before_sha256=f"sha256:{before}" if before is not None else None,
            after_sha256=f"sha256:{after}",
        )
        output = stable_json(
            {
                "afterSha256": f"sha256:{after}",
                "beforeSha256": f"sha256:{before}" if before is not None else None,
                "path": relative,
            }
        )
        return ToolResult(call.call_id, "ok", output, "application/json")


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
        if (
            usage.measurement == "provider-reported"
            and usage.output_tokens is not None
            and usage.output_tokens > request.max_output_tokens
        ):
            raise ProviderOutputLimitError()
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
        self.allowed_executables = (
            _DEFAULT_ALLOWED_EXECUTABLES
            if allowed_executables is None
            else allowed_executables
        )
        self.mcp_registry_factory = mcp_registry_factory or McpBrokerRegistry

    async def run(
        self,
        *,
        provider_name: str,
        prompt: str,
        allow_network: bool,
        timeout: float,
        max_output_tokens: int,
        max_steps: int = 32,
        allowed_tools: frozenset[str] | None = None,
        session_id: str | None = None,
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
        memory_provider: MemoryProvider | None = None,
        allow_discovered_memory: bool = True,
    ) -> CodingRunResult:
        """Run a complete reviewed loop, pausing for each exact approval."""

        policy = mode_policy(mode)
        broker: WorkspaceExecutionBroker | None = None
        profile = self.providers.get(provider_name)
        session = self.state.create_session(
            session_id=session_id,
            metadata={
                "mode": "coding-agent",
                "agentMode": policy.mode.value,
                "model": profile.model,
                "provider": profile.name,
                "priorConversationTurns": len(history),
            },
        )
        selected_memory = memory_provider
        if selected_memory is None and allow_discovered_memory and memory_mode != "off":
            selected_memory = select_qarinah_adapter(
                workspace_root=self.workspace.root, state=self.state
            )
        memory_runner = AgentRunner(
            self.workspace,
            self.providers,
            executor=self.executor,
            credentials=self.credentials,
            memory=selected_memory,
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
            )
            broker = WorkspaceExecutionBroker(
                self.workspace,
                allowed_executables=self.allowed_executables,
                allowed_tools=allowed_tools,
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
                    max_steps=max_steps,
                    max_output_bytes=maximum_output_bytes,
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
            else:
                self.state.cancel_session(
                    session.session_id, current.failure_code or current.stage.value
                )
            return _result(current, memory, recording, broker)
        except Exception as error:
            try:
                if self.state.get_session(session.session_id).status == "active":
                    self.state.cancel_session(session.session_id, "coding loop failed")
            except Exception as cleanup_error:  # noqa: BLE001 - preserve primary error.
                error.add_note(
                    f"Session cleanup also failed with {type(cleanup_error).__name__}."
                )
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
) -> CodingRunResult:
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
    return CodingRunResult(
        session_id=state.session_id,
        status=status,
        output=state.final_output or "",
        plan=state.plan,
        steps=state.step_count,
        memory=memory,
        provider_call_ids=tuple(recording.call_ids),
        usage=usage,
        tool_calls=tuple(broker.state.receipts),
        changed_files=tuple(
            sorted(broker.state.changed_files.values(), key=lambda item: item.path)
        ),
    )


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


def _workspace_file_snapshot(workspace: Workspace) -> tuple[dict[str, str], bool]:
    """Hash a bounded project view before and after an approved process execution."""

    values: dict[str, str] = {}
    scanned_bytes = 0
    complete = True
    for directory, directories, files in os.walk(workspace.root, followlinks=False):
        directories[:] = sorted(
            name for name in directories if not _is_ignored_directory(name)
        )
        for name in sorted(files):
            if len(values) >= _MAX_MUTATION_SCAN_FILES:
                return values, False
            candidate = Path(directory) / name
            try:
                resolved = workspace.boundary.resolve(
                    candidate.relative_to(workspace.root), must_exist=True
                )
                if not resolved.is_file():
                    continue
                size = resolved.stat().st_size
                if (
                    size > _MAX_MUTATION_SCAN_FILE_BYTES
                    or scanned_bytes + size > _MAX_MUTATION_SCAN_TOTAL_BYTES
                ):
                    complete = False
                    continue
                relative = resolved.relative_to(workspace.root).as_posix()
                values[relative] = _file_sha256(resolved)
                scanned_bytes += size
            except (FikeyaError, OSError, ValueError):
                complete = False
    return values, complete


def _is_ignored_directory(name: str) -> bool:
    return name.casefold() in _IGNORED_DIRECTORIES_CASEFOLDED


def _is_test_command(executable: str, arguments: list[str]) -> bool:
    normalized = Path(executable).stem.lower()
    if normalized not in _TEST_EXECUTABLES:
        return False
    joined = " ".join(arguments).lower()
    return (
        normalized == "pytest"
        or "test" in joined
        or "pytest" in joined
        or "assert " in joined
    )


def _safe_error(error: Exception) -> str:
    message = str(error).replace(str(Path.home()), "<home>")
    return message[:2_048] or type(error).__name__
