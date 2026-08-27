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


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"Packaged {label} was not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Packaged {label} is invalid JSON: {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Packaged {label} must contain a JSON object: {path}")
    return value


def verify_runtime_version_identity(
    product: Mapping[str, Any],
    package_configuration: Mapping[str, Any],
    *,
    runtime_version: str,
    public_version: str,
) -> None:
    """Keep extension API compatibility separate from Fikeya's public release version."""
    for source, value in (
        ("product.json version", product.get("version")),
        ("package.json version", package_configuration.get("version")),
    ):
        if value != runtime_version:
            raise ValueError(
                f"Packaged {source} is {value!r}; expected Code OSS runtime version "
                f"{runtime_version!r}. Public Fikeya versions must not replace the "
                "extension API compatibility version."
            )
    for source, value in (
        ("product.json distributionVersion", product.get("distributionVersion")),
        ("package.json distributionVersion", package_configuration.get("distributionVersion")),
    ):
        if value != public_version:
            raise ValueError(
                f"Packaged {source} is {value!r}; expected public Fikeya version "
                f"{public_version!r}."
            )


def verify_packaged_product(
    path: Path,
    *,
    package_path: Path | None = None,
    runtime_version: str | None = None,
    public_version: str | None = None,
) -> None:
    product = _read_json_object(path, "product.json")
    verify_built_in_ai_extensions(product, str(path))
    compatibility_arguments = (package_path, runtime_version, public_version)
    if any(argument is not None for argument in compatibility_arguments):
        if not all(argument is not None for argument in compatibility_arguments):
            raise ValueError(
                "package_path, runtime_version, and public_version must be provided together."
            )
        package_configuration = _read_json_object(package_path, "package.json")
        verify_runtime_version_identity(
            product,
            package_configuration,
            runtime_version=runtime_version,
            public_version=public_version,
        )


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
    parser.add_argument("--package-json", type=Path, help="Packaged resources/app/package.json")
    parser.add_argument("--runtime-version", help="Code OSS extension API compatibility version")
    parser.add_argument("--executable", type=Path, help="Packaged Fikeya.exe to verify on Windows")
    parser.add_argument("--public-version", help="Human-facing prerelease version")
    parser.add_argument("--numeric-version", help="Four-part Windows PE version")
    arguments = parser.parse_args()
    try:
        verify_packaged_product(
            arguments.product_json.resolve(),
            package_path=arguments.package_json.resolve() if arguments.package_json else None,
            runtime_version=arguments.runtime_version,
            public_version=arguments.public_version,
        )
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
    if arguments.package_json:
        print(
            "Verified Code OSS runtime compatibility version "
            f"{arguments.runtime_version} and Fikeya distribution version "
            f"{arguments.public_version}."
        )
    if arguments.executable:
        print(f"Packaged Fikeya executable verified: {arguments.executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
