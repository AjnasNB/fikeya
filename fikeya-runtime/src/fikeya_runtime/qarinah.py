# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Zero-shell Qarinah adapters with content-free durable receipts."""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable, Mapping
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

FIKEYA_NODE_EXECUTABLE = "FIKEYA_NODE_EXECUTABLE"
FIKEYA_QARINAH_SIDECAR = "FIKEYA_QARINAH_SIDECAR"
MAXIMUM_SIDECAR_RESPONSE_BYTES = 1024 * 1024
_SIDECAR_REQUEST_ID = "fikeya-memory-prepare"
_SHELL_WRAPPER_SUFFIXES = frozenset({".bat", ".cmd", ".ps1"})
_HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_WORKSPACE_ID_PATTERN = re.compile(r"^ws_[0-9a-f]{32}$")
_TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"
)
_SAFE_SIDECAR_ENVIRONMENT = frozenset(
    {
        "APPDATA",
        "COMSPEC",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "PATHEXT",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    }
)


class QarinahAdapter:
    """Invoke a separately installed Qarinah binary with an argv boundary."""

    def __init__(
        self,
        *,
        workspace_root: str | Path,
        state: StateStore,
        executable: str = "qarinah",
        runner: Runner = subprocess.run,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.boundary = WorkspaceBoundary(workspace_root)
        executable_path = Path(executable).expanduser()
        executable_name = executable_path.name.lower()
        if executable_path.suffix.lower() in _SHELL_WRAPPER_SUFFIXES or executable_name in {
            "cmd",
            "cmd.exe",
            "powershell",
            "powershell.exe",
            "pwsh",
            "pwsh.exe",
            "sh",
            "bash",
        }:
            raise ConfigurationError("Qarinah executable must be a command name.")
        if executable_path.is_absolute():
            resolved_executable = _trusted_external_file(
                executable_path,
                "Qarinah executable",
                self.boundary.root,
            )
            executable = str(resolved_executable)
        elif executable_path.name != executable:
            raise ConfigurationError("Qarinah executable must be a command name or absolute path.")
        self.state = state
        self.executable = executable
        self._runner = runner
        self._environment = _sidecar_environment(environment, self.boundary.root)

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

        _validate_query_options(query, maximum_characters, limit, minimum_coverage)
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
                env=self._environment,
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
        if completed.returncode != 0:
            self._record_receipt(
                session_id,
                request,
                completed.stdout,
                completed.returncode,
                duration_ms,
            )
            raise FikeyaError(
                f"Qarinah query failed with exit code {completed.returncode}; output was not retained."
            )
        try:
            pack = _parse_context_pack(completed.stdout)
            content = _validated_context_content(
                pack,
                query=query,
                maximum_characters=maximum_characters,
                limit=limit,
                minimum_coverage=minimum_coverage,
            )
        except FikeyaError:
            self._record_receipt(
                session_id,
                request,
                completed.stdout,
                completed.returncode,
                duration_ms,
            )
            raise
        coverage, evidence_count = _pack_metadata(content)
        receipt = self._record_receipt(
            session_id,
            request,
            content,
            completed.returncode,
            duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )
        return QarinahQueryResult(content=content, receipt=receipt)

    def _record_receipt(
        self,
        session_id: str,
        request: str,
        response: str,
        exit_code: int,
        duration_ms: int,
        *,
        coverage: str | None = None,
        evidence_count: int | None = None,
    ) -> QarinahReceipt:
        output_bytes = response.encode("utf-8")
        receipt_id = self.state.record_context_receipt(
            session_id,
            adapter="qarinah-cli",
            request_sha256=sha256_text(request),
            response_sha256=sha256_bytes(output_bytes),
            response_bytes=len(output_bytes),
            exit_code=exit_code,
            duration_ms=duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )
        return QarinahReceipt(
            receipt_id=receipt_id,
            request_sha256=sha256_text(request),
            response_sha256=sha256_bytes(output_bytes),
            response_bytes=len(output_bytes),
            exit_code=exit_code,
            duration_ms=duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )

    def diagnostic(self, command: str, *, timeout_seconds: float = 15.0) -> str:
        """Run a zero-write status or doctor command and return ephemeral output."""

        if command not in {"status", "doctor"}:
            raise ConfigurationError("Qarinah diagnostic must be status or doctor.")
        try:
            completed = self._runner(
                [self.executable, command],
                cwd=self.boundary.root,
                env=self._environment,
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


class QarinahSidecarAdapter:
    """Invoke Fikeya's pinned Qarinah JSON-RPC sidecar over stdio.

    Both executable paths must be absolute, existing files outside the authorized
    workspace. This prevents a repository from replacing either the interpreter
    or the reviewed sidecar implementation. The process receives no provider
    credentials and handles one root-bound request before it is discarded.
    """

    def __init__(
        self,
        *,
        workspace_root: str | Path,
        state: StateStore,
        node_executable: str | Path,
        sidecar_path: str | Path,
        runner: Runner = subprocess.run,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.boundary = WorkspaceBoundary(workspace_root)
        self.state = state
        self.node_executable = _trusted_external_file(
            node_executable,
            "Fikeya Node executable",
            self.boundary.root,
        )
        self.sidecar_path = _trusted_external_file(
            sidecar_path,
            "Fikeya Qarinah sidecar",
            self.boundary.root,
        )
        self._runner = runner
        self._environment = _sidecar_environment(environment, self.boundary.root)
        if self.node_executable.name.lower() not in {"node", "node.exe"}:
            self._environment["ELECTRON_RUN_AS_NODE"] = "1"

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
        """Call ``memory.prepare`` and retain only its content-free receipt."""

        _validate_query_options(query, maximum_characters, limit, minimum_coverage)
        params = {
            "limit": limit,
            "maxChars": maximum_characters,
            "maxTokens": max(128, (maximum_characters + 3) // 4),
            "minimumCoverage": minimum_coverage,
            "minimumEvidence": minimum_coverage,
            "query": query,
            "rebuild": True,
        }
        request = stable_json(
            {
                "id": _SIDECAR_REQUEST_ID,
                "jsonrpc": "2.0",
                "method": "memory.prepare",
                "params": params,
            }
        )
        start = time.monotonic()
        try:
            completed = self._runner(
                [
                    str(self.node_executable),
                    str(self.sidecar_path),
                    "--root",
                    str(self.boundary.root),
                ],
                cwd=self.boundary.root,
                env=self._environment,
                input=f"{request}\n",
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise FikeyaError("The configured Qarinah sidecar could not complete the query.") from error

        duration_ms = max(0, round((time.monotonic() - start) * 1_000))
        if completed.returncode != 0:
            self._record_receipt(
                session_id,
                request,
                completed.stdout,
                completed.returncode,
                duration_ms,
            )
            raise FikeyaError(
                f"Qarinah sidecar failed with exit code {completed.returncode}; output was not retained."
            )

        try:
            result = _parse_sidecar_result(completed.stdout)
            content = _validated_context_content(
                result,
                query=query,
                maximum_characters=maximum_characters,
                limit=limit,
                minimum_coverage=minimum_coverage,
            )
        except FikeyaError:
            self._record_receipt(
                session_id,
                request,
                completed.stdout,
                completed.returncode,
                duration_ms,
            )
            raise

        if len(content.encode("utf-8")) > MAXIMUM_SIDECAR_RESPONSE_BYTES:
            self._record_receipt(
                session_id,
                request,
                content,
                completed.returncode,
                duration_ms,
            )
            raise FikeyaError("Qarinah sidecar result exceeds the one-megabyte limit.")
        coverage, evidence_count = _pack_metadata(content)
        receipt = self._record_receipt(
            session_id,
            request,
            content,
            completed.returncode,
            duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )
        return QarinahQueryResult(content=content, receipt=receipt)

    def _record_receipt(
        self,
        session_id: str,
        request: str,
        response: str,
        exit_code: int,
        duration_ms: int,
        *,
        coverage: str | None = None,
        evidence_count: int | None = None,
    ) -> QarinahReceipt:
        response_bytes = response.encode("utf-8")
        receipt_id = self.state.record_context_receipt(
            session_id,
            adapter="qarinah-sidecar",
            request_sha256=sha256_text(request),
            response_sha256=sha256_bytes(response_bytes),
            response_bytes=len(response_bytes),
            exit_code=exit_code,
            duration_ms=duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )
        return QarinahReceipt(
            receipt_id=receipt_id,
            request_sha256=sha256_text(request),
            response_sha256=sha256_bytes(response_bytes),
            response_bytes=len(response_bytes),
            exit_code=exit_code,
            duration_ms=duration_ms,
            coverage=coverage,
            evidence_count=evidence_count,
        )


def select_qarinah_adapter(
    *,
    workspace_root: str | Path,
    state: StateStore,
    environment: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> QarinahAdapter | QarinahSidecarAdapter | None:
    """Prefer an explicitly configured sidecar, then an installed Qarinah CLI."""

    values = os.environ if environment is None else environment
    node_executable = values.get(FIKEYA_NODE_EXECUTABLE, "").strip()
    sidecar_path = values.get(FIKEYA_QARINAH_SIDECAR, "").strip()
    if bool(node_executable) != bool(sidecar_path):
        raise ConfigurationError(
            f"{FIKEYA_NODE_EXECUTABLE} and {FIKEYA_QARINAH_SIDECAR} must be configured together."
        )
    if node_executable and sidecar_path:
        return QarinahSidecarAdapter(
            workspace_root=workspace_root,
            state=state,
            node_executable=node_executable,
            sidecar_path=sidecar_path,
            environment=values,
        )
    qarinah_executable = which("qarinah")
    if qarinah_executable is not None and not _is_shell_wrapper(qarinah_executable):
        return QarinahAdapter(
            workspace_root=workspace_root,
            state=state,
            executable=qarinah_executable,
            environment=values,
        )
    return None


def qarinah_adapter_kind(
    environment: Mapping[str, str] | None = None,
    *,
    which: Callable[[str], str | None] = shutil.which,
) -> tuple[str | None, str]:
    """Describe selection without starting a sidecar or disclosing environment values."""

    values = os.environ if environment is None else environment
    has_node = bool(values.get(FIKEYA_NODE_EXECUTABLE, "").strip())
    has_sidecar = bool(values.get(FIKEYA_QARINAH_SIDECAR, "").strip())
    if has_node != has_sidecar:
        return None, "sidecar configuration is incomplete"
    if has_node:
        return "sidecar", "configured root-bound sidecar"
    qarinah_executable = which("qarinah")
    if qarinah_executable is not None and not _is_shell_wrapper(qarinah_executable):
        return "cli", "installed CLI"
    return None, "optional integration not found"


def _validate_query_options(
    query: str,
    maximum_characters: int,
    limit: int,
    minimum_coverage: str,
) -> None:
    if not query or len(query) > 4_096 or "\x00" in query:
        raise ConfigurationError("Qarinah query must be 1-4096 characters.")
    if not 512 <= maximum_characters <= 1_000_000:
        raise ConfigurationError("maximum_characters must be between 512 and 1000000.")
    if not 1 <= limit <= 100:
        raise ConfigurationError("Qarinah result limit must be between 1 and 100.")
    if minimum_coverage not in {"any", "partial", "direct"}:
        raise ConfigurationError("minimum_coverage must be any, partial, or direct.")


def _is_shell_wrapper(value: str | Path) -> bool:
    return Path(value).suffix.lower() in _SHELL_WRAPPER_SUFFIXES


def _trusted_external_file(value: str | Path, label: str, workspace_root: Path) -> Path:
    supplied = Path(value).expanduser()
    if not supplied.is_absolute():
        raise ConfigurationError(f"{label} must be an absolute path.")
    try:
        resolved = supplied.resolve(strict=True)
    except OSError as error:
        raise ConfigurationError(f"{label} does not resolve to an existing file.") from error
    if not resolved.is_file():
        raise ConfigurationError(f"{label} must resolve to a file.")
    try:
        common = Path(os.path.commonpath((workspace_root, resolved)))
    except ValueError:
        common = None
    if common is not None and os.path.normcase(str(common)) == os.path.normcase(
        str(workspace_root)
    ):
        raise ConfigurationError(f"{label} must be installed outside the workspace.")
    return resolved


def _sidecar_environment(
    source: Mapping[str, str] | None,
    workspace_root: Path,
) -> dict[str, str]:
    values = os.environ if source is None else source
    environment = {
        key: value
        for key, value in values.items()
        if key.upper() in _SAFE_SIDECAR_ENVIRONMENT and value and "\x00" not in value
    }
    path_value = values.get("PATH", "")
    safe_paths: list[str] = []
    for entry in path_value.split(os.pathsep):
        candidate = Path(entry).expanduser()
        if not entry or not candidate.is_absolute():
            continue
        resolved = candidate.resolve(strict=False)
        try:
            common = Path(os.path.commonpath((workspace_root, resolved)))
        except ValueError:
            common = None
        if common is not None and os.path.normcase(str(common)) == os.path.normcase(
            str(workspace_root)
        ):
            continue
        safe_paths.append(str(resolved))
    if safe_paths:
        environment["PATH"] = os.pathsep.join(safe_paths)
    return environment


def _parse_sidecar_result(content: str) -> dict[str, object]:
    if len(content.encode("utf-8")) > MAXIMUM_SIDECAR_RESPONSE_BYTES:
        raise FikeyaError("Qarinah sidecar response exceeds the one-megabyte limit.")
    lines = content.splitlines()
    if len(lines) != 1 or not lines[0]:
        raise FikeyaError("Qarinah sidecar returned an invalid JSON-RPC response.")
    try:
        message = json.loads(
            lines[0],
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant: {value}")
            ),
        )
    except (json.JSONDecodeError, ValueError) as error:
        raise FikeyaError("Qarinah sidecar returned an invalid JSON-RPC response.") from error
    if not isinstance(message, dict):
        raise FikeyaError("Qarinah sidecar returned an invalid JSON-RPC response.")
    if message.get("jsonrpc") != "2.0" or message.get("id") != _SIDECAR_REQUEST_ID:
        raise FikeyaError("Qarinah sidecar returned an unmatched JSON-RPC response.")
    error = message.get("error")
    if error is not None:
        code = error.get("code") if isinstance(error, dict) else None
        suffix = f" (code {code})" if isinstance(code, int) else ""
        raise FikeyaError(f"Qarinah sidecar rejected memory.prepare{suffix}.")
    result = message.get("result")
    if not isinstance(result, dict):
        raise FikeyaError("Qarinah sidecar returned no context result.")
    return result


def _parse_context_pack(content: str) -> dict[str, object]:
    if len(content.encode("utf-8")) > MAXIMUM_SIDECAR_RESPONSE_BYTES:
        raise FikeyaError("Qarinah context pack exceeds the one-megabyte limit.")
    try:
        value = json.loads(
            content,
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant: {constant}")
            ),
        )
    except (json.JSONDecodeError, ValueError) as error:
        raise FikeyaError("Qarinah returned an invalid context pack.") from error
    if not isinstance(value, dict):
        raise FikeyaError("Qarinah returned an invalid context pack.")
    return value


def _validated_context_content(
    pack: dict[str, object],
    *,
    query: str,
    maximum_characters: int,
    limit: int,
    minimum_coverage: str,
) -> str:
    """Validate the complete provider-bound Qarinah context-pack boundary."""

    _exact_keys(
        pack,
        {
            "schemaVersion",
            "workspaceId",
            "query",
            "contentRole",
            "budget",
            "retrieval",
            "items",
            "truncated",
            "manifestHash",
        },
        set(),
        "context pack",
    )
    if pack["schemaVersion"] != "qarinah.context-pack.v2":
        raise FikeyaError("Qarinah context pack has an unsupported schema version.")
    _bounded_string(pack["workspaceId"], "workspaceId", 35, 35, _WORKSPACE_ID_PATTERN)
    pack_query = _bounded_string(pack["query"], "query", 1, 4_096)
    if pack_query != query:
        raise FikeyaError("Qarinah context pack does not match the requested query.")
    if pack["contentRole"] != "untrusted-data":
        raise FikeyaError("Qarinah context pack is missing its untrusted-data boundary.")
    _bounded_string(pack["manifestHash"], "manifestHash", 71, 71, _HASH_PATTERN)
    if not isinstance(pack["truncated"], bool):
        raise FikeyaError("Qarinah context pack truncated must be a boolean.")

    budget = _record(pack["budget"], "budget")
    _validate_budget(budget, maximum_characters)
    retrieval = _record(pack["retrieval"], "retrieval")
    coverage = _validate_retrieval(retrieval, minimum_coverage)

    items = pack["items"]
    if not isinstance(items, list) or len(items) > min(limit, 1_000):
        raise FikeyaError("Qarinah context pack items exceed the requested result limit.")
    for index, item in enumerate(items):
        _validate_context_item(_record(item, f"items[{index}]"), index)

    content = stable_json(pack)
    content_characters = len(content)
    used_characters = _bounded_integer(
        budget["usedChars"],
        "budget.usedChars",
        0,
        maximum_characters,
    )
    if content_characters > used_characters or content_characters > maximum_characters:
        raise FikeyaError("Qarinah context pack content exceeds its declared budget.")
    if coverage not in {"none", "partial", "direct"}:
        raise FikeyaError("Qarinah context pack coverage is invalid for a non-empty query.")
    return content


def _validate_budget(budget: dict[str, object], maximum_characters: int) -> None:
    token_keys = {
        "maxTokens",
        "usedTokens",
        "reservedTokens",
        "availableTokens",
        "estimator",
        "allocations",
        "reservationPolicyHash",
    }
    _exact_keys(
        budget,
        {"maxChars", "usedChars", "estimatedTokens"},
        token_keys,
        "budget",
    )
    max_characters = _bounded_integer(budget["maxChars"], "budget.maxChars", 512, 1_000_000)
    if max_characters != maximum_characters:
        raise FikeyaError("Qarinah context pack does not honor the requested character budget.")
    _bounded_integer(budget["usedChars"], "budget.usedChars", 0, max_characters)
    _bounded_integer(budget["estimatedTokens"], "budget.estimatedTokens", 0, 1_000_000)
    present_token_keys = token_keys.intersection(budget)
    if present_token_keys and present_token_keys != token_keys:
        raise FikeyaError("Qarinah context pack token budget fields are incomplete.")
    if not present_token_keys:
        return
    max_tokens = _bounded_integer(budget["maxTokens"], "budget.maxTokens", 128, 1_000_000)
    _bounded_integer(budget["usedTokens"], "budget.usedTokens", 0, max_tokens)
    _bounded_integer(budget["reservedTokens"], "budget.reservedTokens", 0, max_tokens)
    _bounded_integer(budget["availableTokens"], "budget.availableTokens", 64, max_tokens)
    _bounded_string(
        budget["reservationPolicyHash"],
        "budget.reservationPolicyHash",
        71,
        71,
        _HASH_PATTERN,
    )
    estimator = _record(budget["estimator"], "budget.estimator")
    _exact_keys(estimator, {"id", "version", "exact"}, set(), "budget.estimator")
    _bounded_string(estimator["id"], "budget.estimator.id", 1, 64)
    _bounded_string(estimator["version"], "budget.estimator.version", 1, 64)
    if not isinstance(estimator["exact"], bool):
        raise FikeyaError("Qarinah budget estimator exact must be a boolean.")
    allocations = _record(budget["allocations"], "budget.allocations")
    _exact_keys(
        allocations,
        {"framing", "citations", "content"},
        set(),
        "budget.allocations",
    )
    for name in ("framing", "citations", "content"):
        _bounded_integer(allocations[name], f"budget.allocations.{name}", 0, max_tokens)


def _validate_retrieval(
    retrieval: dict[str, object],
    minimum_coverage: str,
) -> str:
    _exact_keys(
        retrieval,
        {"strategy", "supersessionPolicy", "asOf", "coverage"},
        {
            "rankingProfile",
            "temporalBoundary",
            "authorityScope",
            "authorityScopes",
            "repositoryIds",
            "readModel",
            "queryExpansion",
            "evidenceSufficiency",
            "filters",
            "conflicts",
            "exclusions",
        },
        "retrieval",
    )
    _enum(retrieval["strategy"], "retrieval.strategy", {"hybrid-local-v1", "admission-first-hybrid-v2"})
    _enum(
        retrieval["supersessionPolicy"],
        "retrieval.supersessionPolicy",
        {"prefer-current", "include-history"},
    )
    _bounded_string(retrieval["asOf"], "retrieval.asOf", 24, 24, _TIMESTAMP_PATTERN)
    if "rankingProfile" in retrieval:
        _enum(retrieval["rankingProfile"], "retrieval.rankingProfile", {"balanced-v1", "admission-first-v2"})
    if "temporalBoundary" in retrieval:
        _enum(retrieval["temporalBoundary"], "retrieval.temporalBoundary", {"inclusive", "strict-before"})
    if "readModel" in retrieval:
        _enum(retrieval["readModel"], "retrieval.readModel", {"sqlite-fts5", "verified-ledger-memory"})
    if "authorityScope" in retrieval:
        _bounded_string(retrieval["authorityScope"], "retrieval.authorityScope", 1, 256)
    for field in ("authorityScopes", "repositoryIds"):
        if field in retrieval:
            _bounded_string_list(retrieval[field], f"retrieval.{field}", 64, 256)
    if "queryExpansion" in retrieval:
        expansion = _record(retrieval["queryExpansion"], "retrieval.queryExpansion")
        _exact_keys(expansion, {"adapter", "addedTermCount"}, set(), "retrieval.queryExpansion")
        _bounded_string(expansion["adapter"], "retrieval.queryExpansion.adapter", 1, 256)
        _bounded_integer(expansion["addedTermCount"], "retrieval.queryExpansion.addedTermCount", 0, 16)
    if "evidenceSufficiency" in retrieval:
        _validate_evidence_sufficiency(
            _record(retrieval["evidenceSufficiency"], "retrieval.evidenceSufficiency")
        )
    if "filters" in retrieval:
        filters = _record(retrieval["filters"], "retrieval.filters")
        names = {"expired", "future", "notYetValid", "stale", "unauthorized"}
        _exact_keys(filters, names, set(), "retrieval.filters")
        values = [_bounded_integer(filters[name], f"retrieval.filters.{name}", 0, 1_000_000) for name in names]
        if not any(values):
            raise FikeyaError("Qarinah retrieval filters must report at least one exclusion.")
    if "conflicts" in retrieval:
        _validate_conflicts(retrieval["conflicts"])
    if "exclusions" in retrieval:
        _validate_exclusions(retrieval["exclusions"])

    coverage = _record(retrieval["coverage"], "retrieval.coverage")
    _exact_keys(
        coverage,
        {
            "method",
            "status",
            "queryTermCount",
            "bestExactTermCount",
            "bestExactTermRatio",
            "directCandidateCount",
        },
        {"warning"},
        "retrieval.coverage",
    )
    if coverage["method"] != "query-term-overlap-v1":
        raise FikeyaError("Qarinah context pack uses an unsupported coverage method.")
    status = _enum(
        coverage["status"],
        "retrieval.coverage.status",
        {"none", "partial", "direct"},
    )
    query_terms = _bounded_integer(
        coverage["queryTermCount"],
        "retrieval.coverage.queryTermCount",
        0,
        4_096,
    )
    exact_terms = _bounded_integer(
        coverage["bestExactTermCount"],
        "retrieval.coverage.bestExactTermCount",
        0,
        4_096,
    )
    if exact_terms > query_terms:
        raise FikeyaError("Qarinah coverage exact-term count exceeds its query-term count.")
    _bounded_number(
        coverage["bestExactTermRatio"],
        "retrieval.coverage.bestExactTermRatio",
        0,
        1,
    )
    _bounded_integer(
        coverage["directCandidateCount"],
        "retrieval.coverage.directCandidateCount",
        0,
        1_000_000,
    )
    if "warning" in coverage:
        _bounded_string(coverage["warning"], "retrieval.coverage.warning", 1, 512)
    accepted = {
        "any": {"none", "partial", "direct"},
        "partial": {"partial", "direct"},
        "direct": {"direct"},
    }
    if status not in accepted[minimum_coverage]:
        raise FikeyaError("Qarinah context pack does not satisfy requested coverage.")
    return status


def _validate_evidence_sufficiency(value: dict[str, object]) -> None:
    required = {
        "method",
        "state",
        "decision",
        "score",
        "directThreshold",
        "partialThreshold",
        "bestExactTermRatio",
        "topLexicalScore",
        "lexicalScoreMargin",
        "supportingCandidateCount",
        "codeEntityCount",
        "matchedCodeEntityCount",
        "codeEntityCoverage",
        "reasonCodes",
    }
    _exact_keys(value, required, set(), "retrieval.evidenceSufficiency")
    if value["method"] != "evidence-sufficiency-v2":
        raise FikeyaError("Qarinah evidence sufficiency method is unsupported.")
    _enum(
        value["state"],
        "retrieval.evidenceSufficiency.state",
        {"DIRECTLY_SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"},
    )
    _enum(value["decision"], "retrieval.evidenceSufficiency.decision", {"ACCEPT_DIRECT", "ABSTAIN"})
    for field in (
        "score",
        "directThreshold",
        "partialThreshold",
        "bestExactTermRatio",
        "lexicalScoreMargin",
        "codeEntityCoverage",
    ):
        _bounded_number(value[field], f"retrieval.evidenceSufficiency.{field}", 0, 1)
    _bounded_number(value["topLexicalScore"], "retrieval.evidenceSufficiency.topLexicalScore", 0, 1_000_000)
    _bounded_integer(value["supportingCandidateCount"], "retrieval.evidenceSufficiency.supportingCandidateCount", 0, 1_000_000)
    _bounded_integer(value["codeEntityCount"], "retrieval.evidenceSufficiency.codeEntityCount", 0, 64)
    _bounded_integer(value["matchedCodeEntityCount"], "retrieval.evidenceSufficiency.matchedCodeEntityCount", 0, 64)
    _bounded_string_list(value["reasonCodes"], "retrieval.evidenceSufficiency.reasonCodes", 10, 64)


def _validate_conflicts(value: object) -> None:
    if not isinstance(value, list) or len(value) > 100:
        raise FikeyaError("Qarinah retrieval conflicts are invalid.")
    for index, item in enumerate(value):
        conflict = _record(item, f"retrieval.conflicts[{index}]")
        _exact_keys(conflict, {"eventIds"}, set(), f"retrieval.conflicts[{index}]")
        event_ids = _bounded_string_list(
            conflict["eventIds"],
            f"retrieval.conflicts[{index}].eventIds",
            2,
            64,
            exact_items=2,
        )
        if len(set(event_ids)) != 2:
            raise FikeyaError("Qarinah retrieval conflict event IDs must be unique.")


def _validate_exclusions(value: object) -> None:
    if not isinstance(value, list) or len(value) > 100:
        raise FikeyaError("Qarinah retrieval exclusions are invalid.")
    for index, item in enumerate(value):
        exclusion = _record(item, f"retrieval.exclusions[{index}]")
        _exact_keys(exclusion, {"eventId", "reason", "by"}, set(), f"retrieval.exclusions[{index}]")
        _bounded_string(exclusion["eventId"], f"retrieval.exclusions[{index}].eventId", 1, 64)
        if exclusion["reason"] != "superseded":
            raise FikeyaError("Qarinah retrieval exclusion reason is invalid.")
        _bounded_string_list(
            exclusion["by"],
            f"retrieval.exclusions[{index}].by",
            128,
            64,
            minimum_items=1,
        )


def _validate_context_item(item: dict[str, object], index: int) -> None:
    label = f"items[{index}]"
    _exact_keys(
        item,
        {"eventId", "kind", "timestamp", "title", "excerpt", "confidence", "reason", "hash"},
        {"authority", "temporal", "repository", "disclosure"},
        label,
    )
    _bounded_string(item["eventId"], f"{label}.eventId", 1, 64)
    _bounded_string(item["kind"], f"{label}.kind", 1, 64)
    _bounded_string(item["timestamp"], f"{label}.timestamp", 24, 24, _TIMESTAMP_PATTERN)
    _bounded_string(item["title"], f"{label}.title", 0, 512)
    _bounded_string(item["excerpt"], f"{label}.excerpt", 0, 65_536)
    _enum(item["confidence"], f"{label}.confidence", {"extracted", "inferred", "claimed", "verified"})
    _bounded_string(item["reason"], f"{label}.reason", 0, 512)
    _bounded_string(item["hash"], f"{label}.hash", 71, 71, _HASH_PATTERN)
    if "authority" in item:
        authority = _record(item["authority"], f"{label}.authority")
        _exact_keys(
            authority,
            {"scope", "rank", "assignedBy", "assignedAt", "expiresAt", "revokedAt", "basis"},
            set(),
            f"{label}.authority",
        )
        _bounded_string(authority["scope"], f"{label}.authority.scope", 1, 256)
        _bounded_integer(authority["rank"], f"{label}.authority.rank", 0, 100)
        _bounded_string(authority["assignedBy"], f"{label}.authority.assignedBy", 1, 256)
        _bounded_string(authority["assignedAt"], f"{label}.authority.assignedAt", 1, 24)
        for field in ("expiresAt", "revokedAt"):
            if authority[field] is not None:
                _bounded_string(authority[field], f"{label}.authority.{field}", 1, 24)
        _bounded_string(authority["basis"], f"{label}.authority.basis", 1, 512)
    if "temporal" in item:
        temporal = _record(item["temporal"], f"{label}.temporal")
        _exact_keys(temporal, set(), {"validFrom", "validUntil"}, f"{label}.temporal")
        if "validFrom" in temporal:
            _bounded_string(temporal["validFrom"], f"{label}.temporal.validFrom", 24, 24, _TIMESTAMP_PATTERN)
        if "validUntil" in temporal and temporal["validUntil"] is not None:
            _bounded_string(temporal["validUntil"], f"{label}.temporal.validUntil", 24, 24, _TIMESTAMP_PATTERN)
    if "repository" in item:
        repository = _record(item["repository"], f"{label}.repository")
        _exact_keys(repository, {"id"}, {"branch", "commit"}, f"{label}.repository")
        _bounded_string(repository["id"], f"{label}.repository.id", 1, 256)
        if "branch" in repository:
            _bounded_string(repository["branch"], f"{label}.repository.branch", 1, 256)
        if "commit" in repository:
            _bounded_string(repository["commit"], f"{label}.repository.commit", 7, 128)
    if "disclosure" in item:
        disclosure = _record(item["disclosure"], f"{label}.disclosure")
        _exact_keys(disclosure, {"scopes", "classification"}, set(), f"{label}.disclosure")
        _bounded_string_list(disclosure["scopes"], f"{label}.disclosure.scopes", 64, 256)
        _enum(disclosure["classification"], f"{label}.disclosure.classification", {"public", "workspace", "restricted"})


def _record(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise FikeyaError(f"Qarinah context pack {label} must be an object.")
    return value


def _exact_keys(
    value: dict[str, object],
    required: set[str],
    optional: set[str],
    label: str,
) -> None:
    keys = set(value)
    if not required.issubset(keys) or not keys.issubset(required | optional):
        raise FikeyaError(f"Qarinah context pack {label} has invalid fields.")


def _bounded_string(
    value: object,
    label: str,
    minimum: int,
    maximum: int,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if (
        not isinstance(value, str)
        or "\x00" in value
        or not minimum <= len(value) <= maximum
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        raise FikeyaError(f"Qarinah context pack {label} is invalid.")
    return value


def _bounded_integer(value: object, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise FikeyaError(f"Qarinah context pack {label} is invalid.")
    return value


def _bounded_number(value: object, label: str, minimum: float, maximum: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise FikeyaError(f"Qarinah context pack {label} is invalid.")
    return float(value)


def _enum(value: object, label: str, allowed: set[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise FikeyaError(f"Qarinah context pack {label} is invalid.")
    return value


def _bounded_string_list(
    value: object,
    label: str,
    maximum_items: int,
    maximum_characters: int,
    *,
    minimum_items: int = 0,
    exact_items: int | None = None,
) -> list[str]:
    if not isinstance(value, list):
        raise FikeyaError(f"Qarinah context pack {label} must be an array.")
    if exact_items is not None:
        valid_length = len(value) == exact_items
    else:
        valid_length = minimum_items <= len(value) <= maximum_items
    if not valid_length:
        raise FikeyaError(f"Qarinah context pack {label} has an invalid length.")
    strings = [
        _bounded_string(item, f"{label}[{index}]", 1, maximum_characters)
        for index, item in enumerate(value)
    ]
    if len(set(strings)) != len(strings):
        raise FikeyaError(f"Qarinah context pack {label} must contain unique values.")
    return strings


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
