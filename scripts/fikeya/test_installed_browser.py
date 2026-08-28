#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Smoke the browser payload embedded in an installed Desktop runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath

EXPECTED_BROWSER_VERSION = "151.0.7922.34"
EXPECTED_BROWSER_REVISION = "1234"
EXPECTED_PLAYWRIGHT_VERSION = "1.62.0"
EXPECTED_PAYLOAD_BYTES = 287_667_597
EXPECTED_PAYLOAD_FILES = 299
EXPECTED_PAYLOAD_SHA256 = (
    "sha256:a3ef07d44788de282bfddfd28350b230e9a795a441be39cce585fbca363338dc"
)
EXPECTED_EXECUTABLE_SHA256 = (
    "sha256:ce4635cd0e5dc0e21494542a701f347e91c1f1d821970578d97ed8df4ced50ef"
)
MAX_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024
MAX_PAYLOAD_BYTES = 384 * 1024 * 1024
MAX_PAYLOAD_FILES = 512
SMOKE_TIMEOUT_SECONDS = 30


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-executable", type=Path, required=True)
    parser.add_argument("--runtime-receipt", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--allow-private-fixture", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def payload_tree_hash(payload_root: Path) -> tuple[str, int, int]:
    digest = hashlib.sha256()
    files = sorted(path for path in payload_root.rglob("*") if path.is_file())
    total_bytes = 0
    for source in files:
        relative = source.relative_to(payload_root).as_posix().encode("utf-8")
        contents = source.read_bytes()
        total_bytes += len(contents)
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return f"sha256:{digest.hexdigest()}", len(files), total_bytes


def load_browser_receipt(
    receipt_path: Path,
) -> tuple[dict[str, object], dict[str, object]]:
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "Installed runtime browser receipt is unreadable."
        ) from error
    if (
        not isinstance(receipt, dict)
        or receipt.get("schemaVersion")
        != "fikeya.desktop-bundled-python-runtime.v1"
        or receipt.get("target") != "win32-x64"
        or receipt.get("executable") != "runtime/fikeya-runtime.exe"
        or receipt.get("pythonLicenseFile")
        != "runtime/licenses/python/LICENSE.txt"
    ):
        raise RuntimeError("Installed runtime receipt is not for Windows x64.")
    browser = receipt.get("browser")
    if not isinstance(browser, dict):
        raise TypeError("Installed runtime receipt is missing its browser payload.")
    expected = {
        "archivePrefix": "playwright/driver/package/.local-browsers",
        "browserVersion": EXPECTED_BROWSER_VERSION,
        "executablePath": (
            "chromium_headless_shell-1234/"
            "chrome-headless-shell-win64/chrome-headless-shell.exe"
        ),
        "executableSha256": EXPECTED_EXECUTABLE_SHA256,
        "fileCount": EXPECTED_PAYLOAD_FILES,
        "name": "chromium-headless-shell",
        "payloadBytes": EXPECTED_PAYLOAD_BYTES,
        "payloadSha256": EXPECTED_PAYLOAD_SHA256,
        "playwrightVersion": EXPECTED_PLAYWRIGHT_VERSION,
        "revision": EXPECTED_BROWSER_REVISION,
        "schemaVersion": "fikeya.desktop-browser-payload.v1",
    }
    if any(browser.get(key) != value for key, value in expected.items()):
        raise RuntimeError(
            "Installed browser payload does not match the reviewed release."
        )
    return receipt, browser


def verify_installed_licenses(receipt_path: Path, receipt: dict[str, object]) -> int:
    extension_root = receipt_path.parent.parent.resolve(strict=True)
    license_root = (extension_root / "runtime" / "licenses").resolve(strict=True)
    declared = [receipt.get("pythonLicenseFile")]
    packages = receipt.get("packages")
    if not isinstance(packages, list):
        raise TypeError("Installed runtime receipt has no package license manifest.")
    package_names = set()
    for item in packages:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise TypeError("Installed runtime package license manifest is malformed.")
        package_names.add(item["name"])
        license_files = item.get("licenseFiles")
        declared.extend(
            license_files
            if isinstance(license_files, list)
            else [item.get("licenseFile")]
        )
    required_packages = {
        "chromium-headless-shell",
        "greenlet",
        "playwright",
        "playwright-ffmpeg",
        "playwright-winldd",
        "pyee",
        "typing-extensions",
    }
    if not required_packages.issubset(package_names):
        raise RuntimeError(
            "Installed runtime is missing browser package license records."
        )
    checked = 0
    for value in declared:
        if not isinstance(value, str):
            raise RuntimeError("Installed runtime contains an unsafe license path.")
        relative = PurePosixPath(value)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or len(relative.parts) < 4
            or relative.parts[:2] != ("runtime", "licenses")
        ):
            raise RuntimeError("Installed runtime contains an unsafe license path.")
        candidate = (extension_root / Path(*relative.parts)).resolve(strict=True)
        try:
            candidate.relative_to(license_root)
        except ValueError as error:
            raise RuntimeError(
                "Installed runtime license escapes the license directory."
            ) from error
        if not candidate.is_file() or candidate.stat().st_size == 0:
            raise RuntimeError("Installed runtime license is missing or empty.")
        checked += 1
    return checked


def extract_browser_payload(
    runtime_executable: Path,
    browser: dict[str, object],
    payload_root: Path,
) -> Path:
    try:
        from PyInstaller.archive.readers import CArchiveReader
    except ImportError as error:
        raise RuntimeError(
            "Pinned PyInstaller is required for installed browser verification."
        ) from error

    archive = CArchiveReader(str(runtime_executable))
    archive_prefix = str(browser["archivePrefix"]).rstrip("/") + "/"
    selected: list[tuple[str, str]] = []
    has_playwright_driver = False
    for original_name in archive.toc:
        normalized = original_name.replace("\\", "/")
        if normalized.endswith("playwright/driver/node.exe"):
            has_playwright_driver = True
        if normalized.startswith(archive_prefix):
            selected.append((original_name, normalized[len(archive_prefix) :]))
    if not has_playwright_driver:
        raise RuntimeError(
            "Installed runtime does not contain the Playwright driver executable."
        )
    if len(selected) != EXPECTED_PAYLOAD_FILES or len(selected) > MAX_PAYLOAD_FILES:
        raise RuntimeError(
            "Installed runtime browser archive has an unexpected file count."
        )

    total_bytes = 0
    for original_name, relative_name in selected:
        relative = PurePosixPath(relative_name)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise RuntimeError(
                "Installed runtime browser archive contains an unsafe path."
            )
        contents = archive.extract(original_name)
        if not isinstance(contents, bytes) or len(contents) > MAX_ARCHIVE_ENTRY_BYTES:
            raise RuntimeError(
                "Installed runtime browser archive entry exceeds its bound."
            )
        total_bytes += len(contents)
        if total_bytes > MAX_PAYLOAD_BYTES:
            raise RuntimeError(
                "Installed runtime browser payload exceeds its extraction bound."
            )
        destination = (payload_root / Path(*relative.parts)).resolve(strict=False)
        try:
            destination.relative_to(payload_root)
        except ValueError as error:
            raise RuntimeError(
                "Installed runtime browser payload escapes its workspace."
            ) from error
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(contents)

    digest, file_count, payload_bytes = payload_tree_hash(payload_root)
    if (
        digest != EXPECTED_PAYLOAD_SHA256
        or file_count != EXPECTED_PAYLOAD_FILES
        or payload_bytes != EXPECTED_PAYLOAD_BYTES
    ):
        raise RuntimeError(
            "Installed runtime browser payload failed its content verification."
        )
    executable = payload_root / PurePosixPath(str(browser["executablePath"]))
    if (
        not executable.is_file()
        or sha256_file(executable) != EXPECTED_EXECUTABLE_SHA256
    ):
        raise RuntimeError(
            "Installed Chromium executable failed its content verification."
        )
    return executable


class FixtureHandler(BaseHTTPRequestHandler):
    body = b"<!doctype html><title>Fikeya installed browser</title><p>installed-browser-ready</p>"

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def _run_runtime_json(
    runtime_executable: Path,
    arguments: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    stdin: dict[str, object] | None = None,
) -> dict[str, object]:
    completed = subprocess.run(
        [str(runtime_executable), *arguments],
        cwd=cwd,
        env=environment,
        input=json.dumps(stdin, separators=(",", ":")) if stdin is not None else None,
        check=False,
        capture_output=True,
        text=True,
        timeout=SMOKE_TIMEOUT_SECONDS,
        shell=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "Installed Fikeya Runtime browser command failed: "
            + (completed.stderr or completed.stdout)[-2_048:]
        )
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "Installed Fikeya Runtime returned an invalid browser receipt."
        ) from error
    if not isinstance(value, dict) or value.get("ok") is not True:
        raise RuntimeError(
            "Installed Fikeya Runtime browser receipt was unsuccessful."
        )
    return value


def smoke_local_fixture(
    runtime_executable: Path,
    workspace: Path,
    *,
    browser_cache: Path | None = None,
) -> dict[str, object]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    url = f"http://127.0.0.1:{server.server_port}/"
    project = workspace / "project"
    project.mkdir()
    local_app_data = workspace / "local-app-data"
    roaming_app_data = workspace / "roaming-app-data"
    local_app_data.mkdir()
    roaming_app_data.mkdir()
    environment = {
        **os.environ,
        "CHROME_LOG_FILE": str(workspace / "chromium.log"),
        "LOCALAPPDATA": str(local_app_data),
        "APPDATA": str(roaming_app_data),
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    }
    if browser_cache is None:
        environment.pop("PLAYWRIGHT_BROWSERS_PATH", None)
    else:
        environment["PLAYWRIGHT_BROWSERS_PATH"] = str(
            browser_cache.resolve(strict=True)
        )
    specification = {
        "schemaVersion": 1,
        "title": "Verify the installed Fikeya browser",
        "steps": [
            {
                "stepId": "navigate",
                "title": "Open the local fixture",
                "dependsOn": [],
                "toolCall": {
                    "arguments": {"url": url},
                    "callId": "browser:navigate",
                    "name": "browser.navigate",
                },
                "verify": {"expectedStatus": "ok"},
            },
            {
                "stepId": "assert",
                "title": "Read the fixture through Playwright",
                "dependsOn": ["navigate"],
                "toolCall": {
                    "arguments": {"text": "installed-browser-ready"},
                    "callId": "browser:assert",
                    "name": "browser.assert_text",
                },
                "verify": {"expectedStatus": "ok"},
            },
            {
                "stepId": "close",
                "title": "Close the installed browser",
                "dependsOn": ["assert"],
                "toolCall": {
                    "arguments": {},
                    "callId": "browser:close",
                    "name": "browser.close",
                },
                "verify": {"expectedStatus": "ok"},
            },
        ],
    }
    try:
        _run_runtime_json(
            runtime_executable,
            ["init", str(project), "--json"],
            cwd=workspace,
            environment=environment,
        )
        created = _run_runtime_json(
            runtime_executable,
            ["plan", "create", str(project), "--spec-stdin", "--json"],
            cwd=workspace,
            environment=environment,
            stdin=specification,
        )
        plan_id = created.get("plan", {}).get("planId")
        if not isinstance(plan_id, str):
            raise RuntimeError("Installed Fikeya Runtime did not create the browser plan.")
        _run_runtime_json(
            runtime_executable,
            ["plan", "review", plan_id, "--workspace", str(project), "--json"],
            cwd=workspace,
            environment=environment,
        )
        _run_runtime_json(
            runtime_executable,
            [
                "plan",
                "approve",
                plan_id,
                "--workspace",
                str(project),
                "--all",
                "--json",
            ],
            cwd=workspace,
            environment=environment,
        )
        completed = _run_runtime_json(
            runtime_executable,
            [
                "plan",
                "run",
                plan_id,
                "--workspace",
                str(project),
                "--allow-private-browser",
                "--json",
            ],
            cwd=workspace,
            environment=environment,
        )
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
    if completed.get("plan", {}).get("status") != "succeeded":
        raise RuntimeError(
            "Installed Fikeya Runtime did not verify the bounded local fixture."
        )
    return {
        "fixtureHost": "127.0.0.1",
        "planId": plan_id,
        "planStatus": "succeeded",
        "privateHostConsent": "explicit",
        "remoteNetworkAllowed": False,
    }


def main() -> int:
    args = parse_arguments()
    if not args.allow_private_fixture:
        raise RuntimeError("Installed browser smoke requires --allow-private-fixture.")
    runtime_executable = args.runtime_executable.resolve(strict=True)
    receipt_path = args.runtime_receipt.resolve(strict=True)
    workspace = args.workspace.resolve(strict=True)
    if not workspace.is_dir() or any(workspace.iterdir()):
        raise RuntimeError(
            "Installed browser smoke workspace must be an empty directory."
        )
    receipt, browser = load_browser_receipt(receipt_path)
    if receipt.get("executableSha256") != sha256_file(runtime_executable):
        raise RuntimeError("Installed Fikeya Runtime executable hash does not match its receipt.")
    license_count = verify_installed_licenses(receipt_path, receipt)
    extract_browser_payload(
        runtime_executable,
        browser,
        workspace / "payload",
    )
    fixture = smoke_local_fixture(runtime_executable, workspace)
    report = {
        "browserVersion": EXPECTED_BROWSER_VERSION,
        "executableSha256": EXPECTED_EXECUTABLE_SHA256,
        "licenseFiles": license_count,
        "payloadBytes": EXPECTED_PAYLOAD_BYTES,
        "payloadSha256": EXPECTED_PAYLOAD_SHA256,
        "playwrightVersion": EXPECTED_PLAYWRIGHT_VERSION,
        "schemaVersion": "fikeya.installed-browser-smoke.v1",
        **fixture,
    }
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, TypeError) as error:
        print(f"browser smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
