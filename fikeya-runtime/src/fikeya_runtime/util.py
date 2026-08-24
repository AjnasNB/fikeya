# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Small deterministic helpers shared by the runtime."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .errors import ConfigurationError

_IDENTIFIER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$")


def utc_now() -> str:
    """Return a sortable UTC timestamp with millisecond precision."""

    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def stable_json(value: object) -> str:
    """Serialize JSON deterministically for hashing and persistence."""

    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def sha256_bytes(value: bytes) -> str:
    """Return a prefixed SHA-256 digest."""

    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_text(value: str) -> str:
    """Return a prefixed SHA-256 digest of UTF-8 text."""

    return sha256_bytes(value.encode("utf-8"))


def validate_identifier(value: str, label: str) -> str:
    """Validate identifiers before they enter paths, SQL rows, or protocols."""

    if not _IDENTIFIER.fullmatch(value):
        raise ConfigurationError(
            f"{label} must be 1-128 characters using letters, numbers, '.', '_', ':', or '-'."
        )
    return value


def read_json_object(path: Path) -> dict[str, object]:
    """Load a JSON object while rejecting other top-level shapes."""

    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigurationError(f"Could not read valid JSON from {path}: {error}") from error
    if not isinstance(value, dict):
        raise ConfigurationError(f"Expected a JSON object in {path}.")
    return value


def atomic_write_text(path: Path, content: str, mode: int = 0o600) -> None:
    """Replace a text file atomically and use private POSIX permissions."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            temporary_path = Path(handle.name)
        try:
            temporary_path.chmod(mode)
        except OSError:
            pass
        os.replace(temporary_path, path)
        temporary_path = None
        try:
            path.chmod(mode)
        except OSError:
            pass
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
