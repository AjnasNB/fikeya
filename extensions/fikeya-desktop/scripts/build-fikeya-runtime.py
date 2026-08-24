# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build the extension-owned, platform-specific Fikeya Runtime executable."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


PINNED_DISTRIBUTIONS = {
    "azure-identity": "1.25.3",
    "jaraco.classes": "3.4.0",
    "jaraco.context": "6.1.2",
    "jaraco.functools": "4.6.0",
    "keyring": "25.7.0",
    "more-itertools": "11.1.0",
    "pyinstaller": "6.22.2",
}
LEGACY_PYTHON_DISTRIBUTIONS = {"backports.tarfile": "1.2.0"}
WINDOWS_DISTRIBUTIONS = {"pywin32-ctypes": "0.2.3"}
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


def distribution_license(distribution_name: str) -> tuple[importlib.metadata.Distribution, Path]:
    distribution = importlib.metadata.distribution(distribution_name)
    candidates = [
        item for item in distribution.files or []
        if any(token in str(item).lower() for token in ("license", "copying", "notice"))
    ]
    if len(candidates) != 1:
        raise RuntimeError(f"Expected one license file for {distribution_name}, found {len(candidates)}.")
    return distribution, Path(distribution.locate_file(candidates[0])).resolve()


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
    license_path = next((candidate for candidate in candidates if candidate.is_file()), None)
    if license_path is None:
        raise RuntimeError("The embedded Python distribution license was not found.")
    if license_path == vendored_license:
        license_sha256 = hashlib.sha256(license_path.read_bytes()).hexdigest()
        if license_sha256 != VENDORED_PYTHON_LICENSE_SHA256:
            raise RuntimeError("The vendored Python license does not match its reviewed digest.")
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


def main() -> int:
    args = parse_arguments()
    extension_root = args.extension_root.resolve()
    repository_root = args.repository_root.resolve()
    target = expected_target()
    if args.target != target:
        raise RuntimeError(f"Requested VSIX target {args.target} does not match this builder ({target}).")

    runtime_source = repository_root / "fikeya-runtime" / "src"
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
        "--collect-all",
        "azure.identity",
        "--collect-all",
        "keyring",
        "--add-data",
        f"{preset_source}{separator}fikeya_runtime/presets",
        str(entrypoint),
    ]
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

    executable_name = "fikeya-runtime.exe" if sys.platform == "win32" else "fikeya-runtime"
    executable = dist_root / executable_name
    if not executable.is_file() or executable.stat().st_size < 1_000_000:
        raise RuntimeError("PyInstaller did not produce the expected standalone runtime executable.")

    distributions = dict(PINNED_DISTRIBUTIONS)
    if sys.version_info < (3, 12):
        distributions.update(LEGACY_PYTHON_DISTRIBUTIONS)
    if sys.platform == "win32":
        distributions.update(WINDOWS_DISTRIBUTIONS)
    package_receipts = []
    for name, version in sorted(distributions.items()):
        installed = importlib.metadata.version(name)
        if installed != version:
            raise RuntimeError(f"{name} must be exactly {version}; found {installed}.")
        distribution, license_source = distribution_license(name)
        destination = license_root / name / license_source.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(license_source, destination)
        package_receipts.append({
            "name": name,
            "version": version,
            "licenseFile": destination.relative_to(build_root).as_posix(),
            "metadataName": distribution.metadata.get("Name", name),
        })

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
        "packages": package_receipts,
        "pythonLicenseFile": python_license_destination.relative_to(build_root).as_posix(),
    }
    receipt_path = build_root / "build-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**receipt, "executablePath": str(executable)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
