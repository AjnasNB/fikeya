# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.fikeya import test_installed_browser

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
BUILD_SCRIPT = (
    REPOSITORY_ROOT
    / "extensions"
    / "fikeya-desktop"
    / "scripts"
    / "build-fikeya-runtime.py"
)
SPEC = importlib.util.spec_from_file_location("fikeya_build_runtime", BUILD_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load the Desktop runtime build script.")
build_runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_runtime)


class BrowserPackagingTests(unittest.TestCase):
    def test_frozen_entrypoint_uses_the_embedded_playwright_payload(self) -> None:
        entrypoint = (
            Path(__file__).parents[3]
            / "extensions"
            / "fikeya-desktop"
            / "scripts"
            / "fikeya-runtime-entry.py"
        ).read_text(encoding="utf-8")
        self.assertIn('os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "0"', entrypoint)
        self.assertIn('getattr(sys, "frozen", False)', entrypoint)

    def test_browser_dependencies_are_exactly_pinned(self) -> None:
        pyproject = (REPOSITORY_ROOT / "fikeya-runtime" / "pyproject.toml").read_text(
            encoding="utf-8"
        )
        requirements = (
            REPOSITORY_ROOT
            / "extensions"
            / "fikeya-desktop"
            / "runtime-build-requirements.txt"
        ).read_text(encoding="utf-8")
        constraints = (
            REPOSITORY_ROOT / "scripts" / "fikeya" / "runtime-constraints.txt"
        ).read_text(encoding="utf-8")

        self.assertEqual(
            {
                "pyproject": '"playwright==1.62.0"' in pyproject,
                "requirements": 'playwright==1.62.0; sys_platform == "win32"'
                in requirements,
                "constraints": "playwright==1.62.0" in constraints,
                "unbounded": "playwright>=" in pyproject,
            },
            {
                "pyproject": True,
                "requirements": True,
                "constraints": True,
                "unbounded": False,
            },
        )

    def test_payload_hash_is_path_and_content_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "component" / "nested").mkdir(parents=True)
            (root / "component" / "a.txt").write_bytes(b"alpha")
            (root / "component" / "nested" / "b.txt").write_bytes(b"beta")

            first = build_runtime.payload_tree_hash(root, ("component",))
            (root / "component" / "a.txt").touch()
            second = build_runtime.payload_tree_hash(root, ("component",))

            self.assertEqual(first, second)
            self.assertEqual(first[1:], (2, 9))

    def test_payload_validator_requires_every_reviewed_byte(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            component = root / "component-7"
            component.mkdir()
            executable = component / "browser.exe"
            browser_license = component / "LICENSE.browser"
            ffmpeg_license = component / "COPYING.ffmpeg"
            executable.write_bytes(b"browser")
            browser_license.write_bytes(b"browser license")
            ffmpeg_license.write_bytes(b"ffmpeg license")
            digest, files, size = build_runtime.payload_tree_hash(
                root, ("component-7",)
            )
            component_receipt = {
                "revision": "7",
                "sha256": digest,
                "bytes": size,
                "files": files,
            }

            patches = (
                mock.patch.object(
                    build_runtime,
                    "PLAYWRIGHT_PAYLOAD_COMPONENTS",
                    {"component-7": component_receipt},
                ),
                mock.patch.object(build_runtime, "PLAYWRIGHT_PAYLOAD_SHA256", digest),
                mock.patch.object(build_runtime, "PLAYWRIGHT_PAYLOAD_FILES", files),
                mock.patch.object(build_runtime, "PLAYWRIGHT_PAYLOAD_BYTES", size),
                mock.patch.object(
                    build_runtime,
                    "PLAYWRIGHT_BROWSER_EXECUTABLE",
                    "component-7/browser.exe",
                ),
                mock.patch.object(
                    build_runtime,
                    "PLAYWRIGHT_BROWSER_EXECUTABLE_SHA256",
                    build_runtime.sha256_file(executable),
                ),
                mock.patch.object(
                    build_runtime,
                    "PLAYWRIGHT_CHROMIUM_LICENSE",
                    "component-7/LICENSE.browser",
                ),
                mock.patch.object(
                    build_runtime,
                    "PLAYWRIGHT_CHROMIUM_LICENSE_SHA256",
                    build_runtime.sha256_file(browser_license),
                ),
                mock.patch.object(
                    build_runtime,
                    "PLAYWRIGHT_FFMPEG_LICENSE",
                    "component-7/COPYING.ffmpeg",
                ),
                mock.patch.object(
                    build_runtime,
                    "PLAYWRIGHT_FFMPEG_LICENSE_SHA256",
                    build_runtime.sha256_file(ffmpeg_license),
                ),
            )
            with (
                patches[0],
                patches[1],
                patches[2],
                patches[3],
                patches[4],
                patches[5],
                patches[6],
                patches[7],
                patches[8],
                patches[9],
            ):
                receipt = build_runtime.validate_browser_payload(root)
                executable.write_bytes(b"tampered")
                with self.assertRaisesRegex(RuntimeError, "reviewed payload"):
                    build_runtime.validate_browser_payload(root)

            self.assertEqual(
                {
                    "files": receipt["fileCount"],
                    "bytes": receipt["payloadBytes"],
                    "sha256": receipt["payloadSha256"],
                },
                {"files": files, "bytes": size, "sha256": digest},
            )

    def test_installed_receipt_requires_browser_licenses_inside_extension(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            extension_root = Path(temporary_directory) / "fikeya-desktop"
            receipt_path = extension_root / "runtime" / "fikeya-runtime.json"
            receipt_path.parent.mkdir(parents=True)
            packages = write_package_licenses(extension_root)
            python_license = "runtime/licenses/python/LICENSE.txt"
            (extension_root / python_license).parent.mkdir(parents=True)
            (extension_root / python_license).write_text(
                "Python license", encoding="utf-8"
            )
            receipt = {
                "browser": expected_browser_receipt(),
                "executable": "runtime/fikeya-runtime.exe",
                "packages": packages,
                "pythonLicenseFile": python_license,
                "pythonLicenseSha256": build_runtime.sha256_file(
                    extension_root / python_license
                ),
                "pythonVersion": "3.12.10",
                "schemaVersion": "fikeya.desktop-bundled-python-runtime.v1",
                "target": "win32-x64",
            }
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

            loaded, browser = test_installed_browser.load_browser_receipt(receipt_path)
            count = test_installed_browser.verify_installed_licenses(
                receipt_path, loaded
            )

            self.assertEqual(browser["revision"], "1234")
            self.assertEqual(
                count, len(test_installed_browser.EXPECTED_WINDOWS_PACKAGES) + 1
            )

    def test_installed_receipt_rejects_parent_license_segments(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            extension_root = Path(temporary_directory) / "fikeya-desktop"
            receipt_path = extension_root / "runtime" / "fikeya-runtime.json"
            license_root = extension_root / "runtime" / "licenses"
            license_root.mkdir(parents=True)
            (extension_root / "runtime" / "outside.txt").write_text(
                "not a license", encoding="utf-8"
            )
            packages = write_package_licenses(extension_root)
            receipt = {
                "browser": expected_browser_receipt(),
                "executable": "runtime/fikeya-runtime.exe",
                "packages": packages,
                "pythonLicenseFile": "runtime/licenses/../outside.txt",
                "pythonLicenseSha256": build_runtime.sha256_file(
                    extension_root / "runtime" / "outside.txt"
                ),
                "pythonVersion": "3.12.10",
                "schemaVersion": "fikeya.desktop-bundled-python-runtime.v1",
                "target": "win32-x64",
            }
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "unsafe license path"):
                test_installed_browser.verify_installed_licenses(
                    receipt_path, receipt
                )


def expected_browser_receipt() -> dict[str, object]:
    return {
        "archivePrefix": "playwright/driver/package/.local-browsers",
        "browserVersion": test_installed_browser.EXPECTED_BROWSER_VERSION,
        "executablePath": (
            "chromium_headless_shell-1234/"
            "chrome-headless-shell-win64/chrome-headless-shell.exe"
        ),
        "executableSha256": test_installed_browser.EXPECTED_EXECUTABLE_SHA256,
        "fileCount": test_installed_browser.EXPECTED_PAYLOAD_FILES,
        "name": "chromium-headless-shell",
        "payloadBytes": test_installed_browser.EXPECTED_PAYLOAD_BYTES,
        "payloadSha256": test_installed_browser.EXPECTED_PAYLOAD_SHA256,
        "playwrightVersion": test_installed_browser.EXPECTED_PLAYWRIGHT_VERSION,
        "revision": test_installed_browser.EXPECTED_BROWSER_REVISION,
        "schemaVersion": "fikeya.desktop-browser-payload.v1",
    }


def write_package_licenses(extension_root: Path) -> list[dict[str, object]]:
    packages: list[dict[str, object]] = []
    for index, (name, version) in enumerate(
        sorted(test_installed_browser.EXPECTED_WINDOWS_PACKAGES.items())
    ):
        relative = f"runtime/licenses/{name}/{index:02d}-LICENSE"
        license_path = extension_root / relative
        license_path.parent.mkdir(parents=True, exist_ok=True)
        license_path.write_text(f"license for {name}", encoding="utf-8")
        packages.append(
            {
                "name": name,
                "version": version,
                "licenseFile": relative,
                "licenseFiles": [relative],
                "licenseSha256": {
                    relative: build_runtime.sha256_file(license_path)
                },
            }
        )
    return packages


if __name__ == "__main__":
    unittest.main()
