# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Namespaced Agent Core tools backed by explicitly enabled MCP presets."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from collections.abc import Callable, Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from fikeya_agent_core import CancellationToken, ToolCall, ToolDefinition, ToolResult
from fikeya_agent_core.errors import CancellationError

from .errors import FikeyaError, SecretStoreUnavailable, ToolPresetError
from .mcp_stdio import (
    McpBinaryContent,
    McpResourceContent,
    McpResourceLink,
    McpStdioHost,
    McpTextContent,
    McpToolDefinition,
    McpToolResult,
)
from .providers import KEYRING_SERVICE, OSKeyringSecretStore
from .tool_presets import (
    ToolEnablementStore,
    ToolPreset,
    ToolPresetLoader,
)
from .util import validate_identifier
from .workspace import Workspace

_NAMESPACE_PREFIX = "mcp"
_MAX_BROKER_OUTPUT_BYTES = 1_048_576
_CANCELLATION_POLL_SECONDS = 0.05


@dataclass(frozen=True, slots=True)
class McpBrokerTool:
    """One MCP tool mapped to its stable Agent Core namespace."""

    broker_name: str
    preset_id: str
    upstream_name: str
    effect: str


class McpCredentialStore:
    """Store external-tool credentials in the OS keyring, never workspace files."""

    def __init__(self, secrets: OSKeyringSecretStore | None = None) -> None:
        self.secrets = secrets or OSKeyringSecretStore()

    def set(self, workspace: Workspace, preset_id: str, name: str, secret: str) -> None:
        if (
            not secret
            or len(secret) > 16_384
            or any(character in secret for character in ("\x00", "\r", "\n"))
        ):
            raise ToolPresetError("External-tool credential has an invalid value.")
        self.secrets.set(_credential_account(workspace, preset_id, name), secret)

    def resolve(self, workspace: Workspace, preset_id: str, name: str) -> str | None:
        reference = (
            f"keyring://{KEYRING_SERVICE}/"
            f"{_credential_account(workspace, preset_id, name)}"
        )
        try:
            return self.secrets.get(reference)
        except SecretStoreUnavailable:
            return None

    def remove(self, workspace: Workspace, preset_id: str, name: str) -> None:
        reference = (
            f"keyring://{KEYRING_SERVICE}/"
            f"{_credential_account(workspace, preset_id, name)}"
        )
        try:
            self.secrets.delete(reference)
        except SecretStoreUnavailable:
            return

    def configured(self, workspace: Workspace, preset_id: str, name: str) -> bool:
        return self.resolve(workspace, preset_id, name) is not None


class McpBrokerRegistry:
    """Expose enabled MCP presets through Agent Core's exact broker boundary."""

    def __init__(
        self,
        workspace: Workspace,
        *,
        loader: ToolPresetLoader | None = None,
        configuration: Mapping[str, Mapping[str, str]] | None = None,
        credential_store: McpCredentialStore | None = None,
        secret_resolver: Callable[[str, str], str | None] | None = None,
        executable_resolver: Callable[[str], str | None] = shutil.which,
        process_factory: Callable[..., Any] = subprocess.Popen,
        maximum_output_bytes: int = _MAX_BROKER_OUTPUT_BYTES,
    ) -> None:
        if not 1_024 <= maximum_output_bytes <= 4_194_304:
            raise ToolPresetError("MCP broker output must be between 1 KiB and 4 MiB.")
        self.workspace = workspace
        self.loader = loader or ToolPresetLoader()
        self.configuration = {
            preset_id: dict(values)
            for preset_id, values in (configuration or {}).items()
        }
        self.credential_store = credential_store or McpCredentialStore()
        self.secret_resolver = secret_resolver
        self.executable_resolver = executable_resolver
        self.process_factory = process_factory
        self.maximum_output_bytes = maximum_output_bytes
        self._hosts: dict[str, McpStdioHost] = {}
        self._redactions: dict[str, tuple[str, ...]] = {}
        self._definitions: tuple[ToolDefinition, ...] | None = None
        self._tool_map: dict[str, McpBrokerTool] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="fikeya-mcp-broker",
        )
        self._closed = False

    @property
    def enabled_presets(self) -> tuple[ToolPreset, ...]:
        enablements = ToolEnablementStore(self.workspace)
        return tuple(
            preset
            for preset in self.loader.catalog.list()
            if enablements.status(preset).enabled
        )

    async def list_tools(
        self, cancellation: CancellationToken
    ) -> tuple[ToolDefinition, ...]:
        """Connect enabled presets and return namespaced, broker-owned schemas."""

        cancellation.raise_if_cancelled()
        if self._definitions is not None:
            return self._definitions
        if not self.enabled_presets:
            self._definitions = ()
            return self._definitions
        result = await self._run_worker(self._connect_and_list, cancellation)
        assert isinstance(result, tuple)
        return result

    async def execute(
        self, call: ToolCall, cancellation: CancellationToken
    ) -> ToolResult:
        """Execute only a discovered namespaced tool after Agent Core approval."""

        cancellation.raise_if_cancelled()
        if self._definitions is None:
            await self.list_tools(cancellation)
        mapping = self._tool_map.get(call.name)
        if mapping is None:
            return ToolResult(call.call_id, "error", "Unknown namespaced MCP tool.")
        try:
            result = await self._run_worker(
                lambda: self._call_sync(mapping, call.arguments), cancellation
            )
        except CancellationError:
            raise
        except (FikeyaError, OSError, UnicodeError, ValueError) as error:
            return ToolResult(
                call.call_id,
                "error",
                _safe_error(error, self._redactions.get(mapping.preset_id, ())),
            )
        assert isinstance(result, McpToolResult)
        output = _result_json(
            mapping,
            result,
            self._redactions.get(mapping.preset_id, ()),
        )
        encoded = output.encode("utf-8")
        if len(encoded) > self.maximum_output_bytes:
            return ToolResult(
                call.call_id,
                "error",
                "MCP tool result exceeds the broker output limit.",
            )
        return ToolResult(
            call.call_id,
            "error" if result.is_error else "ok",
            output,
            "application/json",
        )

    def owns(self, name: str) -> bool:
        return name in self._tool_map or name.startswith(f"{_NAMESPACE_PREFIX}.")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            future = self._executor.submit(self._close_sync)
            future.result(timeout=35)
        finally:
            self._executor.shutdown(wait=True, cancel_futures=True)

    async def _run_worker(
        self, callback: Callable[[], object], cancellation: CancellationToken
    ) -> object:
        if self._closed:
            raise ToolPresetError("MCP broker registry is closed.")
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self._executor, callback)
        while not future.done():
            if cancellation.cancelled:
                await asyncio.to_thread(self._abort_sync)
                try:
                    await future
                except Exception:
                    pass
                cancellation.raise_if_cancelled()
            await asyncio.sleep(_CANCELLATION_POLL_SECONDS)
        return await future

    def _connect_and_list(self) -> tuple[ToolDefinition, ...]:
        if self._definitions is not None:
            return self._definitions
        definitions: list[ToolDefinition] = []
        tool_map: dict[str, McpBrokerTool] = {}
        try:
            for preset in self.enabled_presets:
                host = self._connect(preset)
                self._hosts[preset.preset_id] = host
                for upstream in host.list_tools():
                    mapped = McpBrokerTool(
                        broker_name=broker_tool_name(preset.preset_id, upstream.name),
                        preset_id=preset.preset_id,
                        upstream_name=upstream.name,
                        effect=preset.effect,
                    )
                    if mapped.broker_name in tool_map:
                        raise ToolPresetError(
                            f"Duplicate namespaced MCP tool: {mapped.broker_name}"
                        )
                    tool_map[mapped.broker_name] = mapped
                    definitions.append(
                        _tool_definition(
                            preset,
                            mapped,
                            upstream,
                            self._redactions.get(preset.preset_id, ()),
                        )
                    )
        except (FikeyaError, OSError, UnicodeError, ValueError) as error:
            self._close_sync()
            raise ToolPresetError(_safe_error(error, self._all_redactions())) from error
        self._tool_map = tool_map
        self._definitions = tuple(definitions)
        return self._definitions

    def _connect(self, preset: ToolPreset) -> McpStdioHost:
        configuration = _environment_configuration(preset)
        configuration.update(self.configuration.get(preset.preset_id, {}))
        resolved_credentials: list[str] = []

        def resolve(name: str) -> str | None:
            if self.secret_resolver is not None:
                value = self.secret_resolver(preset.preset_id, name)
            else:
                value = self.credential_store.resolve(
                    self.workspace, preset.preset_id, name
                )
            if value:
                resolved_credentials.append(value)
            return value

        try:
            host = McpStdioHost.connect(
                self.loader,
                self.workspace,
                preset.preset_id,
                expected_preset_digest=preset.digest,
                configuration=configuration,
                secret_resolver=resolve,
                executable_resolver=self.executable_resolver,
                process_factory=self.process_factory,
            )
        except (FikeyaError, OSError, UnicodeError, ValueError) as error:
            redactions = _ordered_redactions(resolved_credentials)
            self._redactions[preset.preset_id] = redactions
            raise ToolPresetError(_safe_error(error, redactions)) from error
        self._redactions[preset.preset_id] = _ordered_redactions(resolved_credentials)
        return host

    def _call_sync(
        self, mapping: McpBrokerTool, arguments: Mapping[str, object]
    ) -> McpToolResult:
        host = self._hosts.get(mapping.preset_id)
        if host is None:
            raise ToolPresetError("MCP preset session is unavailable.")
        return host.call_tool(mapping.upstream_name, arguments)

    def _abort_sync(self) -> None:
        for host in tuple(self._hosts.values()):
            try:
                host.close(force=True)
            except FikeyaError:
                pass

    def _close_sync(self) -> None:
        for host in tuple(self._hosts.values()):
            try:
                host.close()
            except FikeyaError:
                pass
        self._hosts.clear()

    def _all_redactions(self) -> tuple[str, ...]:
        return _ordered_redactions(
            value for values in self._redactions.values() for value in values
        )


def broker_tool_name(preset_id: str, upstream_name: str) -> str:
    """Return the stable, collision-free Agent Core name for one MCP tool."""

    validate_identifier(preset_id, "presetId")
    validate_identifier(upstream_name, "MCP tool name")
    value = f"{_NAMESPACE_PREFIX}.{preset_id}.{upstream_name}"
    validate_identifier(value, "broker tool name")
    return value


def preset_broker_tools(preset: ToolPreset) -> tuple[str, ...]:
    return tuple(
        broker_tool_name(preset.preset_id, name) for name in preset.allowed_tools
    )


def _tool_definition(
    preset: ToolPreset,
    mapped: McpBrokerTool,
    upstream: McpToolDefinition,
    redactions: tuple[str, ...],
) -> ToolDefinition:
    raw_schema = json.loads(
        json.dumps(
            upstream.input_schema,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    schema = _redact_json(raw_schema, redactions)
    assert isinstance(schema, dict)
    description = _redact_text(
        upstream.description or f"Call {upstream.name}.", redactions
    )
    return ToolDefinition(
        mapped.broker_name,
        f"[{preset.display_name}; {preset.effect}] {description}",
        schema,
    )


def _environment_configuration(preset: ToolPreset) -> dict[str, str]:
    return {
        name: os.environ[name]
        for item in preset.configuration
        if (name := str(item["name"])) in os.environ
    }


def _credential_account(workspace: Workspace, preset_id: str, name: str) -> str:
    validate_identifier(preset_id, "presetId")
    validate_identifier(name, "credential name")
    account = f"tool:{workspace.config.workspace_id}:{preset_id}:{name}"
    validate_identifier(account, "credential account")
    return account


def _result_json(
    mapping: McpBrokerTool,
    result: McpToolResult,
    redactions: tuple[str, ...],
) -> str:
    value = {
        "content": [_content_json(item) for item in result.content],
        "effect": mapping.effect,
        "isError": result.is_error,
        "presetId": mapping.preset_id,
        "structuredContent": (
            dict(result.structured_content)
            if result.structured_content is not None
            else None
        ),
        "toolName": mapping.upstream_name,
    }
    return json.dumps(
        _redact_json(value, redactions),
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _content_json(value: object) -> dict[str, object]:
    if isinstance(value, McpTextContent):
        return {"text": value.text, "type": value.kind}
    if isinstance(value, McpBinaryContent):
        return {"data": value.data, "mimeType": value.mime_type, "type": value.kind}
    if isinstance(value, McpResourceContent):
        resource: dict[str, object] = {"uri": value.uri}
        if value.mime_type is not None:
            resource["mimeType"] = value.mime_type
        if value.text is not None:
            resource["text"] = value.text
        if value.blob is not None:
            resource["blob"] = value.blob
        return {"resource": resource, "type": value.kind}
    if isinstance(value, McpResourceLink):
        result: dict[str, object] = {
            "name": value.name,
            "type": value.kind,
            "uri": value.uri,
        }
        for name, item in (
            ("title", value.title),
            ("description", value.description),
            ("mimeType", value.mime_type),
            ("size", value.size),
        ):
            if item is not None:
                result[name] = item
        return result
    raise ToolPresetError("Unsupported typed MCP result content.")


def _safe_error(error: Exception, redactions: tuple[str, ...] = ()) -> str:
    message = " ".join(str(error).split())
    if not message:
        return type(error).__name__
    return _redact_text(message, redactions)[:2_000]


def _ordered_redactions(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(sorted({value for value in values if value}, key=len, reverse=True))


def _redact_text(value: str, redactions: tuple[str, ...]) -> str:
    result = value
    for sensitive in redactions:
        result = result.replace(sensitive, "[redacted]")
    return result


def _redact_json(value: object, redactions: tuple[str, ...]) -> object:
    if isinstance(value, str):
        return _redact_text(value, redactions)
    if isinstance(value, list):
        return [_redact_json(item, redactions) for item in value]
    if isinstance(value, dict):
        result: dict[str, object] = {}
        for key, item in value.items():
            redacted_key = _redact_text(str(key), redactions)
            if redacted_key in result:
                raise ToolPresetError(
                    "MCP output contains colliding keys after credential redaction."
                )
            result[redacted_key] = _redact_json(item, redactions)
        return result
    return value
