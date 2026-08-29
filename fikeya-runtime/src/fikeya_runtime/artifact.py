# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Deterministic, link-free artifact manifests for managed endpoint binaries."""

from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path
from typing import TypedDict

from .errors import ConfigurationError
from .util import sha256_text, stable_json

FIKEYA_ARTIFACT_SCHEMA = "maqam.fikeya-runtime-artifact.v1"
MAX_ARTIFACT_FILES = 16_384
MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024


class ArtifactFile(TypedDict):
    """One content-free file entry in a deterministic artifact manifest."""

    path: str
    size: int
    mode: int
    sha256: str


class ArtifactManifest(TypedDict):
    """Cross-language manifest shared by Fikeya and Maqam."""

    schema: str
    files: list[ArtifactFile]


def artifact_file_sha256(value: str | Path) -> str:
    """Hash one canonical, unshared regular file while detecting mutation."""

    path = _canonical_supplied_path(value, label="artifact executable")
    before = _safe_lstat(path, label="artifact executable")
    _require_regular_file(before, label="Artifact executables")
    return _digest_file(path, before)


def create_artifact_manifest(value: str | Path) -> ArtifactManifest:
    """Return the exact bounded cross-language artifact manifest."""

    root = _canonical_supplied_path(value, label="artifact root")
    root_info = _safe_lstat(root, label="artifact root")
    if not stat.S_ISDIR(root_info.st_mode) or _is_reparse(root_info):
        raise ConfigurationError(
            "The artifact root must be a real directory, not a link or reparse point."
        )

    files: list[ArtifactFile] = []
    total_bytes = 0

    def walk(directory: Path) -> None:
        nonlocal total_bytes
        try:
            with os.scandir(directory) as iterator:
                children = sorted(
                    iterator,
                    key=lambda item: item.name.encode(
                        "utf-16-be", errors="surrogatepass"
                    ),
                )
        except OSError as error:
            raise ConfigurationError(
                "The artifact directory could not be read."
            ) from error
        for child in children:
            child_path = directory / child.name
            if not _within(root, child_path):
                raise ConfigurationError("The artifact escaped its declared root.")
            information = _safe_lstat(child_path, label="artifact entry")
            if _is_reparse(information):
                raise ConfigurationError(
                    "Artifacts must not contain links or reparse points."
                )
            if stat.S_ISDIR(information.st_mode):
                walk(child_path)
                continue
            _require_regular_file(information, label="Artifact entries")
            total_bytes += information.st_size
            if len(files) >= MAX_ARTIFACT_FILES or total_bytes > MAX_ARTIFACT_BYTES:
                raise ConfigurationError(
                    "The artifact exceeds its file-count or byte-size limit."
                )
            relative = child_path.relative_to(root).as_posix()
            _validate_manifest_path(relative)
            files.append(
                {
                    "path": relative,
                    "size": information.st_size,
                    # Windows does not expose a portable POSIX mode.  Python
                    # and Node also synthesize different execute bits for the
                    # same file (notably npm .cmd shims), so the cross-language
                    # manifest deliberately uses zero there.
                    "mode": 0 if os.name == "nt" else information.st_mode & 0o777,
                    "sha256": _digest_file(child_path, information),
                }
            )

    walk(root)
    if not files:
        raise ConfigurationError("The artifact root must contain at least one file.")
    return {"schema": FIKEYA_ARTIFACT_SCHEMA, "files": files}


def artifact_sha256(value: str | Path) -> str:
    """Hash the stable canonical JSON manifest for an artifact root."""

    return sha256_text(stable_json(create_artifact_manifest(value)))


def _canonical_supplied_path(value: str | Path, *, label: str) -> Path:
    supplied = Path(value)
    if not supplied.is_absolute():
        raise ConfigurationError(f"The {label} must be an absolute path.")
    requested = Path(os.path.abspath(os.path.normpath(str(supplied))))
    try:
        canonical = requested.resolve(strict=True)
    except OSError as error:
        raise ConfigurationError(f"The {label} does not exist.") from error
    if not _same_path(requested, canonical):
        raise ConfigurationError(
            f"The {label} must not traverse a link or reparse point."
        )
    return canonical


def _safe_lstat(path: Path, *, label: str) -> os.stat_result:
    try:
        return path.lstat()
    except OSError as error:
        raise ConfigurationError(f"The {label} could not be inspected.") from error


def _require_regular_file(information: os.stat_result, *, label: str) -> None:
    if (
        not stat.S_ISREG(information.st_mode)
        or _is_reparse(information)
        or information.st_nlink != 1
    ):
        raise ConfigurationError(f"{label} must be private regular files.")


def _digest_file(path: Path, before: os.stat_result) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        after = path.stat()
    except OSError as error:
        raise ConfigurationError("The artifact file could not be hashed.") from error
    if _identity(before) != _identity(after):
        raise ConfigurationError(
            "The artifact changed while its manifest was calculated."
        )
    return f"sha256:{digest.hexdigest()}"


def _identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _is_reparse(value: os.stat_result) -> bool:
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISLNK(value.st_mode) or bool(
        flag and getattr(value, "st_file_attributes", 0) & flag
    )


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left)) == os.path.normcase(str(right))


def _within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def _validate_manifest_path(value: str) -> None:
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise ConfigurationError(
            "The artifact contains an invalid relative path."
        ) from error
    if (
        not value
        or value.startswith("/")
        or "\0" in value
        or len(encoded) > 4_096
        or encoded.decode("utf-8", errors="strict") != value
    ):
        raise ConfigurationError("The artifact contains an invalid relative path.")


__all__ = [
    "FIKEYA_ARTIFACT_SCHEMA",
    "MAX_ARTIFACT_BYTES",
    "MAX_ARTIFACT_FILES",
    "artifact_file_sha256",
    "artifact_sha256",
    "create_artifact_manifest",
]
