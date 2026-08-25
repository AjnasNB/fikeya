#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Dependency-free validation shared by the Fikeya bootstrap entry points."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, NoReturn


class BootstrapError(RuntimeError):
    """An actionable bootstrap validation error."""


_VERSION_PATTERN = re.compile(
    r"(?<!\d)(?P<major>0|[1-9]\d*)\."
    r"(?P<minor>0|[1-9]\d*)\."
    r"(?P<patch>0|[1-9]\d*)(?!\d)"
)


def parse_version(value: str) -> tuple[int, int, int]:
    """Parse a three-part version from a command's version output."""

    match = _VERSION_PATTERN.search(value.strip())
    if match is None:
        raise BootstrapError(f"could not parse a major.minor.patch version from {value!r}")
    return tuple(int(match.group(part)) for part in ("major", "minor", "patch"))


def format_version(version: tuple[int, int, int]) -> str:
    """Return a normalized version string."""

    return ".".join(str(part) for part in version)


def validate_node_version(value: str, requirements: dict[str, Any]) -> str:
    """Validate Node against the component manifest's supported release lines."""

    version = parse_version(value)
    allowed_majors = tuple(int(item) for item in requirements["allowedMajors"])
    if version[0] not in allowed_majors:
        allowed = ", ".join(str(item) for item in allowed_majors)
        raise BootstrapError(
            f"Node {format_version(version)} is unsupported; use a maintained Fikeya line: {allowed}"
        )

    minimum = requirements.get("minimumByMajor", {}).get(str(version[0]))
    if minimum is not None and version < parse_version(str(minimum)):
        raise BootstrapError(
            f"Node {format_version(version)} is too old; Node {minimum} or newer is required"
        )
    return format_version(version)


def validate_python_version(value: str, requirements: dict[str, Any]) -> str:
    """Validate Python against the component manifest's supported range."""

    version = parse_version(value)
    minimum = parse_version(str(requirements["minimum"]))
    maximum = parse_version(str(requirements["maximumExclusive"]))
    if version < minimum or version >= maximum:
        raise BootstrapError(
            f"Python {format_version(version)} is unsupported; use Python "
            f">={format_version(minimum)} and <{format_version(maximum)}"
        )
    return format_version(version)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def resolve_project_root(value: str | os.PathLike[str]) -> Path:
    """Resolve and validate a Fikeya source checkout without guessing upward."""

    try:
        root = Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise BootstrapError(f"project root does not exist: {value}") from error
    if not root.is_dir():
        raise BootstrapError(f"project root is not a directory: {root}")

    markers = (
        "product.json",
        "fikeya-agent-core/pyproject.toml",
        "fikeya-runtime/pyproject.toml",
        "packages/fikeya-protocol/package-lock.json",
        "integrations/qarinah-sidecar/package-lock.json",
    )
    missing = [marker for marker in markers if not (root / marker).is_file()]
    if missing:
        raise BootstrapError(
            "project root is not a complete Fikeya checkout; missing: " + ", ".join(missing)
        )
    return root


def load_manifest(root: Path) -> dict[str, Any]:
    """Load the checked-in bundle manifest and validate all referenced paths."""

    manifest_path = root / "scripts" / "fikeya" / "components.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BootstrapError(f"cannot read component manifest: {manifest_path}") from error

    if manifest.get("schemaVersion") != 1:
        raise BootstrapError("unsupported component manifest schema")
    components = manifest.get("components")
    if not isinstance(components, list) or not components:
        raise BootstrapError("component manifest does not define any components")

    seen: set[str] = set()
    for component in components:
        if not isinstance(component, dict) or not isinstance(component.get("id"), str):
            raise BootstrapError("component manifest contains an invalid component")
        component_id = component["id"]
        if component_id in seen:
            raise BootstrapError(f"component manifest contains duplicate id: {component_id}")
        seen.add(component_id)

        for key in ("path", "lock", "constraints"):
            relative = component.get(key)
            if relative is None:
                continue
            candidate = (root / str(relative)).resolve(strict=True)
            if not _is_within(candidate, root):
                raise BootstrapError(f"component {component_id} {key} escapes the project root")
    return manifest


def default_cache_base() -> Path:
    """Return the current user's platform cache directory without creating it."""

    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "Fikeya"


def project_fingerprint(root: Path) -> str:
    """Derive a content-free checkout identifier from its canonical path."""

    canonical = os.path.normcase(str(root.resolve(strict=True)))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def resolve_cache_path(root: Path, cache_base: str | None) -> Path:
    """Resolve a per-checkout cache target and reject broad filesystem roots."""

    base = Path(cache_base).expanduser() if cache_base else default_cache_base()
    try:
        base = base.resolve(strict=False)
    except (OSError, RuntimeError) as error:
        raise BootstrapError(f"cache root cannot be resolved: {base}") from error
    if base == Path(base.anchor):
        raise BootstrapError("cache root cannot be a filesystem root")

    target = base / "developer-alpha" / project_fingerprint(root)
    if target == root or target == Path(target.anchor):
        raise BootstrapError("cache target is too broad")
    return target


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_receipt(
    root: Path,
    cache_path: Path,
    manifest: dict[str, Any],
    node_version: str,
    python_version: str,
) -> Path:
    """Write a deterministic, content-free verification receipt atomically."""

    components: list[dict[str, str]] = []
    for component in manifest["components"]:
        record = {
            "id": component["id"],
            "kind": component["kind"],
            "version": component["version"],
        }
        integrity_path = component.get("lock") or component.get("constraints")
        if integrity_path is not None:
            record["integrity"] = "sha256:" + _sha256(root / integrity_path)
        components.append(record)

    installed = {}
    for distribution in ("fikeya-agent-core", "fikeya-runtime", "azure-identity", "keyring"):
        try:
            installed[distribution] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError as error:
            raise BootstrapError(f"runtime verification failed; missing package: {distribution}") from error

    receipt = {
        "channel": manifest["channel"],
        "components": components,
        "environment": {
            "node": validate_node_version(node_version, manifest["requirements"]["node"]),
            "python": validate_python_version(
                python_version, manifest["requirements"]["python"]
            ),
        },
        "installedPythonDistributions": installed,
        "projectFingerprint": project_fingerprint(root),
        "schemaVersion": 1,
    }

    cache_path.mkdir(parents=True, exist_ok=True)
    destination = cache_path / "verification.json"
    payload = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    temporary_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=cache_path, prefix=".verification-", delete=False
        ) as temporary:
            temporary.write(payload)
            temporary_name = temporary.name
        os.replace(temporary_name, destination)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return destination


def _common_parser(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", required=True)
    parser.add_argument("--cache-root")


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a Fikeya developer-alpha bundle")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate")
    _common_parser(validate_parser)
    validate_parser.add_argument("--node-version", required=True)
    validate_parser.add_argument("--npm-version", required=True)
    validate_parser.add_argument("--python-version", required=True)

    cache_parser = subparsers.add_parser("cache-path")
    _common_parser(cache_parser)

    receipt_parser = subparsers.add_parser("write-receipt")
    _common_parser(receipt_parser)
    receipt_parser.add_argument("--node-version", required=True)
    receipt_parser.add_argument("--python-version", required=True)
    return parser.parse_args(argv)


def _fail(message: str) -> NoReturn:
    print(f"[error] {message}", file=sys.stderr)
    raise SystemExit(2)


def main(argv: list[str] | None = None) -> int:
    """Run a support command for a platform bootstrap script."""

    arguments = _parse_arguments(argv if argv is not None else sys.argv[1:])
    try:
        root = resolve_project_root(arguments.root)
        manifest = load_manifest(root)
        cache_path = resolve_cache_path(root, arguments.cache_root)

        if arguments.command == "cache-path":
            print(cache_path)
            return 0

        if arguments.command == "validate":
            node = validate_node_version(
                arguments.node_version, manifest["requirements"]["node"]
            )
            python = validate_python_version(
                arguments.python_version, manifest["requirements"]["python"]
            )
            parse_version(arguments.npm_version)
            print("[check] project checkout: ok")
            print(f"[check] component manifest: ok ({len(manifest['components'])} components)")
            print(f"[check] Node.js: ok ({node})")
            print(f"[check] npm: ok ({arguments.npm_version.strip().lstrip('v')})")
            print(f"[check] Python: ok ({python})")
            print("[check] isolated cache target: ok")
            return 0

        destination = build_receipt(
            root,
            cache_path,
            manifest,
            arguments.node_version,
            arguments.python_version,
        )
        print(destination)
        return 0
    except BootstrapError as error:
        _fail(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
