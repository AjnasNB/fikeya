# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import io
import json
import os
import shutil
import socket
import sys
import threading
import time
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
    CHROME_EXECUTABLE_ENVIRONMENT,
    MAX_PUPPETEER_BRIDGE_MESSAGES,
    PUPPETEER_ROOT_ENVIRONMENT,
    PuppeteerBrowserDriver,
    _minimal_bridge_environment,
)

PUBLIC_ADDRESS = "93.184.216.34"
PNG = b"\x89PNG\r\n\x1a\npuppeteer-fixture"
_ORIGINAL_SOCKET_CONNECT = socket.socket.connect

_FAKE_BRIDGE = r'''import base64
import hashlib
import json
import os
import sys
import threading
import time

url = "about:blank"

def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

send({
    "type": "ready",
    "package": "puppeteer-core",
    "version": "1.2.3",
    "lockSha256": hashlib.sha256(
        open(sys.argv[1] + "/package-lock.json", "rb").read()
    ).hexdigest(),
})
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
    elif operation == "click" and arguments.get("selector") == "#fail":
        def late_side_effect():
            time.sleep(0.4)
            with open(os.path.join(sys.argv[1], "late-side-effect"), "w") as marker:
                marker.write("unsafe")
        threading.Thread(target=late_side_effect).start()
        send({"type": "result", "requestId": request_id, "ok": False})
    elif operation == "close":
        send({"type": "result", "requestId": request_id, "ok": True, "value": None})
        break
    else:
        send({"type": "result", "requestId": request_id, "ok": True, "value": None})
''' % (PNG,)


def _fake_driver(tmp_path: Path) -> PuppeteerBrowserDriver:
    module_root = tmp_path / "reviewed-puppeteer"
    module_root.mkdir()
    package_directory = module_root / "node_modules" / "puppeteer-core"
    package_directory.mkdir(parents=True)
    (module_root / "package.json").write_text(
        json.dumps({"dependencies": {"puppeteer-core": "1.2.3"}}),
        encoding="utf-8",
    )
    (module_root / "package-lock.json").write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {"dependencies": {"puppeteer-core": "1.2.3"}},
                    "node_modules/puppeteer-core": {
                        "name": "puppeteer-core",
                        "version": "1.2.3",
                        "integrity": "sha512-QUJDRA==",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    (package_directory / "package.json").write_text(
        json.dumps({"name": "puppeteer-core", "version": "1.2.3"}),
        encoding="utf-8",
    )
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


def test_failed_puppeteer_operation_invalidates_the_old_session(
    tmp_path: Path,
) -> None:
    driver = _fake_driver(tmp_path)
    browser = BrowserSession(
        tmp_path,
        driver=driver,
        resolver=_public_resolver,
    )
    try:
        browser.navigate("https://example.test/old-session")
        old_process = driver._process
        assert old_process is not None

        with pytest.raises(BrowserError, match="did not complete safely"):
            browser.click("#fail")

        assert driver._process is None
        assert driver._process_tree is None
        assert old_process.poll() is not None
        with pytest.raises(BrowserUnavailable, match="invalidated"):
            driver.current_url()
        assert driver._process is None
        time.sleep(0.6)
        assert not (driver._module_root / "late-side-effect").exists()
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


def test_puppeteer_bridge_does_not_inherit_api_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-cross-process-boundary")
    monkeypatch.setenv("AZURE_CLIENT_SECRET", "must-not-cross-process-boundary")
    monkeypatch.setenv("TEMP", "safe-temp")

    environment = _minimal_bridge_environment()

    assert environment["TEMP"] == "safe-temp"
    assert "OPENAI_API_KEY" not in environment
    assert "AZURE_CLIENT_SECRET" not in environment
    assert "NODE_OPTIONS" not in environment


def test_puppeteer_bridge_output_queue_is_bounded(tmp_path: Path) -> None:
    driver = _fake_driver(tmp_path)

    assert driver._messages.maxsize == MAX_PUPPETEER_BRIDGE_MESSAGES


def test_puppeteer_termination_delegates_to_managed_process_tree(
    tmp_path: Path,
) -> None:
    class FakeProcess:
        def __init__(self) -> None:
            self.stdin = io.BytesIO()
            self.stdout = io.BytesIO()
            self.stderr = io.BytesIO()
            self.returncode: int | None = None
            self.killed = False

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            self.returncode = -1
            return self.returncode

        def kill(self) -> None:
            self.killed = True
            self.returncode = -1

    class FakeTree:
        def __init__(self) -> None:
            self.terminated = False
            self.closed = False

        def terminate(self) -> None:
            self.terminated = True

        def close(self) -> None:
            self.closed = True

    process = FakeProcess()
    process_tree = FakeTree()
    driver = _fake_driver(tmp_path)
    driver._process = process  # type: ignore[assignment]
    driver._process_tree = process_tree  # type: ignore[assignment]

    driver._terminate()

    assert process_tree.terminated is True
    assert process_tree.closed is True
    assert process.killed is False
    assert driver._process is None
    assert driver._process_tree is None


def test_puppeteer_requires_lockfile_provenance(tmp_path: Path) -> None:
    module_root = tmp_path / "unlocked-puppeteer"
    module_root.mkdir()
    (module_root / "package.json").write_text(
        json.dumps({"dependencies": {"puppeteer-core": "1.2.3"}}),
        encoding="utf-8",
    )
    bridge = tmp_path / "bridge.py"
    bridge.write_text("pass\n", encoding="utf-8")
    driver = PuppeteerBrowserDriver(
        module_root=module_root,
        node_executable=sys.executable,
        bridge_script=bridge,
    )

    with pytest.raises(BrowserUnavailable, match="metadata is unavailable"):
        driver._resolve_installation()


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
    chrome_executable_value = os.environ.get(CHROME_EXECUTABLE_ENVIRONMENT)
    if shutil.which("node") is None or not module_root_value:
        pytest.skip("optional reviewed Puppeteer installation is unavailable")
    module_root = Path(module_root_value)
    if not (module_root / "package.json").is_file():
        pytest.skip("optional reviewed Puppeteer installation is unavailable")

    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    driver = PuppeteerBrowserDriver(
        module_root=module_root,
        chrome_executable=chrome_executable_value,
    )
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
