# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Bounded, auditable browser operations backed optionally by Playwright.

This module deliberately has no dependency on the CLI, desktop UI, or autonomy
loop.  :class:`BrowserSession` owns the security policy; the Playwright driver
is a replaceable transport so the policy can be tested without a browser.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import tempfile
import time
from collections.abc import Callable, Iterable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from .errors import FikeyaError, WorkspaceError
from .util import sha256_bytes, sha256_text, stable_json
from .workspace import WorkspaceBoundary

BrowserAction = Literal[
    "navigate", "inspect", "click", "type", "scroll", "screenshot", "wait", "close"
]
BrowserSnapshotKind = Literal["accessible", "text"]

MAX_URL_LENGTH = 2_048
MAX_SELECTOR_LENGTH = 1_024
MAX_INPUT_BYTES = 32 * 1_024
MAX_SNAPSHOT_BYTES = 64 * 1_024
MAX_SCREENSHOT_BYTES = 8 * 1_024 * 1_024
MAX_SCREENSHOTS = 8
DEFAULT_TIMEOUT_MS = 10_000
MAX_TIMEOUT_MS = 30_000
MAX_WAIT_MS = 10_000
MAX_SESSION_SECONDS = 300.0
MAX_SCROLL_DELTA = 100_000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_CREDENTIAL_QUERY_KEYS = frozenset(
    {
        "access_token",
        "apikey",
        "api_key",
        "auth",
        "authorization",
        "client_secret",
        "credential",
        "key",
        "password",
        "passwd",
        "secret",
        "sig",
        "signature",
        "token",
        "x-amz-credential",
        "x-amz-security-token",
        "x-amz-signature",
    }
)


class BrowserError(FikeyaError):
    """Base class for safe-to-display browser failures."""


class BrowserSecurityError(BrowserError):
    """Raised when an operation crosses a browser security boundary."""


class BrowserLimitError(BrowserError):
    """Raised when an operation exceeds a documented resource limit."""


class BrowserUnavailable(BrowserError):
    """Raised when the optional browser dependency or Chromium is unavailable."""


@dataclass(frozen=True, slots=True)
class BrowserReceipt:
    """Content-minimal evidence for one completed browser action."""

    action: BrowserAction
    url: str | None
    evidence_sha256: str
    duration_ms: int

    def as_json(self) -> dict[str, object]:
        """Return the stable protocol representation."""

        return {
            "action": self.action,
            "durationMs": self.duration_ms,
            "evidenceSha256": self.evidence_sha256,
            "url": self.url,
        }


@dataclass(frozen=True, slots=True)
class BrowserActionResult:
    """Bounded result data and its content-minimal receipt."""

    receipt: BrowserReceipt
    text: str | None = None
    screenshot_path: str | None = None
    truncated: bool = False

    def as_json(self) -> dict[str, object]:
        """Return a JSON-compatible representation."""

        value: dict[str, object] = {
            "receipt": self.receipt.as_json(),
            "truncated": self.truncated,
        }
        if self.text is not None:
            value["text"] = self.text
        if self.screenshot_path is not None:
            value["screenshotPath"] = self.screenshot_path
        return value


class BrowserDriver(Protocol):
    """Transport contract used by :class:`BrowserSession`."""

    def set_request_guard(self, guard: Callable[[str], None]) -> None:
        """Install a guard invoked before each browser network request."""

    def navigate(self, url: str, *, timeout_ms: int) -> None:
        """Navigate the active page."""

    def current_url(self) -> str:
        """Return the active page URL."""

    def inspect(self, kind: BrowserSnapshotKind, *, timeout_ms: int) -> str:
        """Return an accessibility or visible-text snapshot."""

    def click(self, selector: str, *, timeout_ms: int) -> None:
        """Click one locator."""

    def type_text(
        self, selector: str, text: str, *, clear: bool, timeout_ms: int
    ) -> None:
        """Enter text into one locator."""

    def scroll(self, delta_x: int, delta_y: int, *, timeout_ms: int) -> None:
        """Scroll the active page."""

    def screenshot(self, *, timeout_ms: int) -> bytes:
        """Return a viewport-only PNG screenshot."""

    def wait(self, milliseconds: int) -> None:
        """Wait for a bounded interval."""

    def close(self) -> None:
        """Release browser resources."""


AddressResolver = Callable[[str, int], Iterable[str]]


def _resolve_addresses(hostname: str, port: int) -> tuple[str, ...]:
    addresses = {
        result[4][0]
        for result in socket.getaddrinfo(
            hostname,
            port,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
        )
    }
    return tuple(sorted(addresses))


class PlaywrightBrowserDriver:
    """Lazy synchronous Playwright transport.

    Importing ``fikeya_runtime`` never imports Playwright.  Browser resources
    are created on the first operation and remain optional at installation time.
    """

    def __init__(self) -> None:
        self._guard: Callable[[str], None] | None = None
        self._playwright: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._page: Any = None

    def set_request_guard(self, guard: Callable[[str], None]) -> None:
        self._guard = guard

    def _ensure_started(self) -> None:
        if self._page is not None:
            return
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as error:
            raise BrowserUnavailable(
                "Browser support is optional. Install 'fikeya-runtime[browser]' "
                "and then run 'playwright install chromium'."
            ) from error

        try:
            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(headless=True)
            self._context = self._browser.new_context(
                accept_downloads=False,
                ignore_https_errors=False,
                java_script_enabled=True,
                service_workers="block",
                viewport={"width": 1280, "height": 720},
            )
            self._context.route("**/*", self._route_request)
            # WebSockets are a separate network channel and are denied rather
            # than allowed to bypass the HTTP(S) request guard.
            self._context.route_web_socket("**/*", lambda route: route.close())
            self._page = self._context.new_page()
            self._page.on("popup", lambda popup: popup.close())
            self._page.on("dialog", lambda dialog: dialog.dismiss())
        except BrowserError:
            self.close()
            raise
        except Exception as error:
            self.close()
            raise BrowserUnavailable(
                "Chromium could not be started. Run 'playwright install chromium'."
            ) from error

    def _route_request(self, route: Any, request: Any) -> None:
        try:
            if self._guard is None:
                raise BrowserSecurityError("Browser request guard is not installed.")
            self._guard(request.url)
        except BrowserError:
            route.abort("blockedbyclient")
            return
        route.continue_()

    def navigate(self, url: str, *, timeout_ms: int) -> None:
        self._ensure_started()
        try:
            self._page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
        except Exception as error:
            raise BrowserError("Browser navigation did not complete safely.") from error

    def current_url(self) -> str:
        self._ensure_started()
        return str(self._page.url)

    def inspect(self, kind: BrowserSnapshotKind, *, timeout_ms: int) -> str:
        self._ensure_started()
        try:
            body = self._page.locator("body")
            if kind == "accessible":
                return str(body.aria_snapshot(timeout=timeout_ms))
            return str(body.inner_text(timeout=timeout_ms))
        except Exception as error:
            raise BrowserError("Browser inspection did not complete safely.") from error

    def click(self, selector: str, *, timeout_ms: int) -> None:
        self._ensure_started()
        try:
            self._page.locator(selector).click(timeout=timeout_ms)
        except Exception as error:
            raise BrowserError("Browser click did not complete safely.") from error

    def type_text(
        self, selector: str, text: str, *, clear: bool, timeout_ms: int
    ) -> None:
        self._ensure_started()
        try:
            locator = self._page.locator(selector)
            if clear:
                locator.fill(text, timeout=timeout_ms)
            else:
                locator.press_sequentially(text, timeout=timeout_ms)
        except Exception as error:
            raise BrowserError("Browser typing did not complete safely.") from error

    def scroll(self, delta_x: int, delta_y: int, *, timeout_ms: int) -> None:
        self._ensure_started()
        try:
            self._page.mouse.wheel(delta_x, delta_y)
            self._page.wait_for_timeout(min(timeout_ms, 100))
        except Exception as error:
            raise BrowserError("Browser scroll did not complete safely.") from error

    def screenshot(self, *, timeout_ms: int) -> bytes:
        self._ensure_started()
        try:
            value = self._page.screenshot(
                animations="disabled",
                full_page=False,
                timeout=timeout_ms,
                type="png",
            )
        except Exception as error:
            raise BrowserError("Browser screenshot did not complete safely.") from error
        if not isinstance(value, bytes):
            raise BrowserError("Browser returned an invalid screenshot.")
        return value

    def wait(self, milliseconds: int) -> None:
        self._ensure_started()
        try:
            self._page.wait_for_timeout(milliseconds)
        except Exception as error:
            raise BrowserError("Browser wait did not complete safely.") from error

    def close(self) -> None:
        for resource_name in ("_context", "_browser", "_playwright"):
            resource = getattr(self, resource_name)
            setattr(self, resource_name, None)
            if resource is not None:
                with suppress(Exception):
                    resource.stop() if resource_name == "_playwright" else resource.close()
        self._page = None


class BrowserSession:
    """Typed browser operations with network, time, output, and path bounds."""

    def __init__(
        self,
        workspace_root: str | Path,
        *,
        allow_private: bool = False,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        driver: BrowserDriver | None = None,
        resolver: AddressResolver = _resolve_addresses,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 1 <= timeout_ms <= MAX_TIMEOUT_MS:
            raise BrowserLimitError(
                f"Browser timeout must be between 1 and {MAX_TIMEOUT_MS} milliseconds."
            )
        self._boundary = WorkspaceBoundary(workspace_root)
        self._allow_private = allow_private
        self._timeout_ms = timeout_ms
        self._resolver = resolver
        self._clock = clock
        self._started_at = clock()
        self._driver: BrowserDriver = driver or PlaywrightBrowserDriver()
        self._driver.set_request_guard(self._validate_url)
        self._navigated = False
        self._closed = False
        self._screenshots = 0
        self._last_url: str | None = None

    def _remaining_timeout(self, requested_ms: int | None = None) -> int:
        if self._closed:
            raise BrowserError("Browser session is closed.")
        elapsed = self._clock() - self._started_at
        remaining_ms = int((MAX_SESSION_SECONDS - elapsed) * 1_000)
        if remaining_ms <= 0:
            self._closed = True
            self._driver.close()
            raise BrowserLimitError(
                f"Browser session exceeded {int(MAX_SESSION_SECONDS)} seconds."
            )
        timeout_ms = self._timeout_ms if requested_ms is None else requested_ms
        if not 1 <= timeout_ms <= MAX_TIMEOUT_MS:
            raise BrowserLimitError(
                f"Browser timeout must be between 1 and {MAX_TIMEOUT_MS} milliseconds."
            )
        return max(1, min(timeout_ms, remaining_ms))

    def _require_page(self) -> None:
        if not self._navigated:
            raise BrowserError("Navigate before using this browser operation.")

    def _validate_url(self, url: str) -> None:
        if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
            raise BrowserSecurityError(
                f"Browser URL must contain 1-{MAX_URL_LENGTH} characters."
            )
        if any(character.isspace() or ord(character) < 32 for character in url):
            raise BrowserSecurityError(
                "Browser URL contains invalid whitespace or controls."
            )
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError as error:
            raise BrowserSecurityError("Browser URL is malformed.") from error
        if parsed.scheme.lower() not in {"http", "https"}:
            raise BrowserSecurityError(
                "Browser navigation permits only HTTP and HTTPS."
            )
        if parsed.username is not None or parsed.password is not None:
            raise BrowserSecurityError("Credentials are not permitted in browser URLs.")
        if parsed.hostname is None:
            raise BrowserSecurityError("Browser URL must include a hostname.")
        query_keys = {
            key.casefold() for key, _ in parse_qsl(parsed.query, keep_blank_values=True)
        }
        fragment_keys = {
            key.casefold()
            for key, _ in parse_qsl(parsed.fragment, keep_blank_values=True)
        }
        if (query_keys | fragment_keys) & _CREDENTIAL_QUERY_KEYS:
            raise BrowserSecurityError(
                "Credential parameters are not permitted in browser URLs."
            )
        if self._allow_private:
            return

        hostname = parsed.hostname.rstrip(".").casefold()
        if hostname == "localhost" or hostname.endswith(".localhost"):
            raise BrowserSecurityError(
                "Private browser network destinations are blocked."
            )
        effective_port = port or (443 if parsed.scheme.lower() == "https" else 80)
        try:
            literal = ipaddress.ip_address(hostname)
            addresses = (literal,)
        except ValueError:
            try:
                addresses = tuple(
                    ipaddress.ip_address(address)
                    for address in self._resolver(hostname, effective_port)
                )
            except (OSError, ValueError) as error:
                raise BrowserSecurityError(
                    "Browser hostname could not be resolved safely."
                ) from error
        if not addresses or any(not address.is_global for address in addresses):
            raise BrowserSecurityError(
                "Private browser network destinations are blocked."
            )

    @staticmethod
    def _receipt_url(url: str) -> str:
        parsed = urlsplit(url)
        # Query strings and fragments often carry transient or sensitive values;
        # receipts retain the destination while never persisting either field.
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", "", ""))

    def _current_receipt_url(self) -> str:
        current = self._driver.current_url()
        try:
            self._validate_url(current)
        except BrowserSecurityError:
            self._driver.close()
            self._closed = True
            raise
        self._last_url = self._receipt_url(current)
        return self._last_url

    def _receipt(
        self,
        action: BrowserAction,
        started_at: float,
        url: str | None,
        evidence: bytes | str | dict[str, object],
    ) -> BrowserReceipt:
        if isinstance(evidence, bytes):
            evidence_hash = sha256_bytes(evidence)
        elif isinstance(evidence, str):
            evidence_hash = sha256_text(evidence)
        else:
            evidence_hash = sha256_text(stable_json(evidence))
        return BrowserReceipt(
            action=action,
            url=url,
            evidence_sha256=evidence_hash,
            duration_ms=max(0, int((self._clock() - started_at) * 1_000)),
        )

    @staticmethod
    def _validate_selector(selector: str) -> None:
        if not isinstance(selector, str) or not selector:
            raise BrowserLimitError("Browser selector must not be empty.")
        if len(selector.encode("utf-8")) > MAX_SELECTOR_LENGTH:
            raise BrowserLimitError(
                f"Browser selector exceeds {MAX_SELECTOR_LENGTH} UTF-8 bytes."
            )

    @staticmethod
    def _truncate_text(value: str) -> tuple[str, bool]:
        encoded = value.encode("utf-8")
        if len(encoded) <= MAX_SNAPSHOT_BYTES:
            return value, False
        return encoded[:MAX_SNAPSHOT_BYTES].decode("utf-8", errors="ignore"), True

    def navigate(
        self, url: str, *, timeout_ms: int | None = None
    ) -> BrowserActionResult:
        """Navigate to a validated HTTP(S) URL."""

        started_at = self._clock()
        timeout = self._remaining_timeout(timeout_ms)
        self._validate_url(url)
        self._driver.navigate(url, timeout_ms=timeout)
        current = self._current_receipt_url()
        self._navigated = True
        receipt = self._receipt(
            "navigate", started_at, current, {"action": "navigate", "url": current}
        )
        return BrowserActionResult(receipt=receipt)

    def inspect(
        self,
        kind: BrowserSnapshotKind = "accessible",
        *,
        timeout_ms: int | None = None,
    ) -> BrowserActionResult:
        """Return a UTF-8 bounded accessibility or visible-text snapshot."""

        started_at = self._clock()
        timeout = self._remaining_timeout(timeout_ms)
        self._require_page()
        if kind not in {"accessible", "text"}:
            raise BrowserLimitError(
                "Browser snapshot kind must be 'accessible' or 'text'."
            )
        text, truncated = self._truncate_text(
            self._driver.inspect(kind, timeout_ms=timeout)
        )
        current = self._current_receipt_url()
        receipt = self._receipt("inspect", started_at, current, text)
        return BrowserActionResult(receipt=receipt, text=text, truncated=truncated)

    def click(
        self, selector: str, *, timeout_ms: int | None = None
    ) -> BrowserActionResult:
        """Click one bounded selector."""

        started_at = self._clock()
        timeout = self._remaining_timeout(timeout_ms)
        self._require_page()
        self._validate_selector(selector)
        self._driver.click(selector, timeout_ms=timeout)
        current = self._current_receipt_url()
        receipt = self._receipt(
            "click", started_at, current, {"action": "click", "url": current}
        )
        return BrowserActionResult(receipt=receipt)

    def type(
        self,
        selector: str,
        text: str,
        *,
        clear: bool = True,
        timeout_ms: int | None = None,
    ) -> BrowserActionResult:
        """Enter bounded text without retaining it in the receipt."""

        started_at = self._clock()
        timeout = self._remaining_timeout(timeout_ms)
        self._require_page()
        self._validate_selector(selector)
        if not isinstance(text, str):
            raise BrowserLimitError("Browser input must be text.")
        input_bytes = len(text.encode("utf-8"))
        if input_bytes > MAX_INPUT_BYTES:
            raise BrowserLimitError(
                f"Browser input exceeds {MAX_INPUT_BYTES} UTF-8 bytes."
            )
        self._driver.type_text(selector, text, clear=clear, timeout_ms=timeout)
        current = self._current_receipt_url()
        receipt = self._receipt(
            "type",
            started_at,
            current,
            {"action": "type", "inputBytes": input_bytes, "url": current},
        )
        return BrowserActionResult(receipt=receipt)

    def scroll(
        self,
        delta_y: int,
        *,
        delta_x: int = 0,
        timeout_ms: int | None = None,
    ) -> BrowserActionResult:
        """Scroll by bounded integer pixel deltas."""

        started_at = self._clock()
        timeout = self._remaining_timeout(timeout_ms)
        self._require_page()
        if (
            isinstance(delta_x, bool)
            or isinstance(delta_y, bool)
            or not isinstance(delta_x, int)
            or not isinstance(delta_y, int)
            or abs(delta_x) > MAX_SCROLL_DELTA
            or abs(delta_y) > MAX_SCROLL_DELTA
        ):
            raise BrowserLimitError(
                f"Browser scroll deltas must be integers from -{MAX_SCROLL_DELTA} "
                f"to {MAX_SCROLL_DELTA}."
            )
        self._driver.scroll(delta_x, delta_y, timeout_ms=timeout)
        current = self._current_receipt_url()
        receipt = self._receipt(
            "scroll",
            started_at,
            current,
            {"action": "scroll", "deltaX": delta_x, "deltaY": delta_y, "url": current},
        )
        return BrowserActionResult(receipt=receipt)

    def screenshot(
        self, relative_path: str | Path, *, timeout_ms: int | None = None
    ) -> BrowserActionResult:
        """Write one bounded viewport PNG inside the workspace."""

        started_at = self._clock()
        timeout = self._remaining_timeout(timeout_ms)
        self._require_page()
        if self._screenshots >= MAX_SCREENSHOTS:
            raise BrowserLimitError(
                f"Browser session permits at most {MAX_SCREENSHOTS} screenshots."
            )
        supplied = Path(relative_path)
        if supplied.suffix.casefold() != ".png":
            raise BrowserSecurityError("Browser screenshots must use a .png path.")
        try:
            target = self._boundary.resolve(supplied)
        except WorkspaceError as error:
            raise BrowserSecurityError(
                "Browser screenshot path must remain inside the workspace."
            ) from error
        if any(
            part.casefold() == ".fikeya"
            for part in target.relative_to(self._boundary.root).parts
        ):
            raise BrowserSecurityError(
                "Browser screenshots cannot modify Fikeya workspace metadata."
            )
        value = self._driver.screenshot(timeout_ms=timeout)
        if len(value) > MAX_SCREENSHOT_BYTES:
            raise BrowserLimitError(
                f"Browser screenshot exceeds {MAX_SCREENSHOT_BYTES} bytes."
            )
        if not value.startswith(PNG_SIGNATURE):
            raise BrowserSecurityError("Browser screenshot is not a valid PNG payload.")
        self._atomic_write_bytes(target, value)
        self._screenshots += 1
        current = self._current_receipt_url()
        relative = target.relative_to(self._boundary.root).as_posix()
        receipt = self._receipt("screenshot", started_at, current, value)
        return BrowserActionResult(receipt=receipt, screenshot_path=relative)

    def _atomic_write_bytes(self, target: Path, value: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            validated = self._boundary.resolve(target.relative_to(self._boundary.root))
        except (ValueError, WorkspaceError) as error:
            raise BrowserSecurityError(
                "Browser screenshot path must remain inside the workspace."
            ) from error
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "wb",
                dir=validated.parent,
                prefix=f".{validated.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
                temporary_path = Path(handle.name)
            try:
                temporary_path.chmod(0o600)
            except OSError:
                pass
            # Re-resolve after writing the temporary file to narrow symlink races.
            validated = self._boundary.resolve(
                validated.relative_to(self._boundary.root)
            )
            os.replace(temporary_path, validated)
            temporary_path = None
            try:
                validated.chmod(0o600)
            except OSError:
                pass
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def wait(
        self,
        milliseconds: int,
        *,
        cancellation_requested: Callable[[], bool] | None = None,
    ) -> BrowserActionResult:
        """Wait for at most ten seconds within the session lifetime."""

        started_at = self._clock()
        self._require_page()
        if (
            isinstance(milliseconds, bool)
            or not isinstance(milliseconds, int)
            or not 0 <= milliseconds <= MAX_WAIT_MS
        ):
            raise BrowserLimitError(
                f"Browser wait must be an integer from 0 to {MAX_WAIT_MS} milliseconds."
            )
        remaining = self._remaining_timeout(max(1, milliseconds))
        if milliseconds > remaining:
            raise BrowserLimitError(
                "Browser wait exceeds the remaining session lifetime."
            )
        waited = 0
        while waited < milliseconds:
            if cancellation_requested is not None and cancellation_requested():
                raise BrowserError("Browser wait was cancelled.")
            interval = min(100, milliseconds - waited)
            self._driver.wait(interval)
            waited += interval
        if cancellation_requested is not None and cancellation_requested():
            raise BrowserError("Browser wait was cancelled.")
        current = self._current_receipt_url()
        receipt = self._receipt(
            "wait",
            started_at,
            current,
            {"action": "wait", "milliseconds": milliseconds, "url": current},
        )
        return BrowserActionResult(receipt=receipt)

    def close(self) -> BrowserActionResult:
        """Close the session idempotently and return a final receipt."""

        started_at = self._clock()
        url = self._last_url
        if not self._closed:
            self._driver.close()
            self._closed = True
        receipt = self._receipt(
            "close", started_at, url, {"action": "close", "url": url}
        )
        return BrowserActionResult(receipt=receipt)
