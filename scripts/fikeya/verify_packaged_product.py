# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Mapping


def verify_built_in_ai_extensions(product: Any, source: str) -> None:
    """Fail closed unless a packaged Fikeya product explicitly disables built-in AI extensions."""
    if not isinstance(product, dict):
        raise ValueError(f"{source} must contain a JSON object.")
    value = product.get("builtInAiExtensions")
    if value != []:
        raise ValueError(
            f"{source} builtInAiExtensions must be exactly []; received {value!r}. "
            "Fikeya release packages must not bundle Microsoft Copilot or another built-in AI extension."
        )


def verify_packaged_product(path: Path) -> None:
    try:
        product = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"Packaged product.json was not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Packaged product.json is invalid JSON: {path}: {error}") from error
    verify_built_in_ai_extensions(product, str(path))


def read_windows_executable_metadata(executable_path: Path) -> Mapping[str, Any]:
    if os.name != "nt":
        raise ValueError("A Windows host is required to inspect the packaged executable.")
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if powershell is None:
        raise ValueError("PowerShell is required to inspect the packaged executable.")
    environment = os.environ.copy()
    environment["FIKEYA_PACKAGED_EXECUTABLE_PATH"] = str(executable_path)
    script = r"""
$path = $env:FIKEYA_PACKAGED_EXECUTABLE_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Packaged executable path was not provided.' }
$version = (Get-Item -LiteralPath $path).VersionInfo
$signature = Get-AuthenticodeSignature -LiteralPath $path
[ordered]@{
  productName = $version.ProductName
  companyName = $version.CompanyName
  fileDescription = $version.FileDescription
  originalFilename = $version.OriginalFilename
  fileVersion = $version.FileVersion.Trim()
  productVersion = $version.ProductVersion.Trim()
  fileVersionRaw = $version.FileVersionRaw.ToString()
  productVersionRaw = $version.ProductVersionRaw.ToString()
  authenticodeStatus = [string]$signature.Status
} | ConvertTo-Json -Compress
"""
    try:
        completed = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=environment,
            timeout=120,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError("Timed out while inspecting the packaged executable.") from error
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[:1000]
        raise ValueError(f"Could not inspect the packaged executable: {detail}")
    try:
        metadata = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ValueError(f"PowerShell returned invalid executable metadata: {error}") from error
    if not isinstance(metadata, dict):
        raise ValueError("PowerShell returned an invalid executable metadata object.")
    return metadata


def verify_windows_executable_metadata(
    metadata: Mapping[str, Any],
    *,
    public_version: str,
    numeric_version: str,
) -> None:
    expected = {
        "productName": "Fikeya",
        "companyName": "Ajnas N B",
        "fileDescription": "Fikeya",
        "originalFilename": "Fikeya.exe",
        "fileVersion": numeric_version,
        "productVersion": public_version,
        "fileVersionRaw": numeric_version,
        "productVersionRaw": numeric_version,
    }
    for field, expected_value in expected.items():
        if metadata.get(field) != expected_value:
            raise ValueError(
                f"Packaged executable {field} is {metadata.get(field)!r}; "
                f"expected {expected_value!r}."
            )
    if metadata.get("authenticodeStatus") not in {"NotSigned", "Valid"}:
        raise ValueError(
            "Packaged executable Authenticode status must be NotSigned or Valid; "
            f"received {metadata.get('authenticodeStatus')!r}."
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify provider-neutral fields in a packaged Fikeya product.json."
    )
    parser.add_argument("product_json", type=Path, help="Path to the packaged resources/app/product.json")
    parser.add_argument("--executable", type=Path, help="Packaged Fikeya.exe to verify on Windows")
    parser.add_argument("--public-version", help="Human-facing prerelease version")
    parser.add_argument("--numeric-version", help="Four-part Windows PE version")
    arguments = parser.parse_args()
    try:
        verify_packaged_product(arguments.product_json.resolve())
        executable_arguments = (
            arguments.executable,
            arguments.public_version,
            arguments.numeric_version,
        )
        if any(executable_arguments) and not all(executable_arguments):
            raise ValueError(
                "--executable, --public-version, and --numeric-version must be provided together."
            )
        if arguments.executable:
            metadata = read_windows_executable_metadata(arguments.executable.resolve())
            verify_windows_executable_metadata(
                metadata,
                public_version=arguments.public_version,
                numeric_version=arguments.numeric_version,
            )
    except ValueError as error:
        parser.exit(1, f"ERROR: {error}\n")
    print(f"Packaged Fikeya product verified: {arguments.product_json}")
    print("Verified builtInAiExtensions is exactly [].")
    if arguments.executable:
        print(f"Packaged Fikeya executable verified: {arguments.executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
