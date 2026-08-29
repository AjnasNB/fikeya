# SPDX-License-Identifier: AGPL-3.0-or-later

"""Build and verify the locked production Qarinah sidecar release bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "fikeya-runtime" / "src"))

from fikeya_runtime.artifact import (
    artifact_file_sha256,
    artifact_sha256,
    create_artifact_manifest,
)
from fikeya_runtime.util import stable_json

BUNDLE_SCHEMA = "fikeya.qarinah-sidecar-bundle.v1"
PACKAGE_NAME = "@fikeya/qarinah-sidecar"
PROTOCOL = "fikeya.qarinah-sidecar.v1"
ARTIFACT_DIRECTORY = "qarinah-sidecar"
BINDING_NAME = "qarinah-sidecar-binding.json"
FIXED_ZIP_TIME = (2020, 1, 1, 0, 0, 0)
RELEASE_VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$")
SEMVER_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")


class SidecarPackageError(ValueError):
    """Raised when the staged sidecar is incomplete or not reproducible."""


def package_sidecar(
    source_root: Path,
    output_directory: Path,
    release_version: str,
    *,
    node_executable: Path | None = None,
    run_smoke: bool = True,
) -> Path:
    """Stage, attest, archive, and optionally execute the production sidecar."""

    source_root = source_root.resolve(strict=True)
    output_directory = output_directory.resolve()
    if not source_root.is_dir() or not output_directory.is_dir():
        raise SidecarPackageError("Sidecar source and output must be directories.")
    if RELEASE_VERSION_PATTERN.fullmatch(release_version) is None:
        raise SidecarPackageError("Release version is not a Fikeya beta version.")

    package, qarinah_version = _validate_source_identity(source_root)
    bundle_path = output_directory / f"fikeya-qarinah-sidecar-{release_version}.zip"
    with tempfile.TemporaryDirectory(prefix="fikeya-qarinah-package-") as temporary:
        temporary_root = Path(temporary)
        artifact_root = temporary_root / ARTIFACT_DIRECTORY
        artifact_root.mkdir()
        for name in ("LICENSE", "README.md", "package-lock.json", "package.json"):
            _copy_regular_file(source_root / name, artifact_root / name)
        _copy_regular_tree(source_root / "src", artifact_root / "src")
        _copy_regular_tree(
            source_root / "node_modules",
            artifact_root / "node_modules",
            excluded_names={".bin"},
        )

        manifest = create_artifact_manifest(artifact_root)
        receipt: dict[str, Any] = {
            "artifactDirectory": ARTIFACT_DIRECTORY,
            "artifactManifest": manifest,
            "artifactSha256": artifact_sha256(artifact_root),
            "node": {
                "deploymentBound": True,
                "engines": package["engines"]["node"],
            },
            "packageJsonPath": "package.json",
            "packageJsonSha256": artifact_file_sha256(artifact_root / "package.json"),
            "packageName": PACKAGE_NAME,
            "protocol": PROTOCOL,
            "qarinahVersion": qarinah_version,
            "releaseVersion": release_version,
            "schema": BUNDLE_SCHEMA,
            "sidecarPath": "src/sidecar.mjs",
            "sidecarSha256": artifact_file_sha256(
                artifact_root / "src" / "sidecar.mjs"
            ),
            "version": package["version"],
        }
        receipt_path = temporary_root / BINDING_NAME
        receipt_path.write_text(stable_json(receipt) + "\n", encoding="utf-8")
        _write_deterministic_zip(bundle_path, temporary_root)

    verify_sidecar_bundle(
        bundle_path,
        expected_release_version=release_version,
        node_executable=node_executable,
        run_smoke=run_smoke,
    )
    return bundle_path


def verify_sidecar_bundle(
    bundle_path: Path,
    *,
    expected_release_version: str,
    node_executable: Path | None = None,
    run_smoke: bool = True,
) -> dict[str, Any]:
    """Verify archive paths, artifact receipt, package identity, and process API."""

    bundle_path = bundle_path.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="fikeya-qarinah-verify-") as temporary:
        extracted = Path(temporary)
        with zipfile.ZipFile(bundle_path) as archive:
            _validate_zip_members(archive)
            archive.extractall(extracted)
        receipt = _read_json_object(extracted / BINDING_NAME)
        if set(receipt) != {
            "artifactDirectory",
            "artifactManifest",
            "artifactSha256",
            "node",
            "packageJsonPath",
            "packageJsonSha256",
            "packageName",
            "protocol",
            "qarinahVersion",
            "releaseVersion",
            "schema",
            "sidecarPath",
            "sidecarSha256",
            "version",
        }:
            raise SidecarPackageError("Sidecar binding receipt keys are not exact.")
        if (
            receipt["schema"] != BUNDLE_SCHEMA
            or receipt["releaseVersion"] != expected_release_version
            or receipt["artifactDirectory"] != ARTIFACT_DIRECTORY
            or receipt["packageName"] != PACKAGE_NAME
            or receipt["protocol"] != PROTOCOL
        ):
            raise SidecarPackageError("Sidecar binding receipt identity is invalid.")
        artifact_root = extracted / ARTIFACT_DIRECTORY
        package_json = artifact_root / str(receipt["packageJsonPath"])
        sidecar = artifact_root / str(receipt["sidecarPath"])
        if (
            receipt["artifactManifest"] != create_artifact_manifest(artifact_root)
            or receipt["artifactSha256"] != artifact_sha256(artifact_root)
            or receipt["packageJsonSha256"] != artifact_file_sha256(package_json)
            or receipt["sidecarSha256"] != artifact_file_sha256(sidecar)
        ):
            raise SidecarPackageError("Sidecar binding receipt digest is invalid.")
        package = _read_json_object(package_json)
        if (
            package.get("name") != PACKAGE_NAME
            or package.get("version") != receipt["version"]
            or not isinstance(package.get("dependencies"), dict)
            or package["dependencies"].get("qarinah") != receipt["qarinahVersion"]
        ):
            raise SidecarPackageError("Sidecar package identity is invalid.")
        if run_smoke:
            node = (
                node_executable.resolve(strict=True)
                if node_executable is not None
                else _resolve_node()
            )
            _run_production_smoke(node, sidecar, receipt)
        return receipt


def _validate_source_identity(source_root: Path) -> tuple[dict[str, Any], str]:
    package = _read_json_object(source_root / "package.json")
    lock = _read_json_object(source_root / "package-lock.json")
    installed = _read_json_object(
        source_root / "node_modules" / "qarinah" / "package.json"
    )
    dependencies = package.get("dependencies")
    engines = package.get("engines")
    qarinah_version = (
        dependencies.get("qarinah") if isinstance(dependencies, dict) else None
    )
    lock_packages = lock.get("packages")
    lock_root = lock_packages.get("") if isinstance(lock_packages, dict) else None
    lock_qarinah = (
        lock_packages.get("node_modules/qarinah")
        if isinstance(lock_packages, dict)
        else None
    )
    if (
        package.get("name") != PACKAGE_NAME
        or not isinstance(package.get("version"), str)
        or SEMVER_PATTERN.fullmatch(package["version"]) is None
        or not isinstance(qarinah_version, str)
        or SEMVER_PATTERN.fullmatch(qarinah_version) is None
        or not isinstance(engines, dict)
        or not isinstance(engines.get("node"), str)
        or not isinstance(lock_root, dict)
        or lock_root.get("version") != package["version"]
        or not isinstance(lock_qarinah, dict)
        or lock_qarinah.get("version") != qarinah_version
        or installed.get("name") != "qarinah"
        or installed.get("version") != qarinah_version
    ):
        raise SidecarPackageError(
            "Run locked npm ci: sidecar package, lock, and installed Qarinah differ."
        )
    return package, qarinah_version


def _run_production_smoke(node: Path, sidecar: Path, receipt: dict[str, Any]) -> None:
    with tempfile.TemporaryDirectory(prefix="fikeya-qarinah-smoke-") as temporary:
        root = Path(temporary)
        version = _rpc(node, sidecar, root, "runtime.version", {})
        if version != {
            "name": PACKAGE_NAME,
            "protocol": PROTOCOL,
            "qarinahVersion": receipt["qarinahVersion"],
            "version": receipt["version"],
        }:
            raise SidecarPackageError("Staged sidecar runtime identity is invalid.")
        initialized = _rpc(
            node, sidecar, root, "memory.initialize", {"capture": "content"}
        )
        policy = initialized.get("policy")
        if not isinstance(policy, dict) or not isinstance(
            policy.get("policyHash"), str
        ):
            raise SidecarPackageError("Staged sidecar could not initialize Qarinah.")
        _rpc(
            node,
            sidecar,
            root,
            "memory.approve",
            {"capture": "content", "policyHash": policy["policyHash"]},
        )
        _rpc(
            node,
            sidecar,
            root,
            "memory.record",
            {
                "event": {
                    "id": "release-package-proof",
                    "occurredAt": "2026-08-29T00:00:00.000Z",
                    "payload": {
                        "body": "The released sidecar uses an exact locked package.",
                        "title": "Release package proof",
                    },
                    "sessionId": "session-release-package",
                    "type": "decision.recorded",
                }
            },
        )
        _rpc(
            node,
            sidecar,
            root,
            "memory.prepare",
            {
                "maxChars": 4_096,
                "maxTokens": 1_024,
                "query": "release package proof",
                "rebuild": True,
                "updateCheckpoint": True,
            },
        )
        projection = root / ".qarinah" / "index" / "event-ids" / "manifest.json"
        if not projection.is_file():
            raise SidecarPackageError("Qarinah smoke did not build its projection.")
        projection.unlink()
        before = _snapshot(root)
        result = _rpc(
            node,
            sidecar,
            root,
            "memory.prepare",
            {
                "maxChars": 4_096,
                "maxTokens": 1_024,
                "query": "release package proof",
                "rebuild": False,
                "updateCheckpoint": False,
            },
        )
        if not isinstance(result.get("items"), list) or not result["items"]:
            raise SidecarPackageError("Staged sidecar required-memory smoke is empty.")
        if _snapshot(root) != before or projection.exists():
            raise SidecarPackageError("Managed memory smoke mutated Qarinah state.")


def _rpc(
    node: Path,
    sidecar: Path,
    root: Path,
    method: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    request_id = f"package-{method.replace('.', '-')}"
    request = stable_json(
        {"id": request_id, "jsonrpc": "2.0", "method": method, "params": params}
    )
    try:
        completed = subprocess.run(
            [str(node), str(sidecar), "--root", str(root)],
            cwd=root,
            env=_safe_node_environment(),
            input=f"{request}\n",
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise SidecarPackageError("Staged sidecar process could not start.") from error
    if completed.returncode != 0 or len(completed.stdout.encode("utf-8")) > 1_048_576:
        raise SidecarPackageError("Staged sidecar process failed its bounded smoke.")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SidecarPackageError("Staged sidecar returned invalid JSON.") from error
    if (
        not isinstance(response, dict)
        or set(response) != {"id", "jsonrpc", "result"}
        or response.get("id") != request_id
        or response.get("jsonrpc") != "2.0"
        or not isinstance(response.get("result"), dict)
    ):
        raise SidecarPackageError("Staged sidecar returned an invalid envelope.")
    return response["result"]


def _safe_node_environment() -> dict[str, str]:
    allowed = {
        "APPDATA",
        "HOME",
        "LANG",
        "LOCALAPPDATA",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
    }
    return {key: value for key, value in os.environ.items() if key in allowed}


def _resolve_node() -> Path:
    value = shutil.which("node")
    if value is None:
        raise SidecarPackageError("Node is required for the sidecar package smoke.")
    return Path(value).resolve(strict=True)


def _copy_regular_tree(
    source: Path,
    destination: Path,
    *,
    excluded_names: set[str] | None = None,
) -> None:
    if not source.is_dir() or source.is_symlink():
        raise SidecarPackageError(f"Required sidecar directory is invalid: {source}")
    destination.mkdir()
    excluded = excluded_names or set()
    for child in sorted(source.iterdir(), key=lambda item: item.name):
        if child.name in excluded:
            continue
        target = destination / child.name
        if child.is_symlink() or _is_reparse(child):
            raise SidecarPackageError(f"Sidecar package contains a link: {child}")
        if child.is_dir():
            _copy_regular_tree(child, target)
        elif child.is_file():
            _copy_regular_file(child, target)
        else:
            raise SidecarPackageError(f"Sidecar package path is not regular: {child}")


def _copy_regular_file(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink() or _is_reparse(source):
        raise SidecarPackageError(f"Required sidecar file is invalid: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    os.chmod(destination, stat.S_IMODE(source.stat().st_mode))


def _is_reparse(path: Path) -> bool:
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & flag)


def _write_deterministic_zip(destination: Path, source_root: Path) -> None:
    if destination.exists():
        destination.unlink()
    with zipfile.ZipFile(
        destination,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        files = sorted(
            (item for item in source_root.rglob("*") if item.is_file()),
            key=lambda item: item.relative_to(source_root).as_posix(),
        )
        for path in files:
            relative = path.relative_to(source_root).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IMODE(path.stat().st_mode) & 0o777) << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)


def _validate_zip_members(archive: zipfile.ZipFile) -> None:
    names: set[str] = set()
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if (
            info.filename in names
            or path.is_absolute()
            or not path.parts
            or any(part in {"", ".", ".."} for part in path.parts)
            or "\\" in info.filename
            or (info.external_attr >> 16) & 0o170000 == stat.S_IFLNK
        ):
            raise SidecarPackageError("Sidecar bundle contains an unsafe member.")
        names.add(info.filename)
    if BINDING_NAME not in names or not any(
        name.startswith(f"{ARTIFACT_DIRECTORY}/") for name in names
    ):
        raise SidecarPackageError("Sidecar bundle is incomplete.")


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
        if not raw or len(raw) > 2_097_152:
            raise ValueError("JSON size")
        value = json.loads(raw.decode("utf-8", errors="strict"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise SidecarPackageError(f"Invalid JSON file: {path.name}") from error
    if not isinstance(value, dict):
        raise SidecarPackageError(f"JSON file is not an object: {path.name}")
    return value


def _snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    parser.add_argument("--release-version", required=True)
    parser.add_argument("--node", type=Path)
    parser.add_argument("--skip-smoke", action="store_true")
    arguments = parser.parse_args()
    path = package_sidecar(
        arguments.source,
        arguments.output_directory,
        arguments.release_version,
        node_executable=arguments.node,
        run_smoke=not arguments.skip_smoke,
    )
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
