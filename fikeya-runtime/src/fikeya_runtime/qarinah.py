# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Zero-shell Qarinah CLI adapter with content-free durable receipts."""

from __future__ import annotations

import json
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigurationError, FikeyaError
from .state import StateStore
from .util import sha256_bytes, sha256_text, stable_json
from .workspace import WorkspaceBoundary


@dataclass(frozen=True, slots=True)
class QarinahReceipt:
    """Content-free provenance for one Qarinah CLI call."""

    receipt_id: str
    request_sha256: str
    response_sha256: str
    response_bytes: int
    exit_code: int
    duration_ms: int
    coverage: str | None
    evidence_count: int | None


@dataclass(frozen=True, slots=True)
class QarinahQueryResult:
    """Ephemeral context plus the metadata retained after the call."""

    content: str
    receipt: QarinahReceipt


Runner = Callable[..., subprocess.CompletedProcess[str]]


class QarinahAdapter:
    """Invoke a separately installed Qarinah binary with an argv boundary."""

    def __init__(
        self,
        *,
        workspace_root: str | Path,
        state: StateStore,
        executable: str = "qarinah",
        runner: Runner = subprocess.run,
    ) -> None:
        if Path(executable).name != executable or executable.lower() in {
            "cmd",
            "powershell",
            "pwsh",
            "sh",
            "bash",
        }:
            raise ConfigurationError("Qarinah executable must be a command name.")
        self.boundary = WorkspaceBoundary(workspace_root)
        self.state = state
        self.executable = executable
        self._runner = runner

    def query(
        self,
        session_id: str,
        query: str,
        *,
        maximum_characters: int = 12_000,
        limit: int = 20,
        minimum_coverage: str = "partial",
        timeout_seconds: float = 30.0,
    ) -> QarinahQueryResult:
        """Compile context through stdin and persist no query or response body."""

        if not query or len(query) > 4_096 or "\x00" in query:
            raise ConfigurationError("Qarinah query must be 1-4096 characters.")
        if not 512 <= maximum_characters <= 1_000_000:
            raise ConfigurationError("maximum_characters must be between 512 and 1000000.")
        if not 1 <= limit <= 100:
            raise ConfigurationError("Qarinah result limit must be between 1 and 100.")
        if minimum_coverage not in {"any", "partial", "direct"}:
            raise ConfigurationError("minimum_coverage must be any, partial, or direct.")
        request = stable_json(
            {
                "format": "json",
                "limit": limit,
                "maxChars": maximum_characters,
                "minimumCoverage": minimum_coverage,
                "query": query,
            }
        )
        start = time.monotonic()
        try:
            completed = self._runner(
                [self.executable, "query", "--stdin-json"],
                cwd=self.boundary.root,
                input=request,
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise FikeyaError("The installed Qarinah CLI could not complete the query.") from error
        duration_ms = max(0, round((time.monotonic() - start) * 1_000))
        output_bytes = completed.stdout.encode("utf-8")
        coverage, evidence_count = _pack_metadata(completed.stdout)
        receipt_id = self.state.record_context_receipt(
            session_id,
            adapter="qarinah-cli",
            request_sha256=sha256_text(request),
            response_sha256=sha256_bytes(output_bytes),
            response_bytes=len(output_bytes),
            exit_code=completed.returncode,
            duration_ms=duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )
        receipt = QarinahReceipt(
            receipt_id=receipt_id,
            request_sha256=sha256_text(request),
            response_sha256=sha256_bytes(output_bytes),
            response_bytes=len(output_bytes),
            exit_code=completed.returncode,
            duration_ms=duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )
        if completed.returncode != 0:
            raise FikeyaError(
                f"Qarinah query failed with exit code {completed.returncode}; output was not retained."
            )
        return QarinahQueryResult(content=completed.stdout, receipt=receipt)

    def diagnostic(self, command: str, *, timeout_seconds: float = 15.0) -> str:
        """Run a zero-write status or doctor command and return ephemeral output."""

        if command not in {"status", "doctor"}:
            raise ConfigurationError("Qarinah diagnostic must be status or doctor.")
        try:
            completed = self._runner(
                [self.executable, command],
                cwd=self.boundary.root,
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise FikeyaError(f"The installed Qarinah CLI could not run {command}.") from error
        if completed.returncode != 0:
            raise FikeyaError(
                f"Qarinah {command} failed with exit code {completed.returncode}."
            )
        return completed.stdout


def _pack_metadata(content: str) -> tuple[str | None, int | None]:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(parsed, dict):
        return None, None
    coverage_value = parsed.get("coverage")
    if not isinstance(coverage_value, dict):
        retrieval = parsed.get("retrieval")
        if isinstance(retrieval, dict):
            coverage_value = retrieval.get("coverage")
    coverage = (
        str(coverage_value.get("status"))
        if isinstance(coverage_value, dict) and coverage_value.get("status") is not None
        else None
    )
    items = parsed.get("items")
    evidence_count = len(items) if isinstance(items, list) else None
    return coverage, evidence_count
