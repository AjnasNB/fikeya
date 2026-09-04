# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Bounded MCP-over-stdio sessions for explicitly enabled tool presets."""

from __future__ import annotations

import base64
import json
import math
import queue
import re
import subprocess
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .errors import ToolPresetError
from .process_tree import ManagedProcessTree
from .tool_presets import (
    ToolBudget,
    ToolLaunchPlan,
    ToolPreset,
    ToolPresetLoader,
)
from .workspace import Workspace

_DEFAULT_PROTOCOL_VERSION = "2025-06-18"
_MAX_JSON_DEPTH = 32
_MAX_JSON_NODES = 100_000
_MAX_TOOL_PAGES = 16
_MAX_CONTENT_BLOCKS = 64
_MAX_STDERR_CAPTURE_BYTES = 64 * 1024
_MAX_ID = 2**31 - 1
_TOOL_NAME = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_VERSION_RANGE = re.compile(
    r"^>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*) "
    r"<(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)
_SAFE_BASE_ENVIRONMENT = {
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
}
_SECRET_SHAPE = re.compile(
    r"(?:sk-(?:or-)?[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|"
    r"-----BEGIN [A-Z ]+PRIVATE KEY-----)"
)


class McpProtocolError(ToolPresetError):
    """Raised when an MCP peer violates the bounded JSON-RPC contract."""


class McpRemoteError(McpProtocolError):
    """A typed, bounded JSON-RPC error returned by the MCP peer."""

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.remote_message = message
        super().__init__(f"MCP peer returned JSON-RPC error {code}: {message}")


@dataclass(frozen=True, slots=True)
class McpServerIdentity:
    """The server identity verified during MCP initialization."""

    name: str
    version: str
    protocol_version: str


@dataclass(frozen=True, slots=True)
class McpToolDefinition:
    """A reviewed MCP tool definition with a bounded object input schema."""

    name: str
    description: str | None
    input_schema: Mapping[str, object]
    output_schema: Mapping[str, object] | None


@dataclass(frozen=True, slots=True)
class McpTextContent:
    """Text returned by an MCP tool."""

    text: str
    kind: str = "text"


@dataclass(frozen=True, slots=True)
class McpBinaryContent:
    """Base64-encoded image or audio returned by an MCP tool."""

    kind: str
    data: str
    mime_type: str


@dataclass(frozen=True, slots=True)
class McpResourceContent:
    """A bounded embedded text or blob resource returned by an MCP tool."""

    uri: str
    mime_type: str | None
    text: str | None = None
    blob: str | None = None
    kind: str = "resource"


@dataclass(frozen=True, slots=True)
class McpResourceLink:
    """A typed link to a resource exposed by an MCP tool."""

    name: str
    uri: str
    title: str | None
    description: str | None
    mime_type: str | None
    size: int | None
    kind: str = "resource_link"


McpContent = McpTextContent | McpBinaryContent | McpResourceContent | McpResourceLink


@dataclass(frozen=True, slots=True)
class McpToolResult:
    """Normalized MCP tool output independent of an upstream SDK version."""

    content: tuple[McpContent, ...]
    is_error: bool
    structured_content: Mapping[str, object] | None


@dataclass(frozen=True, slots=True)
class _ReaderFailure:
    error: Exception


class McpStdioHost:
    """Own one shell-free, workspace-scoped MCP subprocess and its lifecycle."""

    def __init__(
        self,
        *,
        preset: ToolPreset,
        plan: ToolLaunchPlan,
        process: subprocess.Popen[bytes],
        process_tree: ManagedProcessTree,
        budget: ToolBudget,
        protocol_version: str,
        stderr_capture_bytes: int,
    ) -> None:
        self.preset = preset
        self.plan = plan
        self.process = process
        self.process_tree = process_tree
        self.budget = budget
        self.protocol_version = protocol_version
        self._stderr_capture_bytes = stderr_capture_bytes
        self._responses: queue.Queue[bytes | _ReaderFailure | None] = queue.Queue(
            maxsize=max(8, preset.limits.max_concurrent_requests * 4)
        )
        self._request_lock = threading.Lock()
        self._stderr_lock = threading.Lock()
        self._stderr = bytearray()
        self._stderr_truncated = False
        self._closed = False
        self._next_id = 1
        self._tools: tuple[McpToolDefinition, ...] | None = None
        self.server_identity: McpServerIdentity | None = None
        self._stdout_thread = threading.Thread(
            target=self._read_stdout,
            name=f"fikeya-mcp-{preset.preset_id}-stdout",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr,
            name=f"fikeya-mcp-{preset.preset_id}-stderr",
            daemon=True,
        )

    @classmethod
    def connect(
        cls,
        loader: ToolPresetLoader,
        workspace: Workspace,
        preset_id: str,
        *,
        expected_preset_digest: str,
        configuration: Mapping[str, str] | None = None,
        secret_resolver: Any = None,
        executable_resolver: Any = None,
        process_factory: Any = subprocess.Popen,
        protocol_version: str = _DEFAULT_PROTOCOL_VERSION,
        stderr_capture_bytes: int = _MAX_STDERR_CAPTURE_BYTES,
    ) -> McpStdioHost:
        """Validate, launch, initialize, and version-check one MCP preset."""

        _require_protocol_version(protocol_version)
        if not isinstance(expected_preset_digest, str) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", expected_preset_digest
        ):
            raise ToolPresetError("Expected preset digest must be a SHA-256 digest.")
        if not 1_024 <= stderr_capture_bytes <= 1024 * 1024:
            raise ToolPresetError("MCP stderr capture must be between 1 KiB and 1 MiB.")
        preset = loader.catalog.get(preset_id)
        if preset.digest != expected_preset_digest:
            raise ToolPresetError(
                "Tool preset digest changed; explicit workspace reconfirmation is required."
            )
        prepare_kwargs: dict[str, object] = {
            "configuration": configuration,
            "secret_resolver": secret_resolver,
        }
        if executable_resolver is not None:
            prepare_kwargs["executable_resolver"] = executable_resolver
        plan = loader.prepare_launch(
            workspace,
            preset_id,
            **prepare_kwargs,
        )
        if plan.preset_id != preset.preset_id:
            raise ToolPresetError(
                "Prepared tool launch does not match the selected preset."
            )
        _validate_launch_environment(preset, plan)
        process, budget, process_tree = loader.spawn(
            plan, process_factory=process_factory
        )
        _require_process_pipes(process)
        host = cls(
            preset=preset,
            plan=plan,
            process=process,
            process_tree=process_tree,
            budget=budget,
            protocol_version=protocol_version,
            stderr_capture_bytes=stderr_capture_bytes,
        )
        host._stdout_thread.start()
        host._stderr_thread.start()
        try:
            host._initialize()
        except Exception:
            host.close(force=True)
            raise
        return host

    def __enter__(self) -> McpStdioHost:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback
        self.close()

    @property
    def stderr_text(self) -> str:
        """Return the bounded stderr tail with resolved credentials redacted."""

        with self._stderr_lock:
            captured = bytes(self._stderr)
            truncated = self._stderr_truncated
        text = captured.decode("utf-8", errors="replace")
        for name in _secret_environment_names(self.preset):
            value = self.plan.environment.get(name)
            if value:
                text = text.replace(value, "[redacted]")
        text = _SECRET_SHAPE.sub("[redacted]", text)
        return f"{text}\n[stderr truncated]" if truncated else text

    def list_tools(self) -> tuple[McpToolDefinition, ...]:
        """Discover and validate the exact tool allowlist declared by the preset."""

        if self._tools is not None:
            return self._tools
        discovered: list[McpToolDefinition] = []
        seen_names: set[str] = set()
        seen_cursors: set[str] = set()
        cursor: str | None = None
        for _page in range(_MAX_TOOL_PAGES):
            params = {} if cursor is None else {"cursor": cursor}
            result = self._request("tools/list", params)
            response = _object(result, "tools/list result")
            _known_keys(response, {"tools", "nextCursor"}, "tools/list result")
            tools = response.get("tools")
            if not isinstance(tools, list):
                raise McpProtocolError("tools/list result must contain a tools array.")
            for value in tools:
                definition = _parse_tool_definition(value)
                if definition.name in seen_names:
                    raise McpProtocolError(
                        f"MCP peer returned duplicate tool: {definition.name}"
                    )
                if definition.name not in self.preset.allowed_tools:
                    raise McpProtocolError(
                        f"MCP peer exposed a tool outside the reviewed preset: {definition.name}"
                    )
                seen_names.add(definition.name)
                discovered.append(definition)
            next_cursor = response.get("nextCursor")
            if next_cursor is None:
                break
            if (
                not isinstance(next_cursor, str)
                or not 1 <= len(next_cursor) <= 512
                or next_cursor in seen_cursors
            ):
                raise McpProtocolError(
                    "MCP peer returned an invalid pagination cursor."
                )
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        else:
            raise McpProtocolError("MCP tool discovery exceeded the page limit.")
        if seen_names != set(self.preset.allowed_tools):
            missing = sorted(set(self.preset.allowed_tools) - seen_names)
            raise McpProtocolError(
                f"MCP peer is missing reviewed tools: {', '.join(missing)}"
            )
        self._tools = tuple(discovered)
        return self._tools

    def call_tool(
        self, name: str, arguments: Mapping[str, object] | None = None
    ) -> McpToolResult:
        """Call one reviewed tool and return a normalized, bounded result."""

        if not isinstance(name, str) or not _TOOL_NAME.fullmatch(name):
            raise ToolPresetError("MCP tool name is invalid.")
        if name not in self.preset.allowed_tools:
            raise ToolPresetError(f"MCP tool is not allowlisted by the preset: {name}")
        definitions = {item.name: item for item in self.list_tools()}
        if name not in definitions:
            raise ToolPresetError(f"MCP tool is not available in this session: {name}")
        payload = dict(arguments or {})
        _validate_json_tree(payload, label="MCP tool arguments")
        _validate_object_arguments(payload, definitions[name].input_schema)
        result = self._request("tools/call", {"name": name, "arguments": payload})
        return _parse_tool_result(result)

    def close(self, *, force: bool = False) -> None:
        """Close pipes, terminate after a finite grace period, then force-kill."""

        if self._closed:
            return
        self._closed = True
        try:
            stdin = self.process.stdin
            if stdin is not None:
                try:
                    stdin.close()
                except OSError:
                    pass
            if self.process.poll() is None and not force:
                try:
                    self.process.wait(
                        timeout=self.preset.limits.shutdown_timeout_ms / 1_000
                    )
                except subprocess.TimeoutExpired:
                    pass
            try:
                # Always terminate the owned tree, even if the MCP parent exited
                # after creating a surviving descendant.
                self.process_tree.terminate()
            except OSError:
                pass
            if self.process.poll() is None:
                try:
                    self.process.wait(
                        timeout=self.preset.limits.shutdown_timeout_ms / 1_000
                    )
                except subprocess.TimeoutExpired:
                    try:
                        self.process.kill()
                    except OSError:
                        pass
                    try:
                        self.process.wait(timeout=1.0)
                    except subprocess.TimeoutExpired as error:
                        raise McpProtocolError(
                            "MCP subprocess did not stop after force-kill."
                        ) from error
        finally:
            self._stdout_thread.join(timeout=0.5)
            self._stderr_thread.join(timeout=0.5)
            self.process_tree.close()

    def _initialize(self) -> None:
        result = self._request(
            "initialize",
            {
                "protocolVersion": self.protocol_version,
                "capabilities": {},
                "clientInfo": {"name": "fikeya-runtime", "version": "0.1.0b8"},
            },
            timeout_ms=self.preset.limits.startup_timeout_ms,
        )
        response = _object(result, "initialize result")
        _known_keys(
            response,
            {"protocolVersion", "capabilities", "serverInfo", "instructions"},
            "initialize result",
        )
        negotiated = response.get("protocolVersion")
        if negotiated != self.protocol_version:
            raise McpProtocolError(
                "MCP peer did not negotiate the requested protocol version."
            )
        _object(response.get("capabilities"), "initialize capabilities")
        server_info = _object(response.get("serverInfo"), "initialize serverInfo")
        _known_keys(
            server_info,
            {"name", "version", "title", "description", "websiteUrl", "icons"},
            "initialize serverInfo",
        )
        name = server_info.get("name")
        version = server_info.get("version")
        if not isinstance(name, str) or not 1 <= len(name) <= 128:
            raise McpProtocolError("MCP serverInfo.name is invalid.")
        if name != self.preset.dependency["package"]:
            raise McpProtocolError("MCP server identity does not match the preset.")
        if not isinstance(version, str) or not _compatible_version(
            version, self.preset.dependency["versionRange"]
        ):
            raise McpProtocolError(
                "MCP server version is outside the reviewed preset range."
            )
        instructions = response.get("instructions")
        if instructions is not None and (
            not isinstance(instructions, str) or len(instructions) > 16_384
        ):
            raise McpProtocolError("MCP initialization instructions are invalid.")
        self.server_identity = McpServerIdentity(name, version, negotiated)
        self._notify("notifications/initialized")

    def _request(
        self,
        method: str,
        params: Mapping[str, object],
        *,
        timeout_ms: int | None = None,
    ) -> object:
        _validate_method(method)
        _validate_json_tree(params, label=f"{method} params")
        with self._request_lock:
            self._require_live()
            request_id = self._next_id
            if request_id > _MAX_ID:
                raise McpProtocolError("MCP request identifier space is exhausted.")
            self._next_id += 1
            payload = _encode_json_line(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": dict(params),
                }
            )
            with self.budget.request(payload):
                self._write(payload)
                deadline = (timeout_ms or self.preset.limits.request_timeout_ms) / 1_000
                try:
                    item = self._responses.get(timeout=deadline)
                except queue.Empty as error:
                    self.close(force=True)
                    raise McpProtocolError(
                        f"MCP request timed out: {method}"
                    ) from error
                if item is None:
                    raise McpProtocolError("MCP peer closed stdout before responding.")
                if isinstance(item, _ReaderFailure):
                    raise McpProtocolError(str(item.error)) from item.error
                self.budget.validate_response(item)
                return _parse_response(item, request_id)

    def _notify(self, method: str, params: Mapping[str, object] | None = None) -> None:
        _validate_method(method)
        message: dict[str, object] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            _validate_json_tree(params, label=f"{method} params")
            message["params"] = dict(params)
        payload = _encode_json_line(message)
        with self.budget.request(payload):
            self._write(payload)

    def _write(self, payload: bytes) -> None:
        self._require_live()
        if len(payload) > self.preset.limits.max_request_bytes:
            raise ToolPresetError("MCP request exceeds the preset request-byte limit.")
        stdin = self.process.stdin
        if stdin is None:
            raise McpProtocolError("MCP stdin is unavailable.")
        try:
            stdin.write(payload)
            stdin.flush()
        except (BrokenPipeError, OSError) as error:
            self.close(force=True)
            raise McpProtocolError("MCP peer closed stdin.") from error

    def _require_live(self) -> None:
        if self._closed:
            raise McpProtocolError("MCP session is closed.")
        return_code = self.process.poll()
        if return_code is not None:
            raise McpProtocolError(
                f"MCP subprocess exited before the request (exit {return_code})."
            )

    def _read_stdout(self) -> None:
        stdout = self.process.stdout
        if stdout is None:
            self._enqueue(
                _ReaderFailure(McpProtocolError("MCP stdout is unavailable."))
            )
            return
        limit = self.preset.limits.max_response_bytes
        try:
            while not self._closed:
                line = stdout.readline(limit + 1)
                if not line:
                    self._enqueue(None)
                    return
                if len(line) > limit:
                    self._enqueue(
                        _ReaderFailure(
                            McpProtocolError(
                                "MCP response exceeds the preset response-byte limit."
                            )
                        )
                    )
                    self._kill_from_reader()
                    return
                if not line.endswith(b"\n"):
                    self._enqueue(
                        _ReaderFailure(
                            McpProtocolError(
                                "MCP peer returned an unterminated JSON-RPC message."
                            )
                        )
                    )
                    self._kill_from_reader()
                    return
                self._enqueue(line)
        except (OSError, ValueError) as error:
            self._enqueue(_ReaderFailure(error))

    def _read_stderr(self) -> None:
        stderr = self.process.stderr
        if stderr is None:
            return
        try:
            while True:
                chunk = stderr.read(4_096)
                if not chunk:
                    return
                with self._stderr_lock:
                    remaining = self._stderr_capture_bytes - len(self._stderr)
                    if remaining > 0:
                        self._stderr.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        self._stderr_truncated = True
        except OSError:
            return

    def _enqueue(self, item: bytes | _ReaderFailure | None) -> None:
        try:
            self._responses.put(item, timeout=0.1)
        except queue.Full:
            self._kill_from_reader()

    def _kill_from_reader(self) -> None:
        try:
            self.process_tree.terminate()
        except OSError:
            if self.process.poll() is None:
                try:
                    self.process.kill()
                except OSError:
                    pass


def _parse_response(payload: bytes, expected_id: int) -> object:
    message = _decode_json_object(payload, "JSON-RPC response")
    if message.get("jsonrpc") != "2.0":
        raise McpProtocolError("MCP peer returned an invalid JSON-RPC version.")
    response_id = message.get("id")
    if isinstance(response_id, bool) or not isinstance(response_id, int):
        raise McpProtocolError("MCP peer returned a non-integer response id.")
    if response_id != expected_id:
        raise McpProtocolError("MCP peer returned an unmatched response id.")
    has_result = "result" in message
    has_error = "error" in message
    if has_result == has_error:
        raise McpProtocolError(
            "MCP response must contain exactly one of result or error."
        )
    expected_keys = {"jsonrpc", "id", "result" if has_result else "error"}
    if set(message) != expected_keys:
        raise McpProtocolError("MCP response contains unknown fields.")
    if has_error:
        error = _object(message["error"], "JSON-RPC error")
        _known_keys(error, {"code", "message", "data"}, "JSON-RPC error")
        code = error.get("code")
        text = error.get("message")
        if (
            isinstance(code, bool)
            or not isinstance(code, int)
            or not -(2**31) <= code <= _MAX_ID
            or not isinstance(text, str)
            or not 1 <= len(text) <= 4_096
        ):
            raise McpProtocolError("MCP peer returned an invalid JSON-RPC error.")
        raise McpRemoteError(code, text)
    result = message["result"]
    _validate_json_tree(result, label="JSON-RPC result")
    return result


def _parse_tool_definition(value: object) -> McpToolDefinition:
    item = _object(value, "MCP tool definition")
    _known_keys(
        item,
        {
            "name",
            "title",
            "description",
            "inputSchema",
            "outputSchema",
            "annotations",
            "icons",
            "execution",
            "_meta",
        },
        "MCP tool definition",
    )
    name = item.get("name")
    if not isinstance(name, str) or not _TOOL_NAME.fullmatch(name):
        raise McpProtocolError("MCP tool definition has an invalid name.")
    description = item.get("description")
    if description is not None and (
        not isinstance(description, str) or len(description) > 8_192
    ):
        raise McpProtocolError("MCP tool description is invalid.")
    input_schema = _object(item.get("inputSchema"), f"{name} inputSchema")
    _validate_tool_schema(input_schema, f"{name} inputSchema")
    output_value = item.get("outputSchema")
    output_schema = None
    if output_value is not None:
        output_schema = _object(output_value, f"{name} outputSchema")
        _validate_tool_schema(output_schema, f"{name} outputSchema")
    _validate_json_tree(item, label=f"{name} tool definition")
    return McpToolDefinition(name, description, input_schema, output_schema)


def _parse_tool_result(value: object) -> McpToolResult:
    result = _object(value, "tools/call result")
    _known_keys(
        result,
        {"content", "isError", "structuredContent", "_meta"},
        "tools/call result",
    )
    blocks = result.get("content")
    if not isinstance(blocks, list) or len(blocks) > _MAX_CONTENT_BLOCKS:
        raise McpProtocolError("MCP tool result has an invalid content array.")
    content = tuple(_parse_content_block(block) for block in blocks)
    is_error = result.get("isError", False)
    if not isinstance(is_error, bool):
        raise McpProtocolError("MCP tool result isError must be a boolean.")
    structured_value = result.get("structuredContent")
    structured = None
    if structured_value is not None:
        structured = _object(structured_value, "structured MCP tool result")
        _validate_json_tree(structured, label="structured MCP tool result")
    return McpToolResult(content, is_error, structured)


def _parse_content_block(value: object) -> McpContent:
    block = _object(value, "MCP content block")
    kind = block.get("type")
    if kind == "text":
        _known_keys(block, {"type", "text", "annotations", "_meta"}, "text block")
        text = block.get("text")
        if not isinstance(text, str):
            raise McpProtocolError("MCP text block is invalid.")
        return McpTextContent(text)
    if kind in {"image", "audio"}:
        _known_keys(
            block,
            {"type", "data", "mimeType", "annotations", "_meta"},
            f"{kind} block",
        )
        data = block.get("data")
        mime_type = block.get("mimeType")
        if not isinstance(data, str) or not _valid_mime_type(mime_type):
            raise McpProtocolError(f"MCP {kind} block is invalid.")
        try:
            base64.b64decode(data, validate=True)
        except (ValueError, TypeError) as error:
            raise McpProtocolError(f"MCP {kind} data is not valid base64.") from error
        return McpBinaryContent(kind, data, mime_type)
    if kind == "resource":
        _known_keys(
            block, {"type", "resource", "annotations", "_meta"}, "resource block"
        )
        resource = _object(block.get("resource"), "embedded MCP resource")
        _known_keys(
            resource,
            {"uri", "mimeType", "text", "blob", "_meta"},
            "embedded MCP resource",
        )
        uri = resource.get("uri")
        mime_type = resource.get("mimeType")
        text = resource.get("text")
        blob = resource.get("blob")
        if not isinstance(uri, str) or not 1 <= len(uri) <= 4_096:
            raise McpProtocolError("Embedded MCP resource URI is invalid.")
        if mime_type is not None and not _valid_mime_type(mime_type):
            raise McpProtocolError("Embedded MCP resource MIME type is invalid.")
        if (text is None) == (blob is None):
            raise McpProtocolError(
                "Embedded MCP resource must contain exactly one of text or blob."
            )
        if text is not None and not isinstance(text, str):
            raise McpProtocolError("Embedded MCP resource text is invalid.")
        if blob is not None:
            if not isinstance(blob, str):
                raise McpProtocolError("Embedded MCP resource blob is invalid.")
            try:
                base64.b64decode(blob, validate=True)
            except (ValueError, TypeError) as error:
                raise McpProtocolError(
                    "Embedded MCP resource blob is not valid base64."
                ) from error
        return McpResourceContent(uri, mime_type, text, blob)
    if kind == "resource_link":
        _known_keys(
            block,
            {
                "type",
                "name",
                "title",
                "uri",
                "description",
                "mimeType",
                "annotations",
                "size",
                "icons",
                "_meta",
            },
            "resource link",
        )
        name = block.get("name")
        uri = block.get("uri")
        title = block.get("title")
        description = block.get("description")
        mime_type = block.get("mimeType")
        size = block.get("size")
        if not isinstance(name, str) or not 1 <= len(name) <= 512:
            raise McpProtocolError("MCP resource link name is invalid.")
        if not isinstance(uri, str) or not 1 <= len(uri) <= 4_096:
            raise McpProtocolError("MCP resource link URI is invalid.")
        if title is not None and not isinstance(title, str):
            raise McpProtocolError("MCP resource link title is invalid.")
        if description is not None and not isinstance(description, str):
            raise McpProtocolError("MCP resource link description is invalid.")
        if mime_type is not None and not _valid_mime_type(mime_type):
            raise McpProtocolError("MCP resource link MIME type is invalid.")
        if size is not None and (
            isinstance(size, bool) or not isinstance(size, int) or size < 0
        ):
            raise McpProtocolError("MCP resource link size is invalid.")
        return McpResourceLink(name, uri, title, description, mime_type, size)
    raise McpProtocolError(f"Unsupported MCP content block type: {kind!r}")


def _validate_launch_environment(preset: ToolPreset, plan: ToolLaunchPlan) -> None:
    allowed = _SAFE_BASE_ENVIRONMENT | set(preset.fixed_environment)
    allowed.update(str(item["name"]) for item in preset.configuration)
    allowed.update(_secret_environment_names(preset))
    unknown = set(plan.environment) - allowed
    if unknown:
        raise ToolPresetError(
            f"Tool launch environment contains fields outside the allowlist: {', '.join(sorted(unknown))}"
        )
    for name, value in plan.environment.items():
        if not isinstance(value, str) or "\x00" in value or len(value) > 16_384:
            raise ToolPresetError(f"Tool launch environment value is invalid: {name}")


def _secret_environment_names(preset: ToolPreset) -> set[str]:
    return {str(item["name"]) for item in preset.secret_references}


def _require_process_pipes(process: object) -> None:
    for name in ("stdin", "stdout", "stderr"):
        if getattr(process, name, None) is None:
            raise ToolPresetError(f"MCP subprocess {name} pipe is unavailable.")


def _require_protocol_version(value: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(
        r"20[0-9]{2}-[0-9]{2}-[0-9]{2}", value
    ):
        raise ToolPresetError("MCP protocol version must use YYYY-MM-DD format.")


def _compatible_version(version: str, version_range: str) -> bool:
    parsed = _SEMVER.fullmatch(version)
    bounds = _VERSION_RANGE.fullmatch(version_range)
    if parsed is None or bounds is None:
        return False
    actual = tuple(int(part) for part in parsed.groups())
    lower = tuple(int(part) for part in bounds.groups()[:3])
    upper = tuple(int(part) for part in bounds.groups()[3:])
    return lower <= actual < upper


def _validate_method(method: str) -> None:
    if not isinstance(method, str) or not re.fullmatch(
        r"[A-Za-z][A-Za-z0-9_.-]{0,127}(?:/[A-Za-z][A-Za-z0-9_.-]{0,127})*",
        method,
    ):
        raise ToolPresetError("MCP JSON-RPC method is invalid.")


def _encode_json_line(value: Mapping[str, object]) -> bytes:
    try:
        return (
            json.dumps(
                value,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            + b"\n"
        )
    except (TypeError, ValueError) as error:
        raise ToolPresetError("MCP request is not valid JSON data.") from error


def _decode_json_object(payload: bytes, label: str) -> dict[str, object]:
    try:
        value = json.loads(
            payload,
            parse_constant=lambda item: (_raise_invalid_constant(item)),
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
        ValueError,
    ) as error:
        raise McpProtocolError(f"{label} is not valid bounded JSON.") from error
    result = _object(value, label)
    _validate_json_tree(result, label=label)
    return result


def _raise_invalid_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def _validate_json_tree(value: object, *, label: str) -> None:
    nodes = 0
    stack: list[tuple[object, int]] = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if nodes > _MAX_JSON_NODES or depth > _MAX_JSON_DEPTH:
            raise McpProtocolError(f"{label} exceeds the JSON structure limit.")
        if item is None or isinstance(item, (str, bool, int)):
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                raise McpProtocolError(f"{label} contains a non-finite number.")
            continue
        if isinstance(item, list):
            stack.extend((child, depth + 1) for child in item)
            continue
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise McpProtocolError(f"{label} contains a non-string object key.")
            stack.extend((child, depth + 1) for child in item.values())
            continue
        raise McpProtocolError(f"{label} contains an unsupported JSON value.")


def _validate_tool_schema(schema: Mapping[str, object], label: str) -> None:
    if schema.get("type", "object") != "object":
        raise McpProtocolError(f"{label} must describe an object.")
    properties = schema.get("properties", {})
    if not isinstance(properties, dict) or any(
        not isinstance(name, str) or not isinstance(value, dict)
        for name, value in properties.items()
    ):
        raise McpProtocolError(f"{label} properties are invalid.")
    required = schema.get("required", [])
    if not isinstance(required, list) or any(
        not isinstance(name, str) or name not in properties for name in required
    ):
        raise McpProtocolError(f"{label} required fields are invalid.")


def _validate_object_arguments(
    arguments: Mapping[str, object], schema: Mapping[str, object]
) -> None:
    properties = schema.get("properties", {})
    required = schema.get("required", [])
    if isinstance(required, list):
        missing = [name for name in required if name not in arguments]
        if missing:
            raise ToolPresetError(
                f"MCP tool arguments are missing required fields: {', '.join(missing)}"
            )
    if schema.get("additionalProperties") is False and isinstance(properties, dict):
        unknown = set(arguments) - set(properties)
        if unknown:
            raise ToolPresetError(
                f"MCP tool arguments contain unknown fields: {', '.join(sorted(unknown))}"
            )


def _valid_mime_type(value: object) -> bool:
    return isinstance(value, str) and bool(
        re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+", value)
    )


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise McpProtocolError(f"{label} must be an object.")
    return value


def _known_keys(value: Mapping[str, object], allowed: set[str], label: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise McpProtocolError(f"{label} contains unknown fields.")
