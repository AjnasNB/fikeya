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
import re
import shutil
import subprocess
import threading
import time
from hashlib import sha256
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
from .process_tree import ManagedProcessTree, start_managed_process

MAX_PUPPETEER_BRIDGE_MESSAGE_BYTES = 12 * 1_024 * 1_024
MAX_PUPPETEER_BRIDGE_MESSAGES = 128
PUPPETEER_ROOT_ENVIRONMENT = "FIKEYA_PUPPETEER_ROOT"
CHROME_EXECUTABLE_ENVIRONMENT = "FIKEYA_CHROME_EXECUTABLE"
_BRIDGE_SHUTDOWN_SECONDS = 3.0
_BRIDGE_START_SECONDS = 30.0
_MAX_PACKAGE_METADATA_BYTES = 2 * 1_024 * 1_024
_NPM_INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]+={0,2}$")
_SAFE_BRIDGE_ENVIRONMENT = (
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
)


class _BridgeFailure(Exception):
    """Internal protocol failure that is never displayed verbatim."""


def _minimal_bridge_environment() -> dict[str, str]:
    """Return a small non-credential environment for trusted Node/Chromium code."""

    environment: dict[str, str] = {}
    for name in _SAFE_BRIDGE_ENVIRONMENT:
        value = os.environ.get(name)
        if value and "\x00" not in value and len(value) <= 16_384:
            environment[name] = value
    environment["NO_COLOR"] = "1"
    return environment


def _read_metadata(path: Path) -> tuple[dict[str, Any], bytes]:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise BrowserUnavailable(
            "The reviewed Puppeteer installation metadata is unavailable."
        ) from error
    if not payload or len(payload) > _MAX_PACKAGE_METADATA_BYTES:
        raise BrowserUnavailable(
            "The reviewed Puppeteer installation metadata is invalid."
        )
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BrowserUnavailable(
            "The reviewed Puppeteer installation metadata is invalid."
        ) from error
    if not isinstance(value, dict):
        raise BrowserUnavailable(
            "The reviewed Puppeteer installation metadata is invalid."
        )
    return value, payload


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
        chrome_executable: str | Path | None = None,
        node_executable: str | Path | None = None,
        bridge_script: str | Path | None = None,
    ) -> None:
        supplied_root = module_root or os.environ.get(PUPPETEER_ROOT_ENVIRONMENT)
        supplied_chrome = chrome_executable or os.environ.get(
            CHROME_EXECUTABLE_ENVIRONMENT
        )
        self._module_root = Path(supplied_root).expanduser() if supplied_root else None
        self._chrome_executable = (
            Path(supplied_chrome).expanduser() if supplied_chrome else None
        )
        self._node_executable = str(node_executable) if node_executable else None
        self._bridge_script = (
            Path(bridge_script)
            if bridge_script is not None
            else Path(__file__).with_name("puppeteer_bridge.mjs")
        )
        self._guard: Callable[[str], None] | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._process_tree: ManagedProcessTree | None = None
        self._messages: queue.Queue[dict[str, Any] | BaseException] = queue.Queue(
            maxsize=MAX_PUPPETEER_BRIDGE_MESSAGES
        )
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._request_number = 0
        self._write_lock = threading.Lock()

    def set_request_guard(self, guard: Callable[[str], None]) -> None:
        self._guard = guard

    def _resolve_installation(
        self,
    ) -> tuple[str, Path, Path, Path | None, str, str, str]:
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
        chrome_executable: Path | None = None
        if self._chrome_executable is not None:
            try:
                chrome_executable = self._chrome_executable.resolve(strict=True)
            except OSError as error:
                raise BrowserUnavailable(
                    "The configured Chrome executable is unavailable."
                ) from error
            if not chrome_executable.is_file():
                raise BrowserUnavailable(
                    "The configured Chrome executable is unavailable."
                )
        root_metadata, _ = _read_metadata(module_root / "package.json")
        lock_metadata, lock_payload = _read_metadata(module_root / "package-lock.json")
        declared: set[str] = set()
        for group in ("dependencies", "devDependencies", "optionalDependencies"):
            values = root_metadata.get(group, {})
            if isinstance(values, dict):
                declared.update(
                    name
                    for name in ("puppeteer", "puppeteer-core")
                    if name in values
                )
        if len(declared) != 1:
            raise BrowserUnavailable(
                "Use a dedicated npm install declaring exactly one of puppeteer or "
                "puppeteer-core and retaining package-lock.json."
            )
        package_name = declared.pop()
        packages = lock_metadata.get("packages")
        lock_entry = (
            packages.get(f"node_modules/{package_name}")
            if isinstance(packages, dict)
            else None
        )
        if not isinstance(lock_entry, dict):
            raise BrowserUnavailable(
                "The Puppeteer package is missing from package-lock.json."
            )
        expected_version = lock_entry.get("version")
        integrity = lock_entry.get("integrity")
        if (
            not isinstance(expected_version, str)
            or not expected_version
            or len(expected_version) > 64
            or not isinstance(integrity, str)
            or _NPM_INTEGRITY.fullmatch(integrity) is None
        ):
            raise BrowserUnavailable(
                "The Puppeteer lock entry needs an exact version and npm integrity digest."
            )
        package_directory = module_root / "node_modules" / package_name
        try:
            package_directory = package_directory.resolve(strict=True)
            package_directory.relative_to(module_root)
        except (OSError, ValueError) as error:
            raise BrowserUnavailable(
                "The installed Puppeteer package must remain inside its reviewed root."
            ) from error
        package_metadata, _ = _read_metadata(package_directory / "package.json")
        if (
            package_metadata.get("name") != package_name
            or package_metadata.get("version") != expected_version
        ):
            raise BrowserUnavailable(
                "The installed Puppeteer package does not match package-lock.json."
            )
        return (
            executable,
            module_root,
            bridge_script,
            chrome_executable,
            package_name,
            expected_version,
            sha256(lock_payload).hexdigest(),
        )

    def _ensure_started(self) -> None:
        if self._process is not None:
            if self._process.poll() is not None:
                self._terminate()
                raise BrowserUnavailable("The Puppeteer browser transport stopped.")
            return
        (
            executable,
            module_root,
            bridge_script,
            chrome_executable,
            package_name,
            package_version,
            lock_sha256,
        ) = self._resolve_installation()
        command = [
            executable,
            str(bridge_script),
            str(module_root),
            str(chrome_executable or ""),
            package_name,
            package_version,
            lock_sha256,
        ]
        try:
            process, process_tree = start_managed_process(
                command,
                cwd=module_root,
                environment=_minimal_bridge_environment(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as error:
            raise BrowserUnavailable(
                "The Puppeteer browser transport could not be started."
            ) from error
        self._process = process
        self._process_tree = process_tree
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
            if (
                message.get("package") != package_name
                or message.get("version") != package_version
                or message.get("lockSha256") != lock_sha256
            ):
                raise _BridgeFailure("bridge provenance is invalid")
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
                    self._put_message(_BridgeFailure("bridge output ended"))
                    return
                if len(line) > MAX_PUPPETEER_BRIDGE_MESSAGE_BYTES or not line.endswith(
                    b"\n"
                ):
                    self._put_message(_BridgeFailure("bridge message is oversized"))
                    return
                try:
                    value = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._put_message(_BridgeFailure("bridge message is invalid"))
                    return
                if not isinstance(value, dict):
                    self._put_message(
                        _BridgeFailure("bridge message is not an object")
                    )
                    return
                self._put_message(value)
        except OSError:
            self._put_message(_BridgeFailure("bridge output failed"))

    def _put_message(self, value: dict[str, Any] | BaseException) -> None:
        """Bound bridge output and fail closed instead of buffering indefinitely."""

        try:
            self._messages.put_nowait(value)
            return
        except queue.Full:
            pass
        with suppress(queue.Empty):
            self._messages.get_nowait()
        with suppress(queue.Full):
            self._messages.put_nowait(_BridgeFailure("bridge output queue overflowed"))

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
        process_tree = self._process_tree
        self._process = None
        self._process_tree = None
        if process is None:
            return
        if process.stdin is not None:
            with suppress(OSError):
                process.stdin.close()
        if process_tree is not None:
            try:
                with suppress(OSError):
                    process_tree.terminate()
            finally:
                with suppress(OSError):
                    process_tree.close()
        elif process.poll() is None:
            # Defensive fallback for a partially initialized transport.
            with suppress(OSError):
                process.kill()
        with suppress(subprocess.TimeoutExpired):
            process.wait(timeout=_BRIDGE_SHUTDOWN_SECONDS)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                with suppress(OSError):
                    stream.close()
