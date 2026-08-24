"""Agent Client Protocol adapter backed by the official Python SDK."""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol

from acp import PROTOCOL_VERSION, RequestError, spawn_agent_process
from acp.schema import (
    AllowedOutcome,
    ClientCapabilities,
    DeniedOutcome,
    FileSystemCapabilities,
    Implementation,
    ReadTextFileResponse,
    RequestPermissionResponse,
    TextContentBlock,
    WriteTextFileResponse,
)

from .errors import LimitExceededError, PermissionDeniedError, ProtocolError
from .models import (
    AgentCapabilities,
    PermissionDecision,
    PermissionRequest,
    PermissionResolution,
    ProcessSpec,
    ResourceLimits,
    SessionRef,
)
from .policy import PathPolicy, ProcessPolicy
from .receipts import ReceiptSink, build_receipt, canonical_bytes

PermissionResolver = Callable[[PermissionRequest], Awaitable[PermissionResolution]]
SessionUpdateHandler = Callable[[str, Mapping[str, Any]], Awaitable[None]]


async def _deny_permission(request: PermissionRequest) -> PermissionResolution:
    del request
    return PermissionResolution(PermissionDecision.DENY_ONCE)


async def _ignore_update(session_id: str, update: Mapping[str, Any]) -> None:
    del session_id, update


class AcpAgentPort(Protocol):
    """Methods Fikeya requires from an official ACP client-side connection."""

    async def initialize(self, protocol_version: int, **kwargs: Any) -> Any: ...

    async def new_session(self, cwd: str, **kwargs: Any) -> Any: ...

    async def resume_session(self, session_id: str, cwd: str, **kwargs: Any) -> Any: ...

    async def fork_session(self, session_id: str, cwd: str, **kwargs: Any) -> Any: ...

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any) -> Any: ...

    async def cancel(self, session_id: str, **kwargs: Any) -> None: ...


class AcpConnectionFactory(Protocol):
    """Injectable factory so protocol behavior can be tested without a real agent."""

    def connect(
        self,
        host: FikeyaAcpHost,
        spec: ProcessSpec,
        process_policy: ProcessPolicy,
    ) -> AbstractAsyncContextManager[AcpAgentPort]: ...


class OfficialAcpConnectionFactory:
    """Start an ACP agent with the official SDK's shell-free stdio transport."""

    @asynccontextmanager
    async def connect(
        self,
        host: FikeyaAcpHost,
        spec: ProcessSpec,
        process_policy: ProcessPolicy,
    ):
        validated = process_policy.validate(spec)
        environment = process_policy.build_environment(spec)
        async with spawn_agent_process(
            host,
            validated.command,
            *validated.args,
            env=environment,
            cwd=validated.cwd,
        ) as (connection, _process):
            yield connection


class FikeyaAcpHost:
    """ACP callbacks with root-bound file access and fail-closed terminals."""

    def __init__(
        self,
        paths: PathPolicy,
        limits: ResourceLimits,
        permission_resolver: PermissionResolver = _deny_permission,
        update_handler: SessionUpdateHandler = _ignore_update,
    ) -> None:
        self._paths = paths
        self._limits = limits
        self._permission_resolver = permission_resolver
        self._update_handler = update_handler
        self._connection: Any = None

    def on_connect(self, connection: Any) -> None:
        self._connection = connection

    async def request_permission(self, session_id: str, tool_call: Any, options: list[Any], **kwargs: Any) -> Any:
        del kwargs
        request = PermissionRequest(
            request_id=str(getattr(tool_call, "tool_call_id", "acp-tool")),
            session_id=session_id,
            operation=str(getattr(tool_call, "kind", None) or "tool"),
            title=str(getattr(tool_call, "title", None) or "Run an agent tool"),
            choices=tuple(_permission_kind(option.kind) for option in options),
        )
        resolution = await self._permission_resolver(request)
        target_kind = _acp_option_kind(resolution.decision)
        selected = next((option for option in options if option.kind == target_kind), None)
        if selected is None:
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(
            outcome=AllowedOutcome(option_id=selected.option_id, outcome="selected")
        )

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        del kwargs
        value = (
            update.model_dump(mode="json", by_alias=True)
            if hasattr(update, "model_dump")
            else {"type": type(update).__name__}
        )
        if len(canonical_bytes(value)) > self._limits.max_message_bytes:
            raise LimitExceededError("ACP session update exceeds the configured limit")
        await self._update_handler(session_id, value)

    async def read_text_file(
        self,
        session_id: str,
        path: str,
        line: int | None = None,
        limit: int | None = None,
        **kwargs: Any,
    ) -> ReadTextFileResponse:
        del session_id, kwargs
        try:
            target = self._paths.resolve(path, must_exist=True)
        except (OSError, PermissionDeniedError) as error:
            raise RequestError(-32000, "file path is outside the available workspace") from error
        if not target.is_file():
            raise RequestError(-32000, "path is not a regular file")
        payload = target.read_bytes()
        if len(payload) > self._limits.max_resource_bytes:
            raise RequestError(-32000, "file exceeds the configured read limit")
        text = payload.decode("utf-8")
        if line is not None or limit is not None:
            lines = text.splitlines(keepends=True)
            start = max(0, line or 0)
            stop = start + max(0, limit) if limit is not None else None
            text = "".join(lines[start:stop])
        return ReadTextFileResponse(content=text)

    async def write_text_file(self, session_id: str, path: str, content: str, **kwargs: Any) -> WriteTextFileResponse:
        del kwargs
        payload = content.encode("utf-8")
        if len(payload) > self._limits.max_resource_bytes:
            raise RequestError(-32000, "file exceeds the configured write limit")
        try:
            target = self._paths.resolve(path)
            parent = self._paths.resolve(target.parent, must_exist=True)
        except (OSError, PermissionDeniedError) as error:
            raise RequestError(-32000, "file path is outside the available workspace") from error
        if not parent.is_dir():
            raise RequestError(-32000, "target parent is not a directory")
        resolution = await self._permission_resolver(
            PermissionRequest(
                request_id=f"write-{uuid.uuid4().hex}",
                session_id=session_id,
                operation="write_file",
                title=f"Write {target.relative_to(self._paths.root)}",
                cwd=parent,
            )
        )
        if resolution.decision not in {PermissionDecision.ALLOW_ONCE, PermissionDecision.ALLOW_SESSION}:
            raise RequestError(-32000, "file write was not approved")
        temporary = target.with_name(f".{target.name}.fikeya-{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(payload)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return WriteTextFileResponse()

    async def create_terminal(self, *args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        raise RequestError(-32601, "ACP terminal callbacks are disabled; use Fikeya's execution broker")

    async def terminal_output(self, *args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        raise RequestError(-32601, "ACP terminal callbacks are disabled")

    async def release_terminal(self, *args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        raise RequestError(-32601, "ACP terminal callbacks are disabled")

    async def wait_for_terminal_exit(self, *args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        raise RequestError(-32601, "ACP terminal callbacks are disabled")

    async def kill_terminal(self, *args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        raise RequestError(-32601, "ACP terminal callbacks are disabled")

    async def create_elicitation(self, *args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        raise RequestError(-32601, "ACP elicitation is not enabled")

    async def complete_elicitation(self, *args: Any, **kwargs: Any) -> None:
        del args, kwargs

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        del params
        raise RequestError(-32601, f"unsupported ACP extension method: {method}")

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        del method, params


class AcpAgentAdapter:
    """Normalize ACP capability negotiation and session lifecycle operations."""

    protocol = "acp"

    def __init__(
        self,
        spec: ProcessSpec,
        process_policy: ProcessPolicy,
        limits: ResourceLimits,
        receipts: ReceiptSink,
        *,
        permission_resolver: PermissionResolver = _deny_permission,
        update_handler: SessionUpdateHandler = _ignore_update,
        connection_factory: AcpConnectionFactory | None = None,
    ) -> None:
        self._spec = spec
        self._process_policy = process_policy
        self._limits = limits
        self._receipts = receipts
        self._host = FikeyaAcpHost(process_policy.root, limits, permission_resolver, update_handler)
        self._factory = connection_factory or OfficialAcpConnectionFactory()
        self._connection_context: AbstractAsyncContextManager[AcpAgentPort] | None = None
        self._connection: AcpAgentPort | None = None
        self.capabilities: AgentCapabilities | None = None

    async def __aenter__(self) -> AcpAgentAdapter:
        self._connection_context = self._factory.connect(self._host, self._spec, self._process_policy)
        self._connection = await self._connection_context.__aenter__()
        response = await self._call(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": {"readTextFile": True, "writeTextFile": True},
                    "terminal": False,
                },
            },
            lambda: self._connection.initialize(
                PROTOCOL_VERSION,
                client_capabilities=ClientCapabilities(
                    fs=FileSystemCapabilities(read_text_file=True, write_text_file=True),
                    terminal=False,
                ),
                client_info=Implementation(name="fikeya", title="Fikeya", version="0.1.0-alpha.1"),
            ),
        )
        if response.protocol_version != PROTOCOL_VERSION:
            raise ProtocolError(f"unsupported ACP protocol version: {response.protocol_version}")
        capabilities = response.agent_capabilities
        session = capabilities.session_capabilities if capabilities is not None else None
        mcp = capabilities.mcp_capabilities if capabilities is not None else None
        raw = response.model_dump(mode="json", by_alias=True)
        self.capabilities = AgentCapabilities(
            protocol=self.protocol,
            protocol_version=str(response.protocol_version),
            resume_session=bool(session and session.resume is not None),
            fork_session=bool(session and session.fork is not None),
            cancel=True,
            permission_requests=True,
            mcp_http=bool(mcp and mcp.http),
            mcp_sse=bool(mcp and mcp.sse),
            mcp_stdio=True,
            raw=raw,
        )
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self._connection_context is not None:
            await self._connection_context.__aexit__(exc_type, exc, traceback)
        self._connection_context = None
        self._connection = None

    async def start_session(self) -> SessionRef:
        response = await self._call(
            "session/new",
            {"cwd": str(self._process_policy.root.root)},
            lambda: self._require_connection().new_session(cwd=str(self._process_policy.root.root)),
        )
        return SessionRef(session_id=response.session_id, protocol=self.protocol)

    async def resume_session(self, session_id: str) -> SessionRef:
        if self.capabilities is None or not self.capabilities.resume_session:
            raise ProtocolError("ACP agent did not negotiate session resume")
        await self._call(
            "session/resume",
            {"sessionId": session_id, "cwd": str(self._process_policy.root.root)},
            lambda: self._require_connection().resume_session(session_id, cwd=str(self._process_policy.root.root)),
        )
        return SessionRef(session_id=session_id, protocol=self.protocol)

    async def fork_session(self, session_id: str) -> SessionRef:
        if self.capabilities is None or not self.capabilities.fork_session:
            raise ProtocolError("ACP agent did not negotiate session fork")
        response = await self._call(
            "session/fork",
            {"sessionId": session_id, "cwd": str(self._process_policy.root.root)},
            lambda: self._require_connection().fork_session(session_id, cwd=str(self._process_policy.root.root)),
        )
        return SessionRef(session_id=response.session_id, protocol=self.protocol, parent_session_id=session_id)

    async def send_prompt(self, session_id: str, text: str) -> str:
        response = await self._call(
            "session/prompt",
            {"sessionId": session_id, "text": text},
            lambda: self._require_connection().prompt(
                session_id,
                [TextContentBlock(type="text", text=text)],
            ),
        )
        return str(response.stop_reason)

    async def cancel(self, session_id: str) -> None:
        await self._call(
            "session/cancel",
            {"sessionId": session_id},
            lambda: self._require_connection().cancel(session_id),
        )

    def _require_connection(self) -> AcpAgentPort:
        if self._connection is None:
            raise ProtocolError("ACP adapter is not connected")
        return self._connection

    async def _call(
        self,
        operation: str,
        input_value: Mapping[str, Any],
        callback: Callable[[], Awaitable[Any]],
    ) -> Any:
        started_ns = time.monotonic_ns()
        status = "ok"
        output: Any = None
        try:
            output = await asyncio.wait_for(callback(), timeout=self._limits.request_timeout_seconds)
            return output
        except asyncio.TimeoutError as error:
            status = "timeout"
            output = {"errorType": status}
            raise ProtocolError(f"ACP operation timed out: {operation}") from error
        except Exception as error:
            status = type(error).__name__
            output = {"errorType": status}
            raise
        finally:
            safe_output = (
                output.model_dump(mode="json", by_alias=True)
                if hasattr(output, "model_dump")
                else output
            )
            self._receipts.record(
                build_receipt(
                    protocol=self.protocol,
                    peer_id=self._spec.identifier,
                    operation=operation,
                    started_ns=started_ns,
                    input_value=input_value,
                    output_value=safe_output,
                    status=status,
                )
            )


def _permission_kind(kind: str) -> PermissionDecision:
    return {
        "allow_once": PermissionDecision.ALLOW_ONCE,
        "allow_always": PermissionDecision.ALLOW_SESSION,
        "reject_once": PermissionDecision.DENY_ONCE,
        "reject_always": PermissionDecision.DENY_SESSION,
    }[kind]


def _acp_option_kind(decision: PermissionDecision) -> str | None:
    return {
        PermissionDecision.ALLOW_ONCE: "allow_once",
        PermissionDecision.ALLOW_SESSION: "allow_always",
        PermissionDecision.DENY_ONCE: "reject_once",
        PermissionDecision.DENY_SESSION: "reject_always",
        PermissionDecision.CANCEL: None,
    }[decision]
