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

from .agent import AgentRunner, MemoryPreparation
from .credentials import CredentialResolver
from .errors import ApprovalError, FikeyaError
from .events import EventType
from .inference import (
    InferenceRequest,
    ProviderCallResult,
    ProviderExecutor,
    provider_request_fingerprint,
)
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
_IGNORED_DIRECTORIES = frozenset(
    {".fikeya", ".git", ".hg", ".svn", "__pycache__", "node_modules"}
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
    """Before/after identity for one file changed by an approved operation."""

    path: str
    before_sha256: str | None
    after_sha256: str

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
        maximum_process_timeout_seconds: float = 120.0,
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
        return (
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
        )

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
            else:
                result = ToolResult(call.call_id, "error", "Unknown broker tool.")
        except (ApprovalError, FikeyaError, OSError, UnicodeError, ValueError) as error:
            result = ToolResult(call.call_id, "error", _safe_error(error))
        self.state.results[idempotency_key] = result
        if not any(item.call_id == call.call_id for item in self.state.receipts):
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
                name for name in directories if name not in _IGNORED_DIRECTORIES
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
            if any(part in _IGNORED_DIRECTORIES for part in relative_path.parts):
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
            raise ValueError("timeoutSeconds must be numeric.")
        if not 0.1 <= float(timeout) <= self.maximum_process_timeout_seconds:
            raise ValueError(
                f"timeoutSeconds must be between 0.1 and {self.maximum_process_timeout_seconds:g}."
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
        output = stable_json(
            {
                "durationMs": outcome.duration_ms,
                "exitCode": outcome.exit_code,
                "stderr": outcome.stderr,
                "stdout": outcome.stdout,
                "truncated": outcome.truncated,
            }
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

    def _file(self, relative: str, *, must_exist: bool) -> Path:
        if not relative or relative == ".":
            raise ValueError("A file path is required.")
        path = self.workspace.boundary.resolve(relative, must_exist=must_exist)
        if ".fikeya" in path.relative_to(self.workspace.root).parts:
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
    ) -> None:
        self.workspace = workspace
        self.providers = providers
        self.executor = executor or ProviderExecutor()
        self.credentials = credentials or CredentialResolver(providers)
        self.state = StateStore(workspace.state_path)
        self.allowed_executables = allowed_executables or _DEFAULT_ALLOWED_EXECUTABLES

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
    ) -> CodingRunResult:
        """Run a complete reviewed loop, pausing for each exact approval."""

        profile = self.providers.get(provider_name)
        session = self.state.create_session(
            metadata={
                "mode": "coding-agent",
                "model": profile.model,
                "provider": profile.name,
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
            )
            broker = WorkspaceExecutionBroker(
                self.workspace,
                allowed_executables=self.allowed_executables,
                maximum_process_timeout_seconds=timeout,
            )
            maximum_output_bytes = max(256, min(4_194_304, max_output_tokens * 4))
            orchestrator = AgentOrchestrator(
                provider,
                broker,
                # The loop stays in one supervised process, so prompts and tool outputs never
                # enter the workspace database. Runtime SQLite retains content-free receipts.
                InMemoryCheckpointStore(),
                AgentLimits(
                    max_output_bytes=maximum_output_bytes,
                    provider_timeout_seconds=timeout,
                    # The broker owns process-tree cleanup. Keep the orchestration timeout
                    # beyond the maximum approved tool runtime so wait_for never abandons it.
                    broker_timeout_seconds=min(600.0, timeout + 15.0),
                ),
            )
            orchestrator.start(prompt, evidence=evidence, session_id=session.session_id)
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
        except Exception:
            try:
                if self.state.get_session(session.session_id).status == "active":
                    self.state.cancel_session(session.session_id, "coding loop failed")
            except Exception:
                pass
            raise

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
        raise ValueError(f"{name} must be a string.")
    return value


def _optional_integer(arguments: dict[str, object], name: str, *, default: int) -> int:
    value = arguments.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer.")
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
            name for name in directories if name not in _IGNORED_DIRECTORIES
        )
        values.extend(Path(directory) / name for name in sorted(files))
        if len(values) >= _MAX_LISTED_FILES:
            break
    return values[:_MAX_LISTED_FILES]


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
