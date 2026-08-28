# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build the extension-owned, platform-specific Fikeya Runtime executable."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PINNED_DISTRIBUTIONS = {
    "azure-core": "1.41.0",
    "azure-identity": "1.25.3",
    "certifi": "2026.7.22",
    "cffi": "2.1.1",
    "charset-normalizer": "3.5.1",
    "cryptography": "50.0.0",
    "idna": "3.19",
    "jaraco.classes": "3.4.0",
    "jaraco.context": "6.1.2",
    "jaraco.functools": "4.6.0",
    "keyring": "25.7.0",
    "more-itertools": "11.1.0",
    "msal": "1.38.0",
    "msal-extensions": "1.3.1",
    "pycparser": "3.0",
    "pyjwt": "2.13.0",
    "pyinstaller": "6.22.2",
    "requests": "2.34.2",
    "typing-extensions": "4.16.0",
    "urllib3": "2.7.0",
}
LEGACY_PYTHON_DISTRIBUTIONS = {"backports.tarfile": "1.2.0"}
WINDOWS_DISTRIBUTIONS = {"pywin32-ctypes": "0.2.3"}
WINDOWS_BROWSER_DISTRIBUTIONS = {
    "greenlet": "3.5.5",
    "playwright": "1.62.0",
    "pyee": "13.0.1",
}
PLAYWRIGHT_BROWSER_VERSION = "151.0.7922.34"
PLAYWRIGHT_BROWSER_REVISION = "1234"
PLAYWRIGHT_BROWSER_EXECUTABLE = (
    "chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe"
)
PLAYWRIGHT_BROWSER_EXECUTABLE_SHA256 = (
    "sha256:ce4635cd0e5dc0e21494542a701f347e91c1f1d821970578d97ed8df4ced50ef"
)
PLAYWRIGHT_PAYLOAD_ARCHIVE_PREFIX = "playwright/driver/package/.local-browsers"
PLAYWRIGHT_PAYLOAD_BYTES = 287_667_597
PLAYWRIGHT_PAYLOAD_FILES = 299
PLAYWRIGHT_PAYLOAD_SHA256 = (
    "sha256:a3ef07d44788de282bfddfd28350b230e9a795a441be39cce585fbca363338dc"
)
PLAYWRIGHT_PAYLOAD_COMPONENTS = {
    "chromium_headless_shell-1234": {
        "revision": "1234",
        "sha256": "sha256:c72eaa0acafe4d5c3dbc49d6693f274d45f8f6314df368cc04ec496b73274880",
        "bytes": 283_891_695,
        "files": 292,
    },
    "ffmpeg-1011": {
        "revision": "1011",
        "sha256": "sha256:6541cd6b2f891c32164619950ebaef1cc54d8ca80ade352675828e2f0c402b15",
        "bytes": 3_517_342,
        "files": 4,
    },
    "winldd-1007": {
        "revision": "1007",
        "sha256": "sha256:ddd1d55399a812135a012a2b4f2bd4c5066cba2e7287500ac1a5dcd0e7d99dca",
        "bytes": 258_560,
        "files": 3,
    },
}
PLAYWRIGHT_CHROMIUM_LICENSE = (
    "chromium_headless_shell-1234/chrome-headless-shell-win64/LICENSE.headless_shell"
)
PLAYWRIGHT_FFMPEG_LICENSE = "ffmpeg-1011/COPYING.LGPLv2.1"
PLAYWRIGHT_CHROMIUM_LICENSE_SHA256 = (
    "sha256:c15f28d6f2902b7f3347668609bc35e6b81158b71463c24fdd47d83918ca9242"
)
PLAYWRIGHT_FFMPEG_LICENSE_SHA256 = (
    "sha256:b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe"
)
VENDORED_PYTHON_LICENSE_VERSION = (3, 12)
VENDORED_PYTHON_LICENSE_SHA256 = (
    "6c4cb3ac7183d140222e754bbb81ae02c67a1cbe30352077358bca4b6c0f732a"
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--extension-root", type=Path, required=True)
    parser.add_argument("--repository-root", type=Path, required=True)
    parser.add_argument("--target", required=True)
    return parser.parse_args()


def expected_target() -> str:
    machine = platform.machine().lower()
    architecture = "arm64" if machine in {"aarch64", "arm64"} else "x64"
    if sys.platform == "win32":
        return f"win32-{architecture}"
    if sys.platform == "darwin":
        return f"darwin-{architecture}"
    if sys.platform.startswith("linux"):
        return f"linux-{architecture}"
    raise RuntimeError(f"Unsupported runtime platform: {sys.platform}/{machine}")


def distribution_licenses(
    distribution_name: str,
) -> tuple[importlib.metadata.Distribution, tuple[Path, ...]]:
    """Return every declared license/notice file for a pinned distribution."""

    distribution = importlib.metadata.distribution(distribution_name)
    candidates = [
        item
        for item in distribution.files or []
        if any(token in str(item).lower() for token in ("license", "copying", "notice"))
    ]
    resolved = tuple(
        dict.fromkeys(
            Path(distribution.locate_file(item)).resolve() for item in candidates
        )
    )
    if not resolved or any(not candidate.is_file() for candidate in resolved):
        raise RuntimeError(
            f"No complete license files were found for {distribution_name}."
        )
    return distribution, resolved


def resolve_python_license(
    extension_root: Path,
    prefix: Path,
    base_prefix: Path,
    version: tuple[int, int],
) -> Path:
    candidates = [prefix / "LICENSE.txt", base_prefix / "LICENSE.txt"]
    vendored_license = extension_root / "third-party" / "python" / "LICENSE.txt"
    if version == VENDORED_PYTHON_LICENSE_VERSION:
        candidates.append(vendored_license)
    license_path = next(
        (candidate for candidate in candidates if candidate.is_file()), None
    )
    if license_path is None:
        raise RuntimeError("The embedded Python distribution license was not found.")
    if license_path == vendored_license:
        license_sha256 = hashlib.sha256(license_path.read_bytes()).hexdigest()
        if license_sha256 != VENDORED_PYTHON_LICENSE_SHA256:
            raise RuntimeError(
                "The vendored Python license does not match its reviewed digest."
            )
    return license_path


def tree_hash(source_root: Path) -> str:
    digest = hashlib.sha256()
    package_root = source_root.parent
    files = [package_root / "pyproject.toml", *sorted(source_root.rglob("*.py"))]
    for source in files:
        relative = source.relative_to(package_root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        contents = source.read_bytes()
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return f"sha256:{digest.hexdigest()}"


def payload_tree_hash(
    source_root: Path, component_names: tuple[str, ...]
) -> tuple[str, int, int]:
    """Hash payload paths and bytes without timestamps or filesystem metadata."""

    digest = hashlib.sha256()
    files = sorted(
        path
        for component_name in component_names
        for path in (source_root / component_name).rglob("*")
        if path.is_file()
    )
    total_bytes = 0
    for source in files:
        relative = source.relative_to(source_root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        contents = source.read_bytes()
        total_bytes += len(contents)
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return f"sha256:{digest.hexdigest()}", len(files), total_bytes


def sha256_file(path: Path) -> str:
    """Return a prefixed SHA-256 digest without retaining file content."""

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def playwright_browser_manifest() -> dict[str, dict[str, object]]:
    """Load the browser revisions owned by the installed pinned Playwright."""

    distribution = importlib.metadata.distribution("playwright")
    manifest_path = Path(
        distribution.locate_file("playwright/driver/package/browsers.json")
    ).resolve()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "The pinned Playwright browser manifest is unreadable."
        ) from error
    browsers = manifest.get("browsers")
    if not isinstance(browsers, list):
        raise TypeError("The pinned Playwright browser manifest is malformed.")
    result: dict[str, dict[str, object]] = {}
    for item in browsers:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise TypeError("The pinned Playwright browser manifest is malformed.")
        result[item["name"]] = item
    return result


def validate_playwright_manifest() -> None:
    """Fail if the Python package no longer owns the reviewed browser revisions."""

    manifest = playwright_browser_manifest()
    expected = {
        "chromium-headless-shell": (
            PLAYWRIGHT_BROWSER_REVISION,
            PLAYWRIGHT_BROWSER_VERSION,
        ),
        "ffmpeg": ("1011", None),
        "winldd": ("1007", None),
    }
    for name, (revision, browser_version) in expected.items():
        item = manifest.get(name)
        if item is None or str(item.get("revision")) != revision:
            raise RuntimeError(
                f"Playwright browser descriptor {name} is not pinned to revision {revision}."
            )
        if (
            browser_version is not None
            and item.get("browserVersion") != browser_version
        ):
            raise RuntimeError(
                f"Playwright browser descriptor {name} is not version {browser_version}."
            )


def validate_browser_payload(browser_root: Path) -> dict[str, object]:
    """Verify the exact reviewed Windows x64 payload and return its SBOM receipt."""

    expected_names = tuple(PLAYWRIGHT_PAYLOAD_COMPONENTS)
    actual_names = tuple(
        sorted(
            path.name
            for path in browser_root.iterdir()
            if path.is_dir() and not path.name.startswith(".")
        )
    )
    if actual_names != tuple(sorted(expected_names)):
        raise RuntimeError(
            "Playwright provisioning did not produce exactly the reviewed browser components."
        )

    components: list[dict[str, object]] = []
    for component_name in expected_names:
        expected = PLAYWRIGHT_PAYLOAD_COMPONENTS[component_name]
        digest, file_count, total_bytes = payload_tree_hash(
            browser_root, (component_name,)
        )
        if (
            digest != expected["sha256"]
            or file_count != expected["files"]
            or total_bytes != expected["bytes"]
        ):
            raise RuntimeError(
                f"Playwright component {component_name} does not match its reviewed payload."
            )
        components.append(
            {
                "bytes": total_bytes,
                "files": file_count,
                "name": component_name,
                "revision": expected["revision"],
                "sha256": digest,
            }
        )

    payload_digest, payload_files, payload_bytes = payload_tree_hash(
        browser_root, expected_names
    )
    if (
        payload_digest != PLAYWRIGHT_PAYLOAD_SHA256
        or payload_files != PLAYWRIGHT_PAYLOAD_FILES
        or payload_bytes != PLAYWRIGHT_PAYLOAD_BYTES
    ):
        raise RuntimeError(
            "Playwright browser payload does not match its reviewed digest."
        )

    executable = browser_root / PLAYWRIGHT_BROWSER_EXECUTABLE
    chromium_license = browser_root / PLAYWRIGHT_CHROMIUM_LICENSE
    ffmpeg_license = browser_root / PLAYWRIGHT_FFMPEG_LICENSE
    required_hashes = {
        executable: PLAYWRIGHT_BROWSER_EXECUTABLE_SHA256,
        chromium_license: PLAYWRIGHT_CHROMIUM_LICENSE_SHA256,
        ffmpeg_license: PLAYWRIGHT_FFMPEG_LICENSE_SHA256,
    }
    for required_path, expected_hash in required_hashes.items():
        if not required_path.is_file() or sha256_file(required_path) != expected_hash:
            raise RuntimeError(
                f"Playwright browser payload is missing reviewed file {required_path.name}."
            )

    return {
        "archivePrefix": PLAYWRIGHT_PAYLOAD_ARCHIVE_PREFIX,
        "browserVersion": PLAYWRIGHT_BROWSER_VERSION,
        "components": components,
        "executablePath": PLAYWRIGHT_BROWSER_EXECUTABLE,
        "executableSha256": PLAYWRIGHT_BROWSER_EXECUTABLE_SHA256,
        "fileCount": payload_files,
        "name": "chromium-headless-shell",
        "payloadBytes": payload_bytes,
        "payloadSha256": payload_digest,
        "playwrightVersion": WINDOWS_BROWSER_DISTRIBUTIONS["playwright"],
        "revision": PLAYWRIGHT_BROWSER_REVISION,
        "schemaVersion": "fikeya.desktop-browser-payload.v1",
    }


class _BrowserFixtureHandler(BaseHTTPRequestHandler):
    body = b"<!doctype html><title>Fikeya browser smoke</title><p>packaged-browser-ready</p>"

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def smoke_staged_browser(
    browser_root: Path,
    smoke_workspace: Path,
    runtime_source: Path,
    agent_core_source: Path,
) -> None:
    """Launch the staged payload through BrowserSession against localhost only."""

    smoke_workspace.mkdir(parents=True, exist_ok=True)
    original_path = list(sys.path)
    original_browser_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    original_chrome_log = os.environ.get("CHROME_LOG_FILE")
    sys.path[:0] = [str(runtime_source), str(agent_core_source)]
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(browser_root)
    os.environ["CHROME_LOG_FILE"] = str(smoke_workspace / "chromium.log")
    server = ThreadingHTTPServer(("127.0.0.1", 0), _BrowserFixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    browser = None
    try:
        from fikeya_runtime.browser import BrowserSession

        browser = BrowserSession(smoke_workspace, allow_private=True)
        browser.navigate(f"http://127.0.0.1:{server.server_port}/")
        snapshot = browser.inspect("text")
        if snapshot.text is None or "packaged-browser-ready" not in snapshot.text:
            raise RuntimeError("The staged browser did not return the local fixture.")
        screenshot = browser.screenshot("browser-smoke.png")
        if screenshot.screenshot_path != "browser-smoke.png":
            raise RuntimeError("The staged browser screenshot receipt is incomplete.")
    finally:
        if browser is not None:
            browser.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
        sys.path[:] = original_path
        if original_browser_path is None:
            os.environ.pop("PLAYWRIGHT_BROWSERS_PATH", None)
        else:
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = original_browser_path
        if original_chrome_log is None:
            os.environ.pop("CHROME_LOG_FILE", None)
        else:
            os.environ["CHROME_LOG_FILE"] = original_chrome_log


def provision_windows_browser(
    build_root: Path,
    runtime_source: Path,
    agent_core_source: Path,
) -> tuple[Path, dict[str, object]]:
    """Provision and validate the exact Windows x64 browser during the build."""

    if (
        importlib.metadata.version("playwright")
        != WINDOWS_BROWSER_DISTRIBUTIONS["playwright"]
    ):
        raise RuntimeError(
            f"playwright must be exactly {WINDOWS_BROWSER_DISTRIBUTIONS['playwright']}."
        )
    validate_playwright_manifest()
    browser_root = build_root / "playwright-browsers"
    if browser_root.exists():
        shutil.rmtree(browser_root)
    browser_root.mkdir(parents=True)
    environment = {
        **os.environ,
        "CI": "1",
        "PLAYWRIGHT_BROWSERS_PATH": str(browser_root),
        "PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT": "120000",
        "PLAYWRIGHT_SKIP_BROWSER_GC": "1",
    }
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "playwright",
            "install",
            "chromium-headless-shell",
        ],
        cwd=build_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        shell=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "Pinned Playwright browser provisioning failed: "
            + (completed.stderr or completed.stdout)[-4_096:]
        )
    validate_browser_payload(browser_root)
    smoke_staged_browser(
        browser_root,
        build_root / "browser-smoke-workspace",
        runtime_source,
        agent_core_source,
    )
    receipt = validate_browser_payload(browser_root)
    return browser_root, receipt


def copy_license_files(
    license_root: Path,
    package_name: str,
    version: str,
    metadata_name: str,
    sources: tuple[Path, ...],
) -> dict[str, object]:
    """Copy exact upstream license bytes using collision-free safe filenames."""

    if not sources:
        raise RuntimeError(f"No license sources were supplied for {package_name}.")
    destinations: list[str] = []
    for index, source in enumerate(sources):
        if not source.is_file():
            raise RuntimeError(
                f"License source is missing for {package_name}: {source.name}"
            )
        safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", source.name)
        destination = license_root / package_name / f"{index:02d}-{safe_name}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destinations.append(destination.relative_to(license_root.parent).as_posix())
    return {
        "licenseFile": destinations[0],
        "licenseFiles": destinations,
        "metadataName": metadata_name,
        "name": package_name,
        "version": version,
    }


def main() -> int:
    args = parse_arguments()
    extension_root = args.extension_root.resolve()
    repository_root = args.repository_root.resolve()
    target = expected_target()
    if args.target != target:
        raise RuntimeError(
            f"Requested VSIX target {args.target} does not match this builder ({target})."
        )

    runtime_source = repository_root / "fikeya-runtime" / "src"
    agent_core_source = repository_root / "fikeya-agent-core" / "src"
    preset_source = runtime_source / "fikeya_runtime" / "presets"
    entrypoint = extension_root / "scripts" / "fikeya-runtime-entry.py"
    build_root = extension_root / ".runtime-build"
    dist_root = build_root / "dist"
    work_root = build_root / "work"
    spec_root = build_root / "spec"
    license_root = build_root / "licenses"
    if build_root.parent != extension_root:
        raise RuntimeError("Runtime build root escaped the extension directory.")

    for directory in (dist_root, work_root, spec_root, license_root):
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True, exist_ok=True)

    distributions = dict(PINNED_DISTRIBUTIONS)
    if sys.version_info < (3, 12):
        distributions.update(LEGACY_PYTHON_DISTRIBUTIONS)
    if sys.platform == "win32":
        distributions.update(WINDOWS_DISTRIBUTIONS)
    if target == "win32-x64":
        distributions.update(WINDOWS_BROWSER_DISTRIBUTIONS)
    distribution_records: dict[
        str, tuple[str, importlib.metadata.Distribution, tuple[Path, ...]]
    ] = {}
    for name, version in sorted(distributions.items()):
        installed = importlib.metadata.version(name)
        if installed != version:
            raise RuntimeError(f"{name} must be exactly {version}; found {installed}.")
        distribution, license_sources = distribution_licenses(name)
        distribution_records[name] = (version, distribution, license_sources)

    browser_root: Path | None = None
    browser_receipt: dict[str, object] | None = None
    if target == "win32-x64":
        browser_root, browser_receipt = provision_windows_browser(
            build_root, runtime_source, agent_core_source
        )

    separator = ";" if sys.platform == "win32" else ":"
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "fikeya-runtime",
        "--distpath",
        str(dist_root),
        "--workpath",
        str(work_root),
        "--specpath",
        str(spec_root),
        "--paths",
        str(runtime_source),
        "--paths",
        str(agent_core_source),
        "--collect-all",
        "azure.identity",
        "--collect-all",
        "keyring",
        "--add-data",
        f"{preset_source}{separator}fikeya_runtime/presets",
    ]
    if browser_root is not None:
        command.extend(["--collect-all", "playwright"])
        for component_name in PLAYWRIGHT_PAYLOAD_COMPONENTS:
            destination = f"{PLAYWRIGHT_PAYLOAD_ARCHIVE_PREFIX}/{component_name}"
            command.extend(
                [
                    "--add-data",
                    f"{browser_root / component_name}{separator}{destination}",
                ]
            )
    command.append(str(entrypoint))
    completed = subprocess.run(
        command,
        cwd=extension_root,
        env={**os.environ, "PYTHONHASHSEED": "0"},
        check=False,
        capture_output=True,
        text=True,
        shell=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout)[-8_192:])

    executable_name = (
        "fikeya-runtime.exe" if sys.platform == "win32" else "fikeya-runtime"
    )
    executable = dist_root / executable_name
    if not executable.is_file() or executable.stat().st_size < 1_000_000:
        raise RuntimeError(
            "PyInstaller did not produce the expected standalone runtime executable."
        )

    package_receipts: list[dict[str, object]] = []
    for name, (version, distribution, license_sources) in sorted(
        distribution_records.items()
    ):
        package_receipts.append(
            copy_license_files(
                license_root,
                name,
                version,
                distribution.metadata.get("Name", name),
                license_sources,
            )
        )
    if browser_root is not None:
        package_receipts.extend(
            [
                copy_license_files(
                    license_root,
                    "chromium-headless-shell",
                    PLAYWRIGHT_BROWSER_VERSION,
                    "Chromium Headless Shell",
                    (browser_root / PLAYWRIGHT_CHROMIUM_LICENSE,),
                ),
                copy_license_files(
                    license_root,
                    "playwright-ffmpeg",
                    "1011",
                    "Playwright FFmpeg helper",
                    (browser_root / PLAYWRIGHT_FFMPEG_LICENSE,),
                ),
                copy_license_files(
                    license_root,
                    "playwright-winldd",
                    "1007",
                    "Playwright Windows dependency-inspection helper",
                    distribution_records["playwright"][2],
                ),
            ]
        )

    python_license = resolve_python_license(
        extension_root,
        Path(sys.prefix),
        Path(sys.base_prefix),
        sys.version_info[:2],
    )
    python_license_destination = license_root / "python" / "LICENSE.txt"
    python_license_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(python_license, python_license_destination)

    receipt = {
        "schemaVersion": "fikeya.desktop-python-runtime-build.v1",
        "target": target,
        "executable": executable_name,
        "pythonVersion": platform.python_version(),
        "fikeyaRuntimeSourceSha256": tree_hash(runtime_source),
        "fikeyaAgentCoreSourceSha256": tree_hash(agent_core_source),
        "browser": browser_receipt,
        "packages": package_receipts,
        "pythonLicenseFile": python_license_destination.relative_to(
            build_root
        ).as_posix(),
    }
    receipt_path = build_root / "build-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**receipt, "executablePath": str(executable)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
