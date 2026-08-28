# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import importlib.util
import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from fikeya_runtime.browser import (
    MAX_INPUT_BYTES,
    MAX_SCREENSHOT_BYTES,
    MAX_SCREENSHOTS,
    MAX_SCROLL_DELTA,
    MAX_SELECTOR_LENGTH,
    MAX_SNAPSHOT_BYTES,
    MAX_URL_LENGTH,
    MAX_WAIT_MS,
    BrowserError,
    BrowserLimitError,
    BrowserSecurityError,
    BrowserSession,
    BrowserSnapshotKind,
    BrowserUnavailable,
)
from fikeya_runtime.util import sha256_bytes, sha256_text

PUBLIC_ADDRESS = "93.184.216.34"
PNG = b"\x89PNG\r\n\x1a\nfixture"


class FakeDriver:
    def __init__(self) -> None:
        self.guard: Callable[[str], None] | None = None
        self.url = "about:blank"
        self.snapshot = "fixture text"
        self.screenshot_bytes = PNG
        self.typed: list[tuple[str, str, bool]] = []
        self.clicks: list[str] = []
        self.scrolls: list[tuple[int, int]] = []
        self.waits: list[int] = []
        self.closed = False

    def set_request_guard(self, guard: Callable[[str], None]) -> None:
        self.guard = guard

    def navigate(self, url: str, *, timeout_ms: int) -> None:
        assert timeout_ms > 0
        assert self.guard is not None
        self.guard(url)
        self.url = url

    def current_url(self) -> str:
        return self.url

    def inspect(self, kind: BrowserSnapshotKind, *, timeout_ms: int) -> str:
        assert kind in {"accessible", "text"}
        assert timeout_ms > 0
        return self.snapshot

    def click(self, selector: str, *, timeout_ms: int) -> None:
        assert timeout_ms > 0
        self.clicks.append(selector)

    def type_text(
        self, selector: str, text: str, *, clear: bool, timeout_ms: int
    ) -> None:
        assert timeout_ms > 0
        self.typed.append((selector, text, clear))

    def scroll(self, delta_x: int, delta_y: int, *, timeout_ms: int) -> None:
        assert timeout_ms > 0
        self.scrolls.append((delta_x, delta_y))

    def screenshot(self, *, timeout_ms: int) -> bytes:
        assert timeout_ms > 0
        return self.screenshot_bytes

    def wait(self, milliseconds: int) -> None:
        self.waits.append(milliseconds)

    def close(self) -> None:
        self.closed = True


def public_resolver(_hostname: str, _port: int) -> tuple[str]:
    return (PUBLIC_ADDRESS,)


def session(tmp_path: Path, driver: FakeDriver | None = None) -> BrowserSession:
    return BrowserSession(
        tmp_path,
        driver=driver or FakeDriver(),
        resolver=public_resolver,
    )


def test_all_operations_return_bounded_receipts_without_retaining_input(
    tmp_path: Path,
) -> None:
    driver = FakeDriver()
    browser = session(tmp_path, driver)

    navigated = browser.navigate("https://example.test/start?q=public#section")
    inspected = browser.inspect("text")
    clicked = browser.click("#button")
    secret = "do-not-retain-this-value"
    typed = browser.type("#input", secret)
    scrolled = browser.scroll(500, delta_x=10)
    captured = browser.screenshot("artifacts/page.png")
    waited = browser.wait(25)
    closed = browser.close()

    results = [
        navigated,
        inspected,
        clicked,
        typed,
        scrolled,
        captured,
        waited,
        closed,
    ]
    assert [result.receipt.action for result in results] == [
        "navigate",
        "inspect",
        "click",
        "type",
        "scroll",
        "screenshot",
        "wait",
        "close",
    ]
    assert all(
        result.receipt.evidence_sha256.startswith("sha256:") for result in results
    )
    assert all(result.receipt.url == "https://example.test/start" for result in results)
    assert inspected.text == "fixture text"
    assert inspected.receipt.evidence_sha256 == sha256_text("fixture text")
    assert captured.screenshot_path == "artifacts/page.png"
    assert captured.receipt.evidence_sha256 == sha256_bytes(PNG)
    assert (tmp_path / "artifacts" / "page.png").read_bytes() == PNG
    assert driver.typed == [("#input", secret, True)]
    assert driver.clicks == ["#button"]
    assert driver.scrolls == [(10, 500)]
    assert driver.waits == [25]
    assert driver.closed
    assert secret not in json.dumps(typed.as_json(), sort_keys=True)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.test/file",
        "https://user:password@example.test/",
        "https://example.test/?access_token=value",
        "https://example.test/#api_key=value",
        "http://localhost/",
        "http://sub.localhost/",
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.0.2.1/",
        "http://[::1]/",
    ],
)
def test_navigation_rejects_unsafe_urls(tmp_path: Path, url: str) -> None:
    driver = FakeDriver()

    with pytest.raises(BrowserSecurityError):
        session(tmp_path, driver).navigate(url)

    assert driver.url == "about:blank"


def test_navigation_rejects_mixed_public_and_private_dns_answers(
    tmp_path: Path,
) -> None:
    browser = BrowserSession(
        tmp_path,
        driver=FakeDriver(),
        resolver=lambda _hostname, _port: (PUBLIC_ADDRESS, "127.0.0.1"),
    )

    with pytest.raises(BrowserSecurityError, match="Private"):
        browser.navigate("https://mixed.example.test/")


def test_private_destinations_require_explicit_opt_in(tmp_path: Path) -> None:
    driver = FakeDriver()
    browser = BrowserSession(tmp_path, allow_private=True, driver=driver)

    result = browser.navigate("http://127.0.0.1:8765/fixture")

    assert result.receipt.url == "http://127.0.0.1:8765/fixture"


def test_unsafe_final_url_closes_the_session(tmp_path: Path) -> None:
    class RedirectingDriver(FakeDriver):
        def navigate(self, url: str, *, timeout_ms: int) -> None:
            super().navigate(url, timeout_ms=timeout_ms)
            self.url = "http://127.0.0.1/internal"

    driver = RedirectingDriver()
    browser = session(tmp_path, driver)

    with pytest.raises(BrowserSecurityError, match="Private"):
        browser.navigate("https://example.test/")

    assert driver.closed
    with pytest.raises(BrowserError, match="closed"):
        browser.inspect()


def test_url_and_output_limits_are_enforced(tmp_path: Path) -> None:
    driver = FakeDriver()
    browser = session(tmp_path, driver)

    with pytest.raises(BrowserSecurityError, match=str(MAX_URL_LENGTH)):
        browser.navigate("https://example.test/" + "a" * MAX_URL_LENGTH)

    browser.navigate("https://example.test/")
    driver.snapshot = "é" * MAX_SNAPSHOT_BYTES
    result = browser.inspect("accessible")
    assert result.truncated
    assert result.text is not None
    assert len(result.text.encode("utf-8")) <= MAX_SNAPSHOT_BYTES

    with pytest.raises(BrowserLimitError, match=str(MAX_SELECTOR_LENGTH)):
        browser.click("a" * (MAX_SELECTOR_LENGTH + 1))
    with pytest.raises(BrowserLimitError, match=str(MAX_INPUT_BYTES)):
        browser.type("#input", "a" * (MAX_INPUT_BYTES + 1))
    with pytest.raises(BrowserLimitError, match=str(MAX_SCROLL_DELTA)):
        browser.scroll(MAX_SCROLL_DELTA + 1)
    with pytest.raises(BrowserLimitError, match=str(MAX_WAIT_MS)):
        browser.wait(MAX_WAIT_MS + 1)


def test_screenshot_path_size_and_count_are_bounded(tmp_path: Path) -> None:
    driver = FakeDriver()
    browser = session(tmp_path, driver)
    browser.navigate("https://example.test/")

    with pytest.raises(BrowserSecurityError, match="workspace"):
        browser.screenshot("../outside.png")
    with pytest.raises(BrowserSecurityError, match="workspace"):
        browser.screenshot(tmp_path / "absolute.png")
    with pytest.raises(BrowserSecurityError, match=".png"):
        browser.screenshot("artifacts/page.jpg")
    with pytest.raises(BrowserSecurityError, match="metadata"):
        browser.screenshot(".FIKEYA/browser.png")

    driver.screenshot_bytes = PNG + b"x" * MAX_SCREENSHOT_BYTES
    with pytest.raises(BrowserLimitError, match=str(MAX_SCREENSHOT_BYTES)):
        browser.screenshot("artifacts/too-large.png")

    driver.screenshot_bytes = b"not-a-png"
    with pytest.raises(BrowserSecurityError, match="PNG"):
        browser.screenshot("artifacts/not-a-png.png")

    driver.screenshot_bytes = PNG
    for index in range(MAX_SCREENSHOTS):
        browser.screenshot(f"artifacts/{index}.png")
    with pytest.raises(BrowserLimitError, match=str(MAX_SCREENSHOTS)):
        browser.screenshot("artifacts/overflow.png")


def test_operations_require_navigation_and_closed_session_is_terminal(
    tmp_path: Path,
) -> None:
    browser = session(tmp_path)

    with pytest.raises(BrowserError, match="Navigate"):
        browser.inspect()
    first = browser.close()
    second = browser.close()
    assert first.receipt.action == second.receipt.action == "close"
    with pytest.raises(BrowserError, match="closed"):
        browser.navigate("https://example.test/")


def test_timeout_and_session_lifetime_are_bounded(tmp_path: Path) -> None:
    with pytest.raises(BrowserLimitError, match="30000"):
        BrowserSession(tmp_path, timeout_ms=30_001, driver=FakeDriver())

    now = [100.0]
    browser = BrowserSession(
        tmp_path,
        driver=FakeDriver(),
        resolver=public_resolver,
        clock=lambda: now[0],
    )
    now[0] += 301.0
    with pytest.raises(BrowserLimitError, match="300 seconds"):
        browser.navigate("https://example.test/")


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = b"""<!doctype html><html><body>
        <label>Name <input id='name'></label>
        <button id='go' onclick="document.querySelector('#result').textContent='Done ' + document.querySelector('#name').value">Go</button>
        <p id='result'>Ready</p>
        </body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def test_playwright_local_fixture_when_browser_is_available(tmp_path: Path) -> None:
    if importlib.util.find_spec("playwright") is None:
        pytest.skip("optional Python Playwright dependency is not installed")

    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    browser = BrowserSession(tmp_path, allow_private=True)
    try:
        try:
            browser.navigate(f"http://127.0.0.1:{server.server_port}/")
        except BrowserUnavailable as error:
            pytest.skip(str(error))
        assert "Ready" in (browser.inspect("text").text or "")
        browser.type("#name", "Fikeya")
        browser.click("#go")
        assert "Done Fikeya" in (browser.inspect("text").text or "")
        result = browser.screenshot("artifacts/local-fixture.png")
        assert result.screenshot_path == "artifacts/local-fixture.png"
        assert (tmp_path / result.screenshot_path).is_file()
    finally:
        browser.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
