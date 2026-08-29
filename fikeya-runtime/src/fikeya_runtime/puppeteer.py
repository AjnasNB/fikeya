# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Optional Puppeteer transport for the bounded Fikeya browser session.

The Node child is a transport only.  URL policy remains in
``BrowserSession``: every request observed by Puppeteer is synchronously sent
back to this process and must pass the same Python guard used by Playwright.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from .browser import (
    MAX_SCREENSHOT_BYTES,
    BrowserError,
    BrowserSecurityError,
    BrowserSnapshotKind,
    BrowserUnavailable,
)

MAX_PUPPETEER_BRIDGE_MESSAGE_BYTES = 12 * 1_024 * 1_024
PUPPETEER_ROOT_ENVIRONMENT = "FIKEYA_PUPPETEER_ROOT"
_BRIDGE_SHUTDOWN_SECONDS = 3.0
_BRIDGE_START_SECONDS = 30.0


class _BridgeFailure(Exception):
    """Internal protocol failure that is never displayed verbatim."""


class PuppeteerBrowserDriver:
    """Persistent, bounded JSON-lines adapter for a reviewed Puppeteer install.

    The adapter never invokes a shell and never searches the active project for
    a package.  ``module_root`` (or ``FIKEYA_PUPPETEER_ROOT``) must identify an
    explicit directory whose ``package.json`` can resolve ``puppeteer``.
    """

    def __init__(
        self,
        *,
        module_root: str | Path | None = None,
        node_executable: str | Path | None = None,
        bridge_script: str | Path | None = None,
    ) -> None:
        supplied_root = module_root or os.environ.get(PUPPETEER_ROOT_ENVIRONMENT)
        self._module_root = Path(supplied_root).expanduser() if supplied_root else None
        self._node_executable = str(node_executable) if node_executable else None
        self._bridge_script = (
            Path(bridge_script)
            if bridge_script is not None
            else Path(__file__).with_name("puppeteer_bridge.mjs")
        )
        self._guard: Callable[[str], None] | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._messages: queue.Queue[dict[str, Any] | BaseException] = queue.Queue()
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._request_number = 0
        self._write_lock = threading.Lock()

    def set_request_guard(self, guard: Callable[[str], None]) -> None:
        self._guard = guard

    def _resolve_installation(self) -> tuple[str, Path, Path]:
        executable = self._node_executable or shutil.which("node")
        if executable is None:
            raise BrowserUnavailable(
                "Puppeteer support needs a local Node.js executable."
            )
        if self._module_root is None:
            raise BrowserUnavailable(
                "Puppeteer is optional. Install it in a reviewed directory and set "
                f"{PUPPETEER_ROOT_ENVIRONMENT} to that directory."
            )
        try:
            module_root = self._module_root.resolve(strict=True)
            bridge_script = self._bridge_script.resolve(strict=True)
        except OSError as error:
            raise BrowserUnavailable(
                "The configured Puppeteer installation is unavailable."
            ) from error
        if not module_root.is_dir() or not (module_root / "package.json").is_file():
            raise BrowserUnavailable(
                "The configured Puppeteer directory must contain package.json."
            )
        if not bridge_script.is_file():
            raise BrowserUnavailable("The Fikeya Puppeteer bridge is unavailable.")
        return executable, module_root, bridge_script

    def _ensure_started(self) -> None:
        if self._process is not None:
            if self._process.poll() is not None:
                self._terminate()
                raise BrowserUnavailable("The Puppeteer browser transport stopped.")
            return
        executable, module_root, bridge_script = self._resolve_installation()
        try:
            process = subprocess.Popen(
                [executable, str(bridge_script), str(module_root)],
                cwd=module_root,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                close_fds=os.name != "nt",
            )
        except OSError as error:
            raise BrowserUnavailable(
                "The Puppeteer browser transport could not be started."
            ) from error
        self._process = process
        self._reader = threading.Thread(
            target=self._read_stdout,
            name="fikeya-puppeteer-output",
            daemon=True,
        )
        self._stderr_reader = threading.Thread(
            target=self._drain_stderr,
            name="fikeya-puppeteer-errors",
            daemon=True,
        )
        self._reader.start()
        self._stderr_reader.start()
        try:
            message = self._next_message(time.monotonic() + _BRIDGE_START_SECONDS)
            if message.get("type") == "unavailable":
                raise BrowserUnavailable(
                    "Puppeteer could not be loaded from the configured directory."
                )
            if message.get("type") != "ready":
                raise _BridgeFailure("bridge did not send ready")
            version = message.get("version")
            if not isinstance(version, str) or not version or len(version) > 64:
                raise _BridgeFailure("bridge version is invalid")
        except BrowserUnavailable:
            self._terminate()
            raise
        except (BrowserError, _BridgeFailure) as error:
            self._terminate()
            raise BrowserUnavailable(
                "The Puppeteer browser transport failed its startup handshake."
            ) from error

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while True:
                line = process.stdout.readline(MAX_PUPPETEER_BRIDGE_MESSAGE_BYTES + 1)
                if not line:
                    self._messages.put(_BridgeFailure("bridge output ended"))
                    return
                if len(line) > MAX_PUPPETEER_BRIDGE_MESSAGE_BYTES or not line.endswith(
                    b"\n"
                ):
                    self._messages.put(_BridgeFailure("bridge message is oversized"))
                    return
                try:
                    value = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    self._messages.put(_BridgeFailure("bridge message is invalid"))
                    self._messages.put(error)
                    return
                if not isinstance(value, dict):
                    self._messages.put(_BridgeFailure("bridge message is not an object"))
                    return
                self._messages.put(value)
        except OSError as error:
            self._messages.put(_BridgeFailure("bridge output failed"))
            self._messages.put(error)

    def _drain_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        # Chromium and Node diagnostics may contain URLs.  Drain to avoid a
        # blocked child, but never retain or surface the content.
        try:
            while process.stderr.read(8_192):
                pass
        except OSError:
            return

    def _next_message(self, deadline: float) -> dict[str, Any]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _BridgeFailure("bridge response timed out")
        try:
            value = self._messages.get(timeout=remaining)
        except queue.Empty as error:
            raise _BridgeFailure("bridge response timed out") from error
        if isinstance(value, BaseException):
            raise _BridgeFailure("bridge reader failed") from value
        return value

    def _send(self, value: dict[str, object]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.poll() is not None:
            raise _BridgeFailure("bridge process is unavailable")
        payload = json.dumps(
            value, ensure_ascii=True, separators=(",", ":"), sort_keys=True
        ).encode("utf-8") + b"\n"
        if len(payload) > MAX_PUPPETEER_BRIDGE_MESSAGE_BYTES:
            raise _BridgeFailure("bridge request is oversized")
        try:
            with self._write_lock:
                process.stdin.write(payload)
                process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise _BridgeFailure("bridge input failed") from error

    def _answer_guard(self, message: dict[str, Any]) -> None:
        request_id = message.get("requestId")
        url = message.get("url")
        if (
            not isinstance(request_id, str)
            or not request_id
            or len(request_id) > 128
            or not isinstance(url, str)
        ):
            raise _BridgeFailure("bridge guard request is invalid")
        allowed = False
        if self._guard is None:
            raise BrowserSecurityError("Browser request guard is not installed.")
        try:
            self._guard(url)
            allowed = True
        except BrowserError:
            allowed = False
        self._send(
            {
                "type": "guardResult",
                "requestId": request_id,
                "allow": allowed,
            }
        )

    def _call(
        self,
        operation: str,
        arguments: dict[str, object],
        *,
        timeout_ms: int,
    ) -> object:
        self._ensure_started()
        self._request_number += 1
        request_id = f"browser-{self._request_number}"
        deadline = time.monotonic() + (timeout_ms / 1_000) + 2.0
        try:
            self._send(
                {
                    "type": "command",
                    "requestId": request_id,
                    "operation": operation,
                    "arguments": arguments,
                    "timeoutMs": timeout_ms,
                }
            )
            while True:
                message = self._next_message(deadline)
                if message.get("type") == "guard":
                    self._answer_guard(message)
                    continue
                if message.get("type") != "result" or message.get(
                    "requestId"
                ) != request_id:
                    raise _BridgeFailure("bridge response is out of sequence")
                if message.get("ok") is not True:
                    raise BrowserError(
                        f"Puppeteer {operation} did not complete safely."
                    )
                if set(message) - {"type", "requestId", "ok", "value"}:
                    raise _BridgeFailure("bridge response has unknown fields")
                return message.get("value")
        except BrowserError:
            raise
        except _BridgeFailure as error:
            self._terminate()
            raise BrowserError(
                f"Puppeteer {operation} did not complete safely."
            ) from error

    def navigate(self, url: str, *, timeout_ms: int) -> None:
        self._call("navigate", {"url": url}, timeout_ms=timeout_ms)

    def current_url(self) -> str:
        value = self._call("currentUrl", {}, timeout_ms=10_000)
        if not isinstance(value, str):
            raise BrowserError("Puppeteer returned an invalid page URL.")
        return value

    def inspect(self, kind: BrowserSnapshotKind, *, timeout_ms: int) -> str:
        value = self._call("inspect", {"kind": kind}, timeout_ms=timeout_ms)
        if not isinstance(value, str):
            raise BrowserError("Puppeteer returned an invalid page snapshot.")
        return value

    def click(self, selector: str, *, timeout_ms: int) -> None:
        self._call("click", {"selector": selector}, timeout_ms=timeout_ms)

    def type_text(
        self, selector: str, text: str, *, clear: bool, timeout_ms: int
    ) -> None:
        self._call(
            "type",
            {"selector": selector, "text": text, "clear": clear},
            timeout_ms=timeout_ms,
        )

    def scroll(self, delta_x: int, delta_y: int, *, timeout_ms: int) -> None:
        self._call(
            "scroll",
            {"deltaX": delta_x, "deltaY": delta_y},
            timeout_ms=timeout_ms,
        )

    def screenshot(self, *, timeout_ms: int) -> bytes:
        value = self._call("screenshot", {}, timeout_ms=timeout_ms)
        if not isinstance(value, str):
            raise BrowserError("Puppeteer returned an invalid screenshot.")
        try:
            import base64

            screenshot = base64.b64decode(value, validate=True)
        except (ValueError, TypeError) as error:
            raise BrowserError("Puppeteer returned an invalid screenshot.") from error
        if len(screenshot) > MAX_SCREENSHOT_BYTES:
            raise BrowserError("Puppeteer returned an oversized screenshot.")
        return screenshot

    def wait(self, milliseconds: int) -> None:
        self._call(
            "wait",
            {"milliseconds": milliseconds},
            timeout_ms=max(1, milliseconds),
        )

    def close(self) -> None:
        process = self._process
        if process is None:
            return
        if process.poll() is None:
            with suppress(BrowserError, _BridgeFailure):
                self._call(
                    "close",
                    {},
                    timeout_ms=int(_BRIDGE_SHUTDOWN_SECONDS * 1_000),
                )
        self._terminate()

    def _terminate(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.stdin is not None:
            with suppress(OSError):
                process.stdin.close()
        if process.poll() is None:
            with suppress(OSError):
                process.terminate()
            try:
                process.wait(timeout=_BRIDGE_SHUTDOWN_SECONDS)
            except subprocess.TimeoutExpired:
                with suppress(OSError):
                    process.kill()
                with suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=_BRIDGE_SHUTDOWN_SECONDS)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                with suppress(OSError):
                    stream.close()
