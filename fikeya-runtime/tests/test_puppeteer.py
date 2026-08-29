# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from fikeya_runtime.browser import (
    BrowserError,
    BrowserLimitError,
    BrowserSession,
    BrowserUnavailable,
)
from fikeya_runtime.puppeteer import (
    PUPPETEER_ROOT_ENVIRONMENT,
    PuppeteerBrowserDriver,
)

PUBLIC_ADDRESS = "93.184.216.34"
PNG = b"\x89PNG\r\n\x1a\npuppeteer-fixture"
_ORIGINAL_SOCKET_CONNECT = socket.socket.connect

_FAKE_BRIDGE = r'''import base64
import json
import sys

url = "about:blank"

def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

send({"type": "ready", "version": "test"})
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") != "command":
        continue
    request_id = message["requestId"]
    operation = message["operation"]
    arguments = message["arguments"]
    if operation == "navigate":
        guards = [arguments["url"]]
        if arguments["url"].endswith("blocked-resource"):
            guards.append("http://127.0.0.1/private")
        allowed = True
        for index, guarded_url in enumerate(guards):
            guard_id = f"guard-{request_id}-{index}"
            send({"type": "guard", "requestId": guard_id, "url": guarded_url})
            reply = json.loads(sys.stdin.readline())
            allowed = allowed and reply == {
                "allow": True,
                "requestId": guard_id,
                "type": "guardResult",
            }
        if allowed:
            url = arguments["url"]
        send({"type": "result", "requestId": request_id, "ok": allowed, "value": None})
    elif operation == "currentUrl":
        send({"type": "result", "requestId": request_id, "ok": True, "value": url})
    elif operation == "inspect":
        send({"type": "result", "requestId": request_id, "ok": True, "value": "Ready"})
    elif operation == "screenshot":
        send({"type": "result", "requestId": request_id, "ok": True,
              "value": base64.b64encode(%r).decode("ascii")})
    elif operation == "close":
        send({"type": "result", "requestId": request_id, "ok": True, "value": None})
        break
    else:
        send({"type": "result", "requestId": request_id, "ok": True, "value": None})
''' % (PNG,)


def _fake_driver(tmp_path: Path) -> PuppeteerBrowserDriver:
    module_root = tmp_path / "reviewed-puppeteer"
    module_root.mkdir()
    (module_root / "package.json").write_text("{}", encoding="utf-8")
    bridge = tmp_path / "fake_bridge.py"
    bridge.write_text(_FAKE_BRIDGE, encoding="utf-8")
    return PuppeteerBrowserDriver(
        module_root=module_root,
        node_executable=sys.executable,
        bridge_script=bridge,
    )


def _public_resolver(_hostname: str, _port: int) -> tuple[str]:
    return (PUBLIC_ADDRESS,)


def test_puppeteer_transport_uses_bounded_browser_session_semantics(
    tmp_path: Path,
) -> None:
    driver = _fake_driver(tmp_path)
    browser = BrowserSession(
        tmp_path,
        driver=driver,
        resolver=_public_resolver,
    )
    try:
        browser.navigate("https://example.test/start")
        assert browser.inspect("accessible").text == "Ready"
        browser.click("#go")
        browser.type("#name", "Fikeya")
        browser.scroll(50, delta_x=10)
        browser.wait(5)
        screenshot = browser.screenshot("artifacts/puppeteer.png")
        assert screenshot.screenshot_path == "artifacts/puppeteer.png"
        assert (tmp_path / "artifacts" / "puppeteer.png").read_bytes() == PNG
    finally:
        browser.close()


def test_puppeteer_subresources_must_pass_the_python_network_guard(
    tmp_path: Path,
) -> None:
    driver = _fake_driver(tmp_path)
    browser = BrowserSession(
        tmp_path,
        driver=driver,
        resolver=_public_resolver,
    )
    try:
        with pytest.raises(BrowserError, match="did not complete safely"):
            browser.navigate("https://example.test/blocked-resource")
    finally:
        browser.close()


def test_puppeteer_is_explicit_and_never_silently_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(PUPPETEER_ROOT_ENVIRONMENT, raising=False)
    browser = BrowserSession(
        tmp_path,
        engine="puppeteer",
        resolver=_public_resolver,
    )
    try:
        with pytest.raises(BrowserUnavailable, match="optional"):
            browser.navigate("https://example.test/")
    finally:
        browser.close()


def test_unknown_browser_engine_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(BrowserLimitError, match="playwright.*puppeteer"):
        BrowserSession(tmp_path, engine="unknown")


class _FixtureHandler(BaseHTTPRequestHandler):
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


def test_real_puppeteer_local_fixture_when_reviewed_install_is_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module_root_value = os.environ.get(PUPPETEER_ROOT_ENVIRONMENT)
    if shutil.which("node") is None or not module_root_value:
        pytest.skip("optional reviewed Puppeteer installation is unavailable")
    module_root = Path(module_root_value)
    if not (module_root / "package.json").is_file():
        pytest.skip("optional reviewed Puppeteer installation is unavailable")

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    driver = PuppeteerBrowserDriver(module_root=module_root)
    browser = BrowserSession(
        tmp_path,
        allow_private=True,
        driver=driver,
    )
    try:
        try:
            browser.navigate(f"http://127.0.0.1:{server.server_port}/")
        except BrowserUnavailable as error:
            pytest.skip(str(error))
        assert "Ready" in (browser.inspect("text").text or "")
        browser.type("#name", "Fikeya")
        browser.click("#go")
        assert "Done Fikeya" in (browser.inspect("text").text or "")
        result = browser.screenshot("artifacts/puppeteer-fixture.png")
        assert result.screenshot_path == "artifacts/puppeteer-fixture.png"
    finally:
        browser.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
