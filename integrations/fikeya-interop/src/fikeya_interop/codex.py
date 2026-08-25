"""Codex app-server adapter over the stable local stdio surface."""

from __future__ import annotations

import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from .errors import PermissionDeniedError, ProtocolError
from .jsonrpc import JsonLineRpcProcess, NotificationHandler
from .models import (
    AgentCapabilities,
    PermissionDecision,
    PermissionRequest,
    PermissionResolution,
    ProcessSpec,
    ResourceLimits,
    SessionRef,
)
from .policy import ProcessPolicy
from .receipts import ReceiptSink, build_receipt


class PermissionBroker(Protocol):
    """Resolve a user-visible request outside the protocol transport."""

    async def resolve(self, request: PermissionRequest) -> PermissionResolution: ...


class DenyPermissionBroker:
    """Fail-closed permission broker used until a UI supplies a decision."""

    async def resolve(self, request: PermissionRequest) -> PermissionResolution:
        del request
        return PermissionResolution(PermissionDecision.DENY_ONCE)


def codex_process_spec(root: Path, *, command: str = "codex") -> ProcessSpec:
    """Return the supported local app-server invocation without auth material."""

    return ProcessSpec(
        identifier="codex-app-server",
        command=command,
        args=("app-server", "--listen", "stdio://"),
        cwd=root,
    )


class CodexAppServerAdapter:
    """Normalize Codex threads, approvals, notifications, and cancellation."""

    protocol = "codex-app-server"

    def __init__(
        self,
        spec: ProcessSpec,
        process_policy: ProcessPolicy,
        limits: ResourceLimits,
        receipts: ReceiptSink,
        *,
        permission_broker: PermissionBroker | None = None,
        notification_handler: NotificationHandler | None = None,
    ) -> None:
        self._spec = spec
        self._process_policy = process_policy
        self._limits = limits
        self._receipts = receipts
        self._permission_broker = permission_broker or DenyPermissionBroker()
        self._notification_handler = notification_handler
        self._rpc: JsonLineRpcProcess | None = None
        self.capabilities: AgentCapabilities | None = None

    async def __aenter__(self) -> CodexAppServerAdapter:
        self._rpc = JsonLineRpcProcess(
            self._spec,
            self._process_policy,
            self._limits,
            server_request_handler=self._handle_server_request,
            notification_handler=self._handle_notification,
        )
        await self._rpc.__aenter__()
        result = await self._call(
            "initialize",
            {
                "clientInfo": {
                    "name": "fikeya",
                    "title": "Fikeya",
                    "version": "0.1.0-alpha.1",
                }
            },
        )
        await self._rpc.notify("initialized")
        raw = result if isinstance(result, dict) else {}
        version = str(raw.get("userAgent", "local"))
        self.capabilities = AgentCapabilities(
            protocol=self.protocol,
            protocol_version=version,
            resume_session=True,
            fork_session=True,
            cancel=True,
            permission_requests=True,
            mcp_stdio=True,
            raw=raw,
        )
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self._rpc is not None:
            await self._rpc.__aexit__(exc_type, exc, traceback)
        self._rpc = None

    async def start_session(
        self,
        *,
        model: str | None = None,
        approval_policy: str = "on-request",
        sandbox: str = "workspaceWrite",
    ) -> SessionRef:
        params: dict[str, Any] = {
            "cwd": str(self._process_policy.root.root),
            "approvalPolicy": approval_policy,
            "sandbox": sandbox,
            "serviceName": "fikeya",
        }
        if model:
            params["model"] = model
        return self._session_from_result(await self._call("thread/start", params))

    async def resume_session(self, session_id: str) -> SessionRef:
        return self._session_from_result(await self._call("thread/resume", {"threadId": session_id}))

    async def fork_session(self, session_id: str, *, last_turn_id: str | None = None) -> SessionRef:
        params: dict[str, Any] = {"threadId": session_id}
        if last_turn_id:
            params["lastTurnId"] = last_turn_id
        result = await self._call("thread/fork", params)
        return self._session_from_result(result, parent_session_id=session_id)

    async def start_turn(self, session_id: str, text: str) -> str:
        result = await self._call(
            "turn/start",
            {"threadId": session_id, "input": [{"type": "text", "text": text}]},
        )
        if not isinstance(result, dict) or not isinstance(result.get("turn"), dict):
            raise ProtocolError("turn/start did not return a turn")
        turn_id = result["turn"].get("id")
        if not isinstance(turn_id, str) or not turn_id:
            raise ProtocolError("turn/start returned an invalid turn id")
        return turn_id

    async def cancel(self, session_id: str, turn_id: str) -> None:
        await self._call("turn/interrupt", {"threadId": session_id, "turnId": turn_id})

    async def _call(self, method: str, params: Mapping[str, Any]) -> Any:
        if self._rpc is None:
            raise ProtocolError("Codex app-server adapter is not connected")
        started_ns = time.monotonic_ns()
        status = "ok"
        output: Any = None
        try:
            output = await self._rpc.request(method, params)
            return output
        except Exception as error:
            status = type(error).__name__
            output = {"errorType": status}
            raise
        finally:
            self._receipts.record(
                build_receipt(
                    protocol=self.protocol,
                    peer_id=self._spec.identifier,
                    operation=method,
                    started_ns=started_ns,
                    input_value=params,
                    output_value=output,
                    status=status,
                )
            )

    async def _handle_server_request(self, method: str, params: Mapping[str, Any]) -> Any:
        supported = {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
        }
        if method not in supported:
            raise ProtocolError(f"unsupported Codex server request: {method}")
        thread_id = params.get("threadId")
        item_id = params.get("itemId")
        if not isinstance(thread_id, str) or not isinstance(item_id, str):
            raise ProtocolError("approval request is missing threadId or itemId")
        cwd_value = params.get("cwd")
        cwd = self._process_policy.root.resolve(cwd_value) if isinstance(cwd_value, str) else None
        operation = method.removeprefix("item/").removesuffix("/requestApproval")
        request = PermissionRequest(
            request_id=item_id,
            session_id=thread_id,
            operation=operation,
            title=_approval_title(method, params),
            reason=params.get("reason") if isinstance(params.get("reason"), str) else None,
            cwd=cwd,
        )
        resolution = await self._permission_broker.resolve(request)
        if method == "item/permissions/requestApproval":
            requested = params.get("permissions")
            requested = requested if isinstance(requested, dict) else {}
            if not _is_subset(resolution.granted_permissions, requested):
                raise PermissionDeniedError("granted permissions must be a subset of the agent request")
            if resolution.decision not in {PermissionDecision.ALLOW_ONCE, PermissionDecision.ALLOW_SESSION}:
                return {"permissions": {}, "scope": "turn"}
            return {
                "permissions": dict(resolution.granted_permissions),
                "scope": "session" if resolution.decision is PermissionDecision.ALLOW_SESSION else "turn",
            }
        return {"decision": _codex_decision(resolution.decision)}

    async def _handle_notification(self, method: str, params: Mapping[str, Any]) -> None:
        if self._notification_handler is not None:
            await self._notification_handler(method, params)

    def _session_from_result(self, result: Any, *, parent_session_id: str | None = None) -> SessionRef:
        if not isinstance(result, dict) or not isinstance(result.get("thread"), dict):
            raise ProtocolError("thread operation did not return a thread")
        session_id = result["thread"].get("id")
        if not isinstance(session_id, str) or not session_id:
            raise ProtocolError("thread operation returned an invalid thread id")
        return SessionRef(session_id=session_id, protocol=self.protocol, parent_session_id=parent_session_id)


def _approval_title(method: str, params: Mapping[str, Any]) -> str:
    if method == "item/commandExecution/requestApproval":
        context = params.get("networkApprovalContext")
        if isinstance(context, dict) and isinstance(context.get("host"), str):
            return f"Network access to {context['host']}"
        return "Run a command"
    if method == "item/fileChange/requestApproval":
        return "Apply file changes"
    return "Grant additional permissions"


def _codex_decision(decision: PermissionDecision) -> str:
    return {
        PermissionDecision.ALLOW_ONCE: "accept",
        PermissionDecision.ALLOW_SESSION: "acceptForSession",
        PermissionDecision.DENY_ONCE: "decline",
        PermissionDecision.DENY_SESSION: "decline",
        PermissionDecision.CANCEL: "cancel",
    }[decision]


def _is_subset(candidate: Any, requested: Any) -> bool:
    if isinstance(candidate, dict):
        return isinstance(requested, dict) and all(
            key in requested and _is_subset(value, requested[key]) for key, value in candidate.items()
        )
    if isinstance(candidate, list):
        return isinstance(requested, list) and all(
            any(_is_subset(value, item) for item in requested) for value in candidate
        )
    return candidate == requested
