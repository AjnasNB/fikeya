"""Bounded newline-delimited JSON-RPC subprocess transport."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from .errors import LimitExceededError, ProtocolError
from .models import ProcessSpec, ResourceLimits
from .policy import ProcessPolicy

ServerRequestHandler = Callable[[str, Mapping[str, Any]], Awaitable[Any]]
NotificationHandler = Callable[[str, Mapping[str, Any]], Awaitable[None]]


async def _reject_server_request(method: str, params: Mapping[str, Any]) -> Any:
    del params
    raise ProtocolError(f"unsupported server request: {method}")


async def _ignore_notification(method: str, params: Mapping[str, Any]) -> None:
    del method, params


class JsonLineRpcProcess:
    """Run a policy-checked JSONL peer without a shell."""

    def __init__(
        self,
        spec: ProcessSpec,
        policy: ProcessPolicy,
        limits: ResourceLimits,
        *,
        server_request_handler: ServerRequestHandler = _reject_server_request,
        notification_handler: NotificationHandler = _ignore_notification,
    ) -> None:
        self._spec = policy.validate(spec)
        self._environment = policy.build_environment(spec)
        self._limits = limits
        self._server_request_handler = server_request_handler
        self._notification_handler = notification_handler
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._write_lock = asyncio.Lock()
        self._next_id = 1
        self._closed = False

    async def __aenter__(self) -> JsonLineRpcProcess:
        self._process = await asyncio.create_subprocess_exec(
            self._spec.command,
            *self._spec.args,
            cwd=str(self._spec.cwd),
            env=self._environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=self._limits.max_message_bytes + 1,
        )
        self._reader_task = asyncio.create_task(self._read_messages())
        self._stderr_task = asyncio.create_task(self._discard_stderr())
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback
        await self.close()

    async def request(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        if self._closed or self._process is None:
            raise ProtocolError("JSON-RPC process is not running")
        request_id = self._next_id
        self._next_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send({"id": request_id, "method": method, "params": dict(params or {})})
            return await asyncio.wait_for(future, timeout=self._limits.request_timeout_seconds)
        except asyncio.TimeoutError as error:
            raise ProtocolError(f"JSON-RPC request timed out: {method}") from error
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: Mapping[str, Any] | None = None) -> None:
        if self._closed or self._process is None:
            raise ProtocolError("JSON-RPC process is not running")
        await self._send({"method": method, "params": dict(params or {})})

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ProtocolError("JSON-RPC process closed"))
        self._pending.clear()
        process = self._process
        if process is not None and process.stdin is not None:
            process.stdin.close()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                await process.stdin.wait_closed()
        if process is not None and process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=0.5)
            except asyncio.TimeoutError:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=1.5)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is not None:
                try:
                    await asyncio.wait_for(task, timeout=0.5)
                except asyncio.TimeoutError:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task

    async def _send(self, message: Mapping[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise ProtocolError("JSON-RPC stdin is unavailable")
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
        if len(payload) > self._limits.max_message_bytes:
            raise LimitExceededError("outgoing JSON-RPC message exceeds the configured limit")
        async with self._write_lock:
            process.stdin.write(payload)
            await process.stdin.drain()

    async def _read_messages(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while not self._closed:
                try:
                    line = await process.stdout.readline()
                except ValueError as error:
                    raise LimitExceededError("incoming JSON-RPC message exceeds the configured limit") from error
                if not line:
                    if not self._closed:
                        raise ProtocolError("JSON-RPC peer closed stdout")
                    return
                if len(line) > self._limits.max_message_bytes:
                    raise LimitExceededError("incoming JSON-RPC message exceeds the configured limit")
                try:
                    message = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ProtocolError("JSON-RPC peer returned invalid JSON") from error
                if not isinstance(message, dict):
                    raise ProtocolError("JSON-RPC message must be an object")
                await self._dispatch(message)
        except Exception as error:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)

    async def _dispatch(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        method = message.get("method")
        if request_id is not None and ("result" in message or "error" in message):
            future = self._pending.get(request_id)
            if future is None or future.done():
                return
            if "error" in message:
                error = message["error"]
                detail = error.get("message", "peer error") if isinstance(error, dict) else "peer error"
                future.set_exception(ProtocolError(str(detail)))
            else:
                future.set_result(message.get("result"))
            return
        if isinstance(method, str) and request_id is not None:
            params = message.get("params")
            params = params if isinstance(params, dict) else {}
            try:
                result = await self._server_request_handler(method, params)
                await self._send({"id": request_id, "result": result})
            except Exception as error:
                await self._send({"id": request_id, "error": {"code": -32000, "message": str(error)}})
            return
        if isinstance(method, str):
            params = message.get("params")
            await self._notification_handler(method, params if isinstance(params, dict) else {})
            return
        raise ProtocolError("JSON-RPC message has no method or response payload")

    async def _discard_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        while not self._closed:
            chunk = await process.stderr.read(8192)
            if not chunk:
                return
