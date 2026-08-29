# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import zipfile
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from uuid import uuid4

import pytest
from fikeya_agent_core import ApprovalDecision, CancellationToken
from fikeya_runtime.agent import MemoryPreparation
from fikeya_runtime.artifact import artifact_file_sha256, artifact_sha256
from fikeya_runtime.cli import main
from fikeya_runtime.coding import (
    CodingAgentRunner,
    ToolExecutionReceipt,
    WorkspaceExecutionBroker,
)
from fikeya_runtime.endpoint import (
    ENDPOINT_PROTOCOL,
    ENDPOINT_REQUEST_SCHEMA,
    ENDPOINT_RESULT_SCHEMA,
    MAX_ENDPOINT_BYTES,
    EndpointResult,
    execute_endpoint_request,
    read_endpoint_request,
    validate_endpoint_request,
)
from fikeya_runtime.errors import (
    ConfigurationError,
    EndpointAuthorizationExpiredError,
    ProviderError,
    StateError,
    WorkspaceError,
)
from fikeya_runtime.events import EventType
from fikeya_runtime.inference import JsonResponse, ProviderExecutor
from fikeya_runtime.modes import AgentMode
from fikeya_runtime.providers import ProviderKind, ProviderStore, build_profile
from fikeya_runtime.qarinah import QarinahSidecarAdapter, QarinahSidecarVersion
from fikeya_runtime.state import StateStore
from fikeya_runtime.util import sha256_text, stable_json
from fikeya_runtime.workspace import initialize_workspace

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect
_READ_TOOLS = [
    "workspace.list_files",
    "workspace.read_file",
    "workspace.search_text",
]
_CONFORMANCE_FIXTURE = (
    Path(__file__).parent / "fixtures" / "endpoint-v2-conformance.json"
)


class _MemorySecrets:
    def set(self, account: str, secret: str) -> str:
        raise AssertionError("the local fixture cannot write credentials")

    def get(self, reference: str) -> str:
        raise AssertionError("the local fixture cannot read credentials")

    def delete(self, reference: str) -> None:
        raise AssertionError("the local fixture cannot delete credentials")


class _FakeRunner:
    def __init__(
        self,
        *,
        tools: tuple[str, ...] = (),
        status: str = "completed",
        steps: int = 2,
        usage: dict[str, object] | None = None,
        fail: bool = False,
        delay: float = 0,
        tool_status: str = "ok",
        memory: MemoryPreparation | None = None,
    ) -> None:
        self.tools = tools
        self.status = status
        self.steps = steps
        self.usage = usage or {
            "cachedInputTokens": 4,
            "inputTokens": 20,
            "measurement": "provider-reported",
            "outputTokens": 6,
        }
        self.fail = fail
        self.delay = delay
        self.tool_status = tool_status
        self.memory = memory or MemoryPreparation(status="off")
        self.kwargs: dict[str, object] = {}
        self.decisions: list[ApprovalDecision] = []

    async def run(self, **kwargs: object) -> object:
        self.kwargs = kwargs
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("private failure detail must not cross the wire")
        approval_handler = cast(object, kwargs["approval_handler"])
        receipts = []
        for index, tool_name in enumerate(self.tools):
            decision = await approval_handler(  # type: ignore[operator]
                {
                    "arguments": {},
                    "argumentsSha256": "sha256:" + ("a" * 64),
                    "callId": f"call-{index}",
                    "expectedRevision": index,
                    "requestId": f"request-{index}",
                    "sessionId": kwargs["session_id"],
                    "summary": "bounded tool request",
                    "toolName": tool_name,
                    "type": "approval",
                }
            )
            self.decisions.append(decision)
            receipts.append(
                ToolExecutionReceipt(
                    arguments_sha256="sha256:" + ("a" * 64),
                    call_id=f"call-{index}",
                    name=tool_name,
                    output_sha256=sha256_text("bounded fake tool result"),
                    status=self.tool_status,
                )
            )
        return SimpleNamespace(
            session_id=kwargs["session_id"],
            status=self.status,
            steps=self.steps,
            usage=self.usage,
            tool_calls=tuple(receipts),
            memory=self.memory,
        )


class _UsageTransport:
    def __init__(self, output_tokens: list[int]) -> None:
        self.output_tokens = output_tokens
        self.calls = 0
        self.requested_max_tokens: list[int] = []

    def post(self, *arguments: object, **keyword_arguments: object) -> JsonResponse:
        del keyword_arguments
        request_body = json.loads(cast(bytes, arguments[2]))
        self.requested_max_tokens.append(cast(int, request_body["max_tokens"]))
        decisions = (
            {"kind": "plan", "content": "Return one bounded answer."},
            {"kind": "answer", "content": "Bounded answer."},
            {
                "kind": "review",
                "reviewAction": "complete",
                "content": "Bounded reviewed answer.",
            },
        )
        index = self.calls
        self.calls += 1
        body = {
            "choices": [{"message": {"content": stable_json(decisions[index])}}],
            "usage": {
                "completion_tokens": self.output_tokens[index],
                "prompt_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 4},
            },
        }
        raw = stable_json(body).encode("utf-8")
        return JsonResponse(200, body, raw)


class _MutableClock:
    def __init__(self, current: datetime) -> None:
        self.current = current

    def __call__(self) -> datetime:
        return self.current


class _ClockAdvancingRunner(_FakeRunner):
    def __init__(self, clock: _MutableClock, finish_at: datetime) -> None:
        super().__init__()
        self.clock = clock
        self.finish_at = finish_at

    async def run(self, **kwargs: object) -> object:
        self.clock.current = self.finish_at
        return await super().run(**kwargs)


class _ArtifactMutatingRunner(_FakeRunner):
    def __init__(self, path: Path) -> None:
        super().__init__(
            memory=MemoryPreparation(
                status="used",
                receipt_id="ctx_bounded",
                response_sha256="sha256:" + ("c" * 64),
                evidence_count=1,
            )
        )
        self.path = path

    async def run(self, **kwargs: object) -> object:
        self.path.write_text(
            "// changed after authorization consumption\n", encoding="utf-8"
        )
        return await super().run(**kwargs)


class _UnmatchedToolRunner:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace

    async def run(self, **kwargs: object) -> object:
        state = StateStore(self.workspace / ".fikeya" / "state.sqlite3")
        session_id = cast(str, kwargs["session_id"])
        state.create_session(session_id=session_id)
        state.append_event(
            session_id,
            EventType.TOOL_REQUESTED,
            {
                "argumentsSha256": "sha256:" + ("a" * 64),
                "callId": "call-unmatched",
                "requestId": "request-unmatched",
                "toolName": "workspace.read_file",
            },
        )
        raise RuntimeError("post-start fixture failure")


def _run(coroutine: object, monkeypatch: pytest.MonkeyPatch) -> object:
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    return asyncio.run(coroutine)  # type: ignore[arg-type]


def _fixture(
    tmp_path: Path,
    *,
    access: str = "read",
    tools: list[str] | None = None,
    max_tool_calls: int | None = None,
) -> tuple[dict[str, object], ProviderStore, Path]:
    root = tmp_path / "workspace"
    root.mkdir(parents=True)
    initialize_workspace(root)
    providers = ProviderStore(tmp_path / "home", _MemorySecrets())
    profile = providers.configure(
        build_profile(name="local", kind=ProviderKind.OLLAMA, model="qwen2.5-coder"),
        None,
    )
    selected_tools = list(_READ_TOOLS if tools is None else tools)
    scope: dict[str, object] = {
        "access": access,
        "allowNetwork": False,
        "capabilities": {"allowedTools": selected_tools},
        "commandId": str(uuid4()),
        "endpointId": str(uuid4()),
        "limits": {
            "maxOutputTokens": 512,
            "maxSteps": 8,
            "maxToolCalls": (
                len(selected_tools) if max_tool_calls is None else max_tool_calls
            ),
            "timeoutMs": 30_000,
        },
        "memory": {
            "adapter": None,
            "contextMaxCharacters": 4_096,
            "mode": "off",
            "rebuild": False,
        },
        "prompt": "Inspect the project and return a bounded result.",
        "provider": {
            "model": profile.model,
            "profileName": profile.name,
            "profileSha256": sha256_text(stable_json(profile.as_json())),
        },
        "runId": str(uuid4()),
        "schema": ENDPOINT_REQUEST_SCHEMA,
        "tenantId": str(uuid4()),
        "toolCallId": f"tool-{uuid4()}",
        "workingDirectory": str(root.resolve()),
    }
    value = {
        **scope,
        "authorization": {
            "approvalId": f"approval-{uuid4()}",
            "decision": "allow",
            "expiresAt": "2999-01-01T00:00:00.000Z",
            "scopeSha256": sha256_text(stable_json(scope)),
        },
    }
    return value, providers, root.resolve()


def _rescope(value: dict[str, object]) -> None:
    authorization = cast(dict[str, object], value["authorization"])
    scope = {key: item for key, item in value.items() if key != "authorization"}
    authorization["scopeSha256"] = sha256_text(stable_json(scope))


def _bind_memory_sidecar(
    value: dict[str, object],
    tmp_path: Path,
    *,
    mode: str = "required",
) -> tuple[Path, Path, Path]:
    artifact_root = tmp_path / "qarinah-artifact"
    artifact_root.mkdir()
    sidecar = artifact_root / "qarinah-sidecar.mjs"
    sidecar.write_text("// signed Qarinah sidecar fixture\n", encoding="utf-8")
    package_json = artifact_root / "package.json"
    package_json.write_text(
        stable_json(
            {
                "dependencies": {"qarinah": "0.4.0"},
                "name": "@fikeya/qarinah-sidecar",
                "version": "0.1.0",
            }
        ),
        encoding="utf-8",
    )
    node = tmp_path / ("node.exe" if sys.platform == "win32" else "node")
    node.write_bytes(b"signed node fixture\n")
    node.chmod(0o755)
    memory = cast(dict[str, object], value["memory"])
    memory.update(
        {
            "adapter": {
                "artifactRoot": str(artifact_root.resolve()),
                "artifactSha256": artifact_sha256(artifact_root.resolve()),
                "kind": "qarinah-node-sidecar",
                "nodeExecutable": str(node.resolve()),
                "nodeSha256": artifact_file_sha256(node.resolve()),
                "packageJsonPath": str(package_json.resolve()),
                "packageJsonSha256": artifact_file_sha256(package_json.resolve()),
                "sidecarPath": str(sidecar.resolve()),
                "sidecarSha256": artifact_file_sha256(sidecar.resolve()),
                "version": "0.1.0",
            },
            "mode": mode,
            "rebuild": False,
        }
    )
    _rescope(value)
    return node.resolve(), sidecar.resolve(), artifact_root.resolve()


def _sidecar_rpc(
    node: Path,
    sidecar: Path,
    root: Path,
    method: str,
    params: dict[str, object],
) -> dict[str, object]:
    request_id = f"test-{method.replace('.', '-')}"
    completed = subprocess.run(
        [str(node), str(sidecar), "--root", str(root)],
        cwd=root,
        input=f"{stable_json({'id': request_id, 'jsonrpc': '2.0', 'method': method, 'params': params})}\n",
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
        shell=False,
    )
    assert completed.returncode == 0, completed.stderr
    response = json.loads(completed.stdout)
    assert response["id"] == request_id
    assert response["jsonrpc"] == "2.0"
    assert "error" not in response, response
    return cast(dict[str, object], response["result"])


def _snapshot_without_fikeya_state(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.relative_to(root).parts[0] != ".fikeya"
    }


def test_endpoint_version_probe_is_exact_and_v1_is_rejected(capsys: object) -> None:
    assert main(["endpoint", "version", "--protocol", ENDPOINT_PROTOCOL, "--json"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert set(output) == {"name", "schema", "version"}
    assert output["name"] == "fikeya"
    assert output["schema"] == "maqam.endpoint-runtime.v1"

    assert (
        main(
            ["endpoint", "version", "--protocol", "maqam.endpoint-harness.v1", "--json"]
        )
        == 2
    )
    failure = json.loads(capsys.readouterr().out)
    assert failure == {
        "error": "The requested Fikeya endpoint protocol is unsupported.",
        "ok": False,
    }


def test_endpoint_v2_conformance_fixture_hashes_are_stable() -> None:
    fixture = json.loads(_CONFORMANCE_FIXTURE.read_text(encoding="utf-8"))
    request = cast(dict[str, object], fixture["request"])
    authorization = cast(dict[str, object], request["authorization"])
    scope = {key: value for key, value in request.items() if key != "authorization"}
    result = cast(dict[str, object], fixture["result"])
    outcome = {key: value for key, value in result.items() if key != "outcomeSha256"}

    assert fixture["schema"] == "fikeya.endpoint-conformance-fixture.v1"
    assert fixture["protocol"] == ENDPOINT_PROTOCOL
    assert authorization["scopeSha256"] == sha256_text(stable_json(scope))
    assert fixture["requestSha256"] == sha256_text(stable_json(request))
    assert result["requestSha256"] == fixture["requestSha256"]
    assert result["outcomeSha256"] == sha256_text(stable_json(outcome))
    assert {case["name"] for case in fixture["invalidCases"]} == {
        "expiry-offset",
        "expiry-overprecision",
        "expiry-space-separator",
        "provider-leading-whitespace",
        "tool-call-trailing-whitespace",
        "working-directory-dot-segment",
    }


def test_real_cli_execute_settles_a_post_start_provider_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: object,
) -> None:
    value, _providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    request_hash = sha256_text(stable_json(value))
    monkeypatch.chdir(root)
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    monkeypatch.setattr(
        sys,
        "stdin",
        SimpleNamespace(buffer=io.BytesIO(stable_json(value).encode("utf-8"))),
    )

    exit_code = main(
        [
            "--home",
            str(tmp_path / "home"),
            "endpoint",
            "execute",
            "--protocol",
            ENDPOINT_PROTOCOL,
            "--json",
        ]
    )

    assert exit_code == 0
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == "failed"
    assert output["errorCode"] == "FIKEYA_RUNTIME_FAILED"
    assert output["requestSha256"] == request_hash
    assert output["effects"] == {
        "complete": True,
        "measurement": "local-receipt-chain",
        "receiptSha256": "sha256:29ca707cbd81c124eaa849d792efe7aa8c2e1c1a875b689c87d100c42fbc43dd",
        "toolCallCount": 0,
        "writeCount": 0,
    }
    assert output["memory"] == {
        "complete": True,
        "evidenceCount": 0,
        "mode": "off",
        "receiptId": None,
        "responseSha256": None,
        "status": "off",
    }
    assert output["usage"] == {
        "cachedInputTokens": None,
        "complete": False,
        "costMicros": None,
        "currency": None,
        "inputTokens": None,
        "measurement": "unavailable",
        "outputTokens": None,
        "reasoningTokens": None,
    }


def test_endpoint_request_is_strict_bounded_and_correlated(tmp_path: Path) -> None:
    value, _providers, root = _fixture(tmp_path)
    encoded = stable_json(value).encode()
    request = read_endpoint_request(io.BytesIO(encoded), cwd=root)
    assert request.request_sha256 == sha256_text(stable_json(value))
    assert request.allowed_tools == frozenset(_READ_TOOLS)
    assert request.working_directory == root

    with pytest.raises(ProviderError, match="strict UTF-8 JSON"):
        read_endpoint_request(io.BytesIO(b'{"schema":1,"schema":2}'), cwd=root)
    with pytest.raises(ProviderError, match="strict UTF-8 JSON"):
        read_endpoint_request(io.BytesIO(stable_json(value).encode("utf-16")), cwd=root)
    surrogate_payload = encoded.replace(
        cast(str, value["prompt"]).encode("utf-8"), b"\\ud800", 1
    )
    with pytest.raises(ProviderError, match="bounded string"):
        read_endpoint_request(io.BytesIO(surrogate_payload), cwd=root)
    with pytest.raises(ProviderError, match="exceeds"):
        read_endpoint_request(io.BytesIO(b"{" + (b" " * MAX_ENDPOINT_BYTES)), cwd=root)

    multibyte = deepcopy(value)
    multibyte["toolCallId"] = "é" * 128
    _rescope(multibyte)
    assert validate_endpoint_request(multibyte, cwd=root).tool_call_id == "é" * 128
    multibyte["toolCallId"] = "é" * 129
    _rescope(multibyte)
    with pytest.raises(ProviderError, match="bounded string"):
        validate_endpoint_request(multibyte, cwd=root)

    provider_boundary = deepcopy(value)
    provider = cast(dict[str, object], provider_boundary["provider"])
    provider["profileName"] = "p" * 128
    _rescope(provider_boundary)
    assert (
        validate_endpoint_request(provider_boundary, cwd=root).provider.profile_name
        == "p" * 128
    )
    provider["profileName"] = "p" * 129
    _rescope(provider_boundary)
    with pytest.raises(ProviderError, match="bounded string"):
        validate_endpoint_request(provider_boundary, cwd=root)

    absolute_prefix = root.anchor
    remaining = 4_096 - len(absolute_prefix.encode("utf-8"))
    exact_path = absolute_prefix + ("é" * (remaining // 2)) + ("a" * (remaining % 2))
    assert len(exact_path.encode("utf-8")) == 4_096
    exact_working_directory = deepcopy(value)
    exact_working_directory["workingDirectory"] = exact_path
    _rescope(exact_working_directory)
    with pytest.raises(WorkspaceError, match="does not exist"):
        validate_endpoint_request(exact_working_directory, cwd=root)
    oversized_working_directory = deepcopy(value)
    oversized_working_directory["workingDirectory"] = exact_path + "é"
    _rescope(oversized_working_directory)
    with pytest.raises(WorkspaceError, match="bounded absolute path"):
        validate_endpoint_request(oversized_working_directory, cwd=root)

    unknown = deepcopy(value)
    unknown["unexpected"] = True
    with pytest.raises(ProviderError, match="missing or unknown"):
        validate_endpoint_request(unknown, cwd=root)

    downgrade = deepcopy(value)
    downgrade["schema"] = "maqam.endpoint-harness-request.v1"
    _rescope(downgrade)
    with pytest.raises(
        ProviderError, match="must be maqam.endpoint-harness-request.v2"
    ):
        validate_endpoint_request(downgrade, cwd=root)


@pytest.mark.parametrize(
    "expires_at",
    [
        "2999-01-01 00:00:00Z",
        "2999-01-01T00:00:00+00:00",
        "2999-01-01",
        "2999-01-01T00:00:00,1Z",
        "2999-01-01T00:00:00.1234567Z",
        " 2999-01-01T00:00:00Z",
        "x" * 65,
        None,
    ],
)
def test_endpoint_rejects_noncanonical_authorization_timestamps(
    tmp_path: Path,
    expires_at: object,
) -> None:
    value, _providers, root = _fixture(tmp_path)
    cast(dict[str, object], value["authorization"])["expiresAt"] = expires_at

    with pytest.raises(ProviderError):
        validate_endpoint_request(value, cwd=root)


@pytest.mark.parametrize(
    "expires_at",
    [
        "2999-01-01T00:00:00Z",
        "2999-01-01T00:00:00.1Z",
        "2999-01-01T00:00:00.123456Z",
    ],
)
def test_endpoint_accepts_exact_authorization_timestamp_precision(
    tmp_path: Path,
    expires_at: str,
) -> None:
    value, _providers, root = _fixture(tmp_path)
    cast(dict[str, object], value["authorization"])["expiresAt"] = expires_at

    assert (
        validate_endpoint_request(value, cwd=root).authorization.expires_at.year == 2999
    )


def test_endpoint_rejects_noncanonical_working_directory_spelling(
    tmp_path: Path,
) -> None:
    value, _providers, root = _fixture(tmp_path)
    noncanonical = str(root / ".." / root.name)
    assert Path(noncanonical).resolve() == root
    value["workingDirectory"] = noncanonical
    _rescope(value)

    with pytest.raises(WorkspaceError, match="lexically normalized"):
        validate_endpoint_request(value, cwd=root)


def test_endpoint_result_rejects_cross_language_wire_mismatches() -> None:
    base = {
        "request_sha256": "sha256:" + ("a" * 64),
        "status": "failed",
        "session_id": "ses_endpoint_wire",
        "provider": "local",
        "model": "model",
    }
    with pytest.raises(StateError, match="errorCode"):
        EndpointResult(**base, error_code="runtime-failed").as_json()
    with pytest.raises(StateError, match="inconsistent"):
        EndpointResult(**base, error_code=None).as_json()
    with pytest.raises(StateError, match="Unavailable"):
        EndpointResult(
            **base,
            error_code="FIKEYA_RUNTIME_FAILED",
            complete=True,
            input_tokens=0,
            cached_input_tokens=0,
            output_tokens=0,
        ).as_json()
    for field in ("session_id", "provider", "model"):
        invalid = dict(base)
        invalid[field] = f" {invalid[field]}"
        with pytest.raises(StateError, match="identity"):
            EndpointResult(
                **invalid,
                error_code="FIKEYA_RUNTIME_FAILED",
            ).as_json()
    with pytest.raises(StateError, match="local effect"):
        EndpointResult(
            **base,
            error_code="FIKEYA_RUNTIME_FAILED",
            effects_measurement="local-receipt-chain",
            effects_complete=True,
            effect_receipt_sha256="sha256:" + ("0" * 64),
            tool_call_count=0,
            write_count=0,
        ).as_json()
    with pytest.raises(StateError, match="memory receipt"):
        EndpointResult(
            **base,
            error_code="FIKEYA_RUNTIME_FAILED",
            memory_mode="auto",
            memory_status="used",
            memory_complete=True,
            memory_receipt_id=" receipt-with-space",
            memory_response_sha256="sha256:" + ("c" * 64),
            memory_evidence_count=0,
        ).as_json()
    with pytest.raises(StateError, match="complete local effect chain"):
        EndpointResult(
            request_sha256=cast(str, base["request_sha256"]),
            status="succeeded",
            session_id=cast(str, base["session_id"]),
            provider=cast(str, base["provider"]),
            model=cast(str, base["model"]),
            error_code=None,
            measurement="provider-reported",
            complete=True,
            input_tokens=1,
            cached_input_tokens=0,
            output_tokens=1,
        ).as_json()
    with pytest.raises(StateError, match="complete provider-reported usage"):
        EndpointResult(
            request_sha256=cast(str, base["request_sha256"]),
            status="succeeded",
            session_id=cast(str, base["session_id"]),
            provider=cast(str, base["provider"]),
            model=cast(str, base["model"]),
            error_code=None,
            effects_measurement="local-receipt-chain",
            effects_complete=True,
            effect_receipt_sha256="sha256:29ca707cbd81c124eaa849d792efe7aa8c2e1c1a875b689c87d100c42fbc43dd",
            tool_call_count=0,
            write_count=0,
        ).as_json()
    with pytest.raises(StateError, match="effect receipt chain"):
        EndpointResult(
            **base,
            error_code="FIKEYA_RUNTIME_FAILED",
            effects_measurement="local-receipt-chain",
            effects_complete=True,
            effect_receipt_sha256="sha256:" + ("b" * 64),
            tool_call_count=1,
            write_count=2,
        ).as_json()
    with pytest.raises(StateError, match="required-memory"):
        EndpointResult(
            request_sha256=cast(str, base["request_sha256"]),
            status="succeeded",
            session_id=cast(str, base["session_id"]),
            provider=cast(str, base["provider"]),
            model=cast(str, base["model"]),
            error_code=None,
            measurement="provider-reported",
            complete=True,
            input_tokens=1,
            cached_input_tokens=0,
            output_tokens=1,
            effects_measurement="local-receipt-chain",
            effects_complete=True,
            effect_receipt_sha256="sha256:29ca707cbd81c124eaa849d792efe7aa8c2e1c1a875b689c87d100c42fbc43dd",
            tool_call_count=0,
            write_count=0,
            memory_mode="required",
            memory_status="unavailable",
            memory_complete=False,
            memory_receipt_id=None,
            memory_response_sha256=None,
            memory_evidence_count=None,
        ).as_json()


@pytest.mark.parametrize(
    ("mutation", "error_type", "message"),
    [
        (
            lambda value: value.update({"workingDirectory": "."}),
            WorkspaceError,
            "absolute",
        ),
        (
            lambda value: cast(dict[str, object], value["authorization"]).update(
                {"decision": "deny"}
            ),
            ProviderError,
            "decision",
        ),
        (
            lambda value: cast(dict[str, object], value["authorization"]).update(
                {"expiresAt": "2000-01-01T00:00:00.000Z"}
            ),
            ProviderError,
            "expired",
        ),
        (
            lambda value: cast(dict[str, object], value["capabilities"]).update(
                {"allowedTools": ["process.run"]}
            ),
            ProviderError,
            "denied",
        ),
        (
            lambda value: cast(dict[str, object], value["capabilities"]).update(
                {"allowedTools": list(reversed(_READ_TOOLS))}
            ),
            ProviderError,
            "sorted",
        ),
    ],
)
def test_endpoint_rejects_path_authorization_and_capability_errors(
    tmp_path: Path,
    mutation: object,
    error_type: type[Exception],
    message: str,
) -> None:
    value, _providers, root = _fixture(tmp_path)
    mutation(value)  # type: ignore[operator]
    _rescope(value)
    with pytest.raises(error_type, match=message):
        validate_endpoint_request(value, cwd=root)


def test_managed_memory_binds_exact_node_sidecar_and_ignores_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    node, _sidecar, _artifact_root = _bind_memory_sidecar(value, tmp_path)
    rogue = tmp_path / "rogue-path"
    rogue.mkdir()
    (rogue / node.name).write_bytes(b"unsigned PATH replacement\n")
    monkeypatch.setenv("PATH", str(rogue))
    monkeypatch.setattr(
        QarinahSidecarAdapter,
        "version",
        lambda _self: QarinahSidecarVersion(
            name="@fikeya/qarinah-sidecar",
            protocol="fikeya.qarinah-sidecar.v1",
            version="0.1.0",
            qarinah_version="0.4.0",
        ),
    )
    runner = _FakeRunner(
        memory=MemoryPreparation(
            status="used",
            receipt_id="ctx_exact_sidecar",
            response_sha256="sha256:" + ("d" * 64),
            evidence_count=2,
        )
    )
    request = validate_endpoint_request(value, cwd=root)

    payload = _run(
        execute_endpoint_request(
            request, providers, runner_factory=lambda _workspace, _providers: runner
        ),
        monkeypatch,
    ).as_json()

    managed = runner.kwargs["memory_provider"]
    assert payload["status"] == "succeeded"
    assert payload["memory"] == {
        "complete": True,
        "evidenceCount": 2,
        "mode": "required",
        "receiptId": "ctx_exact_sidecar",
        "responseSha256": "sha256:" + ("d" * 64),
        "status": "used",
    }
    assert managed.adapter.node_executable == node  # type: ignore[union-attr]
    assert runner.kwargs["allow_discovered_memory"] is False


@pytest.mark.parametrize(
    "field",
    ["toolCallId", "approvalId", "profileName", "model"],
)
def test_endpoint_rejects_identity_whitespace(
    tmp_path: Path,
    field: str,
) -> None:
    value, _providers, root = _fixture(tmp_path)
    if field == "toolCallId":
        value[field] = f" {value[field]}"
    elif field == "approvalId":
        authorization = cast(dict[str, object], value["authorization"])
        authorization[field] = f"{authorization[field]} "
    else:
        provider = cast(dict[str, object], value["provider"])
        provider[field] = f" {provider[field]}"
    _rescope(value)

    with pytest.raises(ProviderError, match="surrounding whitespace"):
        validate_endpoint_request(value, cwd=root)


@pytest.mark.parametrize(
    "digest_field",
    ["nodeSha256", "sidecarSha256", "packageJsonSha256", "artifactSha256"],
)
def test_managed_memory_rejects_digest_tampering_before_execution(
    tmp_path: Path,
    digest_field: str,
) -> None:
    value, _providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    _bind_memory_sidecar(value, tmp_path)
    adapter = cast(
        dict[str, object], cast(dict[str, object], value["memory"])["adapter"]
    )
    adapter[digest_field] = "sha256:" + ("0" * 64)
    _rescope(value)

    with pytest.raises(ProviderError, match="artifact binding"):
        validate_endpoint_request(value, cwd=root)


def test_managed_memory_rejects_sidecar_outside_artifact_and_node_wrappers(
    tmp_path: Path,
) -> None:
    value, _providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    _node, sidecar, artifact_root = _bind_memory_sidecar(value, tmp_path)
    adapter = cast(
        dict[str, object], cast(dict[str, object], value["memory"])["adapter"]
    )
    outside = tmp_path / "outside-sidecar.mjs"
    outside.write_text("// outside\n", encoding="utf-8")
    adapter["sidecarPath"] = str(outside.resolve())
    adapter["sidecarSha256"] = artifact_file_sha256(outside.resolve())
    _rescope(value)
    with pytest.raises(ProviderError, match="inside its artifact root"):
        validate_endpoint_request(value, cwd=root)

    adapter["sidecarPath"] = str(sidecar)
    adapter["sidecarSha256"] = artifact_file_sha256(sidecar)
    wrapper = tmp_path / "node.cmd"
    wrapper.write_text("@echo off\n", encoding="utf-8")
    adapter["nodeExecutable"] = str(wrapper.resolve())
    adapter["nodeSha256"] = artifact_file_sha256(wrapper.resolve())
    adapter["artifactRoot"] = str(artifact_root)
    _rescope(value)
    with pytest.raises(ProviderError, match="wrapper script"):
        validate_endpoint_request(value, cwd=root)


def test_managed_memory_rejects_a_sidecar_symlink_alias(tmp_path: Path) -> None:
    value, _providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    _node, sidecar, _artifact_root = _bind_memory_sidecar(value, tmp_path)
    alias = sidecar.with_name("sidecar-alias.mjs")
    try:
        alias.symlink_to(sidecar)
    except OSError:
        pytest.skip("This platform does not permit the fixture symlink.")
    adapter = cast(
        dict[str, object], cast(dict[str, object], value["memory"])["adapter"]
    )
    adapter["sidecarPath"] = str(alias.absolute())
    _rescope(value)

    with pytest.raises(ProviderError, match="must not traverse"):
        validate_endpoint_request(value, cwd=root)


def test_managed_memory_detects_post_start_artifact_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    _node, sidecar, _artifact_root = _bind_memory_sidecar(value, tmp_path)
    monkeypatch.setattr(
        QarinahSidecarAdapter,
        "version",
        lambda _self: QarinahSidecarVersion(
            name="@fikeya/qarinah-sidecar",
            protocol="fikeya.qarinah-sidecar.v1",
            version="0.1.0",
            qarinah_version="0.4.0",
        ),
    )
    request = validate_endpoint_request(value, cwd=root)

    payload = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda _workspace, _providers: _ArtifactMutatingRunner(
                sidecar
            ),
        ),
        monkeypatch,
    ).as_json()

    assert payload["status"] == "failed"
    assert payload["errorCode"] == "FIKEYA_MEMORY_ARTIFACT_CHANGED"
    assert cast(dict[str, object], payload["memory"]) == {
        "complete": False,
        "evidenceCount": None,
        "mode": "required",
        "receiptId": None,
        "responseSha256": None,
        "status": "unavailable",
    }


def test_unmatched_tool_request_never_becomes_a_complete_effect_chain(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(
        tmp_path,
        tools=["workspace.read_file"],
        max_tool_calls=1,
    )
    request = validate_endpoint_request(value, cwd=root)

    payload = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda workspace, _providers: _UnmatchedToolRunner(
                workspace.root
            ),
        ),
        monkeypatch,
    ).as_json()

    assert payload["status"] == "failed"
    assert payload["effects"] == {
        "complete": False,
        "measurement": "unavailable",
        "receiptSha256": None,
        "toolCallCount": None,
        "writeCount": None,
    }


def test_endpoint_rejects_scope_profile_model_and_chat_limit_mismatches(
    tmp_path: Path,
) -> None:
    value, providers, root = _fixture(tmp_path)
    cast(dict[str, object], value["authorization"])["scopeSha256"] = "sha256:" + (
        "0" * 64
    )
    with pytest.raises(ProviderError, match="scope"):
        validate_endpoint_request(value, cwd=root)

    value, providers, root = _fixture(tmp_path / "profile")
    request = validate_endpoint_request(value, cwd=root)
    cast(dict[str, object], value["provider"])["model"] = "wrong"
    _rescope(value)
    wrong_model = validate_endpoint_request(value, cwd=root)
    with pytest.raises(ProviderError, match="model"):
        _run(execute_endpoint_request(wrong_model, providers), pytest.MonkeyPatch())

    value, _providers, root = _fixture(tmp_path / "chat", tools=[], max_tool_calls=1)
    with pytest.raises(ProviderError, match="zero exactly"):
        validate_endpoint_request(value, cwd=root)
    assert request.provider.profile_name == "local"


def test_endpoint_executes_exact_scoped_tools_and_rejects_replay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(
        tmp_path, tools=["workspace.read_file"], max_tool_calls=1
    )
    request = validate_endpoint_request(value, cwd=root)
    runner = _FakeRunner(tools=("workspace.read_file",))
    result = _run(
        execute_endpoint_request(
            request, providers, runner_factory=lambda _workspace, _providers: runner
        ),
        monkeypatch,
    )
    payload = result.as_json()

    assert payload["schema"] == ENDPOINT_RESULT_SCHEMA
    assert payload["status"] == "succeeded"
    assert payload["errorCode"] is None
    assert payload["requestSha256"] == request.request_sha256
    unhashed = {key: item for key, item in payload.items() if key != "outcomeSha256"}
    assert payload["outcomeSha256"] == sha256_text(stable_json(unhashed))
    expected_receipts = [
        {
            "argumentsSha256": "sha256:" + ("a" * 64),
            "callId": "call-0",
            "outputSha256": sha256_text("bounded fake tool result"),
            "status": "ok",
            "tool": "workspace.read_file",
        }
    ]
    assert payload["effects"] == {
        "complete": True,
        "measurement": "local-receipt-chain",
        "receiptSha256": sha256_text(
            stable_json(
                {
                    "receipts": expected_receipts,
                    "schema": "maqam.endpoint-effect-chain.v1",
                }
            )
        ),
        "toolCallCount": 1,
        "writeCount": 0,
    }
    assert runner.decisions == [ApprovalDecision.ALLOW_ONCE]
    assert runner.kwargs["allowed_tools"] == frozenset({"workspace.read_file"})
    assert runner.kwargs["max_steps"] == 8
    assert runner.kwargs["max_output_tokens"] == 512
    assert runner.kwargs["memory_mode"] == "off"

    with pytest.raises(StateError, match="already been consumed"):
        _run(
            execute_endpoint_request(
                request,
                providers,
                runner_factory=lambda _workspace, _providers: _FakeRunner(),
            ),
            monkeypatch,
        )


def test_endpoint_accepts_aggregate_usage_above_the_per_call_output_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    value["allowNetwork"] = True
    _rescope(value)
    request = validate_endpoint_request(value, cwd=root)
    transport = _UsageTransport([400, 400, 400])
    result = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda workspace, store: CodingAgentRunner(
                workspace,
                store,
                executor=ProviderExecutor(transport),
                allowed_executables=frozenset(),
            ),
        ),
        monkeypatch,
    )
    payload = result.as_json()

    assert transport.calls == 3
    assert transport.requested_max_tokens == [512, 512, 512]
    assert payload["status"] == "succeeded"
    assert cast(dict[str, object], payload["usage"])["outputTokens"] == 1_200
    assert payload["effects"] == {
        "complete": True,
        "measurement": "local-receipt-chain",
        "receiptSha256": "sha256:29ca707cbd81c124eaa849d792efe7aa8c2e1c1a875b689c87d100c42fbc43dd",
        "toolCallCount": 0,
        "writeCount": 0,
    }


def test_managed_memory_uses_real_bound_sidecar_without_rebuilding_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    node_value = shutil.which("node")
    if node_value is None:
        pytest.skip("Node is unavailable for the cross-process sidecar fixture.")
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    project_file = root / "README.md"
    project_file.write_text("read-only project fixture\n", encoding="utf-8")
    artifact_root = tmp_path / "real-qarinah-artifact"
    artifact_root.mkdir()
    package_json = artifact_root / "package.json"
    package_json.write_text(
        stable_json(
            {
                "dependencies": {"qarinah": "0.4.0"},
                "name": "@fikeya/qarinah-sidecar",
                "version": "0.1.0-test",
            }
        ),
        encoding="utf-8",
    )
    sidecar = artifact_root / "qarinah-sidecar.mjs"
    sidecar.write_text(
        """
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input.trim());
if (request.method === "runtime.version") {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      name: "@fikeya/qarinah-sidecar",
      protocol: "fikeya.qarinah-sidecar.v1",
      qarinahVersion: "0.4.0",
      version: "0.1.0-test"
    }
  }) + "\\n");
  process.exit(0);
}
if (request.method !== "memory.prepare"
    || request.params.rebuild !== false
    || request.params.updateCheckpoint !== false) process.exit(19);
const maximum = request.params.maxChars;
const pack = {
  schemaVersion: "qarinah.context-pack.v2",
  workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  query: request.params.query,
  contentRole: "untrusted-data",
  budget: { maxChars: maximum, usedChars: maximum, estimatedTokens: Math.ceil(maximum / 4) },
  retrieval: {
    strategy: "hybrid-local-v1",
    supersessionPolicy: "prefer-current",
    asOf: "2026-08-29T00:00:00.000Z",
    coverage: {
      method: "query-term-overlap-v1",
      status: "none",
      queryTermCount: 1,
      bestExactTermCount: 0,
      bestExactTermRatio: 0,
      directCandidateCount: 0
    }
  },
  items: [],
  truncated: false,
  manifestHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
};
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: pack }) + "\\n");
""".strip()
        + "\n",
        encoding="utf-8",
    )
    node = Path(node_value).resolve()
    try:
        adapter = {
            "artifactRoot": str(artifact_root.resolve()),
            "artifactSha256": artifact_sha256(artifact_root.resolve()),
            "kind": "qarinah-node-sidecar",
            "nodeExecutable": str(node),
            "nodeSha256": artifact_file_sha256(node),
            "packageJsonPath": str(package_json.resolve()),
            "packageJsonSha256": artifact_file_sha256(package_json.resolve()),
            "sidecarPath": str(sidecar.resolve()),
            "sidecarSha256": artifact_file_sha256(sidecar.resolve()),
            "version": "0.1.0-test",
        }
    except (
        ConfigurationError
    ) as error:  # pragma: no cover - host packaging may share Node.
        pytest.skip(
            f"Host Node cannot satisfy private-file binding: {type(error).__name__}"
        )
    memory = cast(dict[str, object], value["memory"])
    memory.update({"adapter": adapter, "mode": "required", "rebuild": False})
    value["allowNetwork"] = True
    _rescope(value)
    before = project_file.read_bytes()
    request = validate_endpoint_request(value, cwd=root)
    transport = _UsageTransport([12, 12, 12])

    payload = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda workspace, store: CodingAgentRunner(
                workspace,
                store,
                executor=ProviderExecutor(transport),
                allowed_executables=frozenset(),
            ),
        ),
        monkeypatch,
    ).as_json()

    assert payload["status"] == "succeeded"
    assert cast(dict[str, object], payload["memory"])["status"] == "used"
    assert cast(dict[str, object], payload["memory"])["complete"] is True
    assert project_file.read_bytes() == before


def test_packaged_qarinah_sidecar_runs_required_memory_without_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prove the shipped package, not a protocol stub, through the endpoint."""

    node_value = shutil.which("node")
    source_root = (
        Path(__file__).resolve().parents[2] / "integrations" / "qarinah-sidecar"
    )
    package_output = tmp_path / "sidecar-package"
    package_output.mkdir()
    packager = (
        Path(__file__).resolve().parents[2]
        / "scripts"
        / "fikeya"
        / "package_qarinah_sidecar.py"
    )
    bundle = package_output / "fikeya-qarinah-sidecar-0.1.0-beta.8.zip"
    extracted = tmp_path / "sidecar-extracted"
    extracted.mkdir()
    if node_value is None or not (source_root / "node_modules" / "qarinah").is_dir():
        pytest.skip("Run npm ci in integrations/qarinah-sidecar for packaged proof.")
    subprocess.run(
        [
            sys.executable,
            str(packager),
            "--source",
            str(source_root),
            "--output-directory",
            str(package_output),
            "--release-version",
            "0.1.0-beta.8",
            "--skip-smoke",
        ],
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "TEMP": str(tmp_path),
            "TMP": str(tmp_path),
            "TMPDIR": str(tmp_path),
        },
        text=True,
        timeout=120,
    )
    with zipfile.ZipFile(bundle) as archive:
        archive.extractall(extracted)
    package_root = extracted / "qarinah-sidecar"
    sidecar = package_root / "src" / "sidecar.mjs"
    package_json = package_root / "package.json"

    node = Path(node_value).resolve()
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    source = root / "README.md"
    source.write_text("managed memory must remain read-only\n", encoding="utf-8")

    initialized = _sidecar_rpc(
        node, sidecar, root, "memory.initialize", {"capture": "content"}
    )
    policy = cast(dict[str, object], initialized["policy"])
    _sidecar_rpc(
        node,
        sidecar,
        root,
        "memory.approve",
        {"capture": "content", "policyHash": policy["policyHash"]},
    )
    _sidecar_rpc(
        node,
        sidecar,
        root,
        "memory.record",
        {
            "event": {
                "id": "managed-endpoint-package-proof",
                "occurredAt": "2026-08-29T00:00:00.000Z",
                "payload": {
                    "body": "Use the exact package-bound sidecar without rebuilding.",
                    "title": "Package-bound Qarinah",
                },
                "sessionId": "session-package-proof",
                "type": "decision.recorded",
            }
        },
    )
    _sidecar_rpc(
        node,
        sidecar,
        root,
        "memory.prepare",
        {
            "maxChars": 4_096,
            "maxTokens": 1_024,
            "query": "package-bound Qarinah",
            "rebuild": True,
            "updateCheckpoint": True,
        },
    )
    projection = root / ".qarinah" / "index" / "event-ids" / "manifest.json"
    assert projection.is_file()
    projection.unlink()
    before = _snapshot_without_fikeya_state(root)

    package = json.loads(package_json.read_text(encoding="utf-8"))
    memory = cast(dict[str, object], value["memory"])
    memory.update(
        {
            "adapter": {
                "artifactRoot": str(package_root),
                "artifactSha256": artifact_sha256(package_root),
                "kind": "qarinah-node-sidecar",
                "nodeExecutable": str(node),
                "nodeSha256": artifact_file_sha256(node),
                "packageJsonPath": str(package_json),
                "packageJsonSha256": artifact_file_sha256(package_json),
                "sidecarPath": str(sidecar),
                "sidecarSha256": artifact_file_sha256(sidecar),
                "version": package["version"],
            },
            "mode": "required",
            "rebuild": False,
        }
    )
    value["allowNetwork"] = True
    value["prompt"] = "Explain the package-bound Qarinah decision."
    _rescope(value)
    request = validate_endpoint_request(value, cwd=root)
    transport = _UsageTransport([12, 12, 12])

    payload = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda workspace, store: CodingAgentRunner(
                workspace,
                store,
                executor=ProviderExecutor(transport),
                allowed_executables=frozenset(),
            ),
        ),
        monkeypatch,
    ).as_json()

    assert payload["status"] == "succeeded"
    assert cast(dict[str, object], payload["memory"])["status"] == "used"
    assert _snapshot_without_fikeya_state(root) == before
    assert not projection.exists()


def test_failed_write_receipt_does_not_increment_confirmed_write_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(
        tmp_path,
        access="write",
        tools=["workspace.write_file"],
        max_tool_calls=1,
    )
    request = validate_endpoint_request(value, cwd=root)
    result = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda _workspace, _providers: _FakeRunner(
                tools=("workspace.write_file",),
                tool_status="error",
            ),
        ),
        monkeypatch,
    ).as_json()

    assert result["status"] == "succeeded"
    expected_receipts = [
        {
            "argumentsSha256": "sha256:" + ("a" * 64),
            "callId": "call-0",
            "outputSha256": sha256_text("bounded fake tool result"),
            "status": "error",
            "tool": "workspace.write_file",
        }
    ]
    assert result["effects"] == {
        "complete": True,
        "measurement": "local-receipt-chain",
        "receiptSha256": sha256_text(
            stable_json(
                {
                    "receipts": expected_receipts,
                    "schema": "maqam.endpoint-effect-chain.v1",
                }
            )
        ),
        "toolCallCount": 1,
        "writeCount": 0,
    }


def test_endpoint_settles_a_provider_call_that_reports_over_its_output_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    value["allowNetwork"] = True
    _rescope(value)
    request = validate_endpoint_request(value, cwd=root)
    transport = _UsageTransport([513])
    result = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda workspace, store: CodingAgentRunner(
                workspace,
                store,
                executor=ProviderExecutor(transport),
                allowed_executables=frozenset(),
            ),
        ),
        monkeypatch,
    )
    payload = result.as_json()

    assert transport.calls == 1
    assert transport.requested_max_tokens == [512]
    assert payload["status"] == "failed"
    assert payload["errorCode"] == "FIKEYA_LIMIT_EXCEEDED"
    assert cast(dict[str, object], payload["usage"]) == {
        "cachedInputTokens": 4,
        "complete": True,
        "costMicros": None,
        "currency": None,
        "inputTokens": 20,
        "measurement": "provider-reported",
        "outputTokens": 513,
        "reasoningTokens": None,
    }


def test_endpoint_timeout_settles_on_python_310(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    cast(dict[str, object], value["limits"])["timeoutMs"] = 1
    _rescope(value)
    request = validate_endpoint_request(value, cwd=root)
    result = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda _workspace, _providers: _FakeRunner(delay=0.1),
        ),
        monkeypatch,
    )
    payload = result.as_json()

    assert payload["status"] == "cancelled"
    assert payload["errorCode"] == "FIKEYA_TIMEOUT"
    assert cast(dict[str, object], payload["usage"])["measurement"] == "unavailable"


def test_slow_managed_memory_is_killed_and_settled_at_the_run_deadline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    node_value = shutil.which("node")
    if node_value is None:
        pytest.skip("Node is required for the managed-memory process-tree test.")
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    _node, sidecar, artifact_root = _bind_memory_sidecar(value, tmp_path)
    sentinel = tmp_path / "sidecar-child-survived.txt"
    child = artifact_root / "slow-child.mjs"
    child.write_text(
        "import {writeFileSync} from 'node:fs';\n"
        f"setTimeout(() => writeFileSync({json.dumps(str(sentinel))}, 'survived'), 900);\n"
        "setTimeout(() => {}, 5000);\n",
        encoding="utf-8",
    )
    sidecar.write_text(
        "import {spawn} from 'node:child_process';\n"
        "let input = '';\n"
        "for await (const chunk of process.stdin) input += chunk;\n"
        "const request = JSON.parse(input.trim());\n"
        "if (request.method === 'runtime.version') {\n"
        "  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{"
        "name:'@fikeya/qarinah-sidecar',protocol:'fikeya.qarinah-sidecar.v1',"
        "qarinahVersion:'0.4.0',version:'0.1.0'}}));\n"
        "} else {\n"
        f"  spawn(process.execPath, [{json.dumps(str(child.resolve()))}], {{stdio:'ignore'}});\n"
        "  setInterval(() => {}, 10000);\n"
        "}\n",
        encoding="utf-8",
    )
    adapter = cast(
        dict[str, object], cast(dict[str, object], value["memory"])["adapter"]
    )
    node = Path(node_value).resolve(strict=True)
    adapter["nodeExecutable"] = str(node)
    adapter["nodeSha256"] = artifact_file_sha256(node)
    adapter["sidecarSha256"] = artifact_file_sha256(sidecar)
    adapter["artifactSha256"] = artifact_sha256(artifact_root)
    cast(dict[str, object], value["limits"])["timeoutMs"] = 250
    _rescope(value)
    request = validate_endpoint_request(value, cwd=root)

    started = time.monotonic()
    payload = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda workspace, store: CodingAgentRunner(
                workspace, store, allowed_executables=frozenset()
            ),
        ),
        monkeypatch,
    ).as_json()
    elapsed = time.monotonic() - started

    assert elapsed < 3
    assert payload["status"] == "cancelled"
    assert payload["errorCode"] == "FIKEYA_TIMEOUT"
    assert cast(dict[str, object], payload["usage"])["measurement"] == "unavailable"
    time.sleep(1.1)
    assert not sentinel.exists(), "the timed-out sidecar child was not terminated"


def test_expiry_during_sidecar_preflight_never_consumes_or_starts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expires_at = datetime(2030, 1, 1, tzinfo=timezone.utc)
    clock = _MutableClock(expires_at - timedelta(milliseconds=1))
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    _bind_memory_sidecar(value, tmp_path)
    cast(dict[str, object], value["authorization"])["expiresAt"] = expires_at.isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    _rescope(value)
    request = validate_endpoint_request(value, cwd=root, clock=clock)
    runner_started = False

    def version(_adapter: QarinahSidecarAdapter) -> QarinahSidecarVersion:
        clock.current = expires_at
        return QarinahSidecarVersion(
            name="@fikeya/qarinah-sidecar",
            protocol="fikeya.qarinah-sidecar.v1",
            version="0.1.0",
            qarinah_version="0.4.0",
        )

    def factory(_workspace: object, _providers: object) -> _FakeRunner:
        nonlocal runner_started
        runner_started = True
        return _FakeRunner()

    monkeypatch.setattr(QarinahSidecarAdapter, "version", version)
    with pytest.raises(EndpointAuthorizationExpiredError, match="expired"):
        _run(
            execute_endpoint_request(
                request, providers, runner_factory=factory, clock=clock
            ),
            monkeypatch,
        )

    assert runner_started is False
    with sqlite3.connect(root / ".fikeya" / "state.sqlite3") as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM endpoint_authorizations"
        ).fetchone() == (0,)


def test_no_tool_run_cannot_succeed_after_authorization_expires(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expires_at = datetime(2030, 1, 1, tzinfo=timezone.utc)
    starts_at = expires_at - timedelta(seconds=1)
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    cast(dict[str, object], value["authorization"])["expiresAt"] = expires_at.isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    request = validate_endpoint_request(value, cwd=root, clock=lambda: starts_at)
    clock = _MutableClock(starts_at)
    runner = _ClockAdvancingRunner(clock, expires_at + timedelta(microseconds=1))
    result = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda _workspace, _providers: runner,
            clock=clock,
        ),
        monkeypatch,
    )
    payload = result.as_json()

    assert runner.kwargs["allowed_tools"] == frozenset()
    assert payload["requestSha256"] == request.request_sha256
    assert payload["status"] == "failed"
    assert payload["errorCode"] == "FIKEYA_AUTHORIZATION_EXPIRED"
    assert (
        cast(dict[str, object], payload["usage"])["measurement"] == "provider-reported"
    )
    assert cast(dict[str, object], payload["effects"])["receiptSha256"] == (
        "sha256:29ca707cbd81c124eaa849d792efe7aa8c2e1c1a875b689c87d100c42fbc43dd"
    )


@pytest.mark.parametrize(
    ("finish_at_expiry", "expected_status", "expected_error"),
    [
        (False, "succeeded", None),
        (True, "failed", "FIKEYA_AUTHORIZATION_EXPIRED"),
    ],
)
def test_authorization_expiry_boundary_is_exclusive_for_final_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    finish_at_expiry: bool,
    expected_status: str,
    expected_error: str | None,
) -> None:
    expires_at = datetime(2030, 1, 1, tzinfo=timezone.utc)
    starts_at = expires_at - timedelta(seconds=1)
    finish_at = (
        expires_at if finish_at_expiry else expires_at - timedelta(microseconds=1)
    )
    value, providers, root = _fixture(tmp_path, tools=[], max_tool_calls=0)
    cast(dict[str, object], value["authorization"])["expiresAt"] = expires_at.isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    request = validate_endpoint_request(value, cwd=root, clock=lambda: starts_at)
    clock = _MutableClock(starts_at)
    result = _run(
        execute_endpoint_request(
            request,
            providers,
            runner_factory=lambda _workspace, _providers: _ClockAdvancingRunner(
                clock, finish_at
            ),
            clock=clock,
        ),
        monkeypatch,
    ).as_json()

    assert result["status"] == expected_status
    assert result["errorCode"] == expected_error


@pytest.mark.parametrize(
    ("runner", "status", "error_code", "measurement"),
    [
        (
            _FakeRunner(tools=("process.run",)),
            "failed",
            "FIKEYA_CAPABILITY_DENIED",
            "provider-reported",
        ),
        (
            _FakeRunner(fail=True),
            "failed",
            "FIKEYA_RUNTIME_FAILED",
            "unavailable",
        ),
        (
            _FakeRunner(usage={"measurement": "unavailable"}),
            "failed",
            "FIKEYA_USAGE_INVALID",
            "unavailable",
        ),
        (
            _FakeRunner(usage={"measurement": "estimated"}),
            "failed",
            "FIKEYA_USAGE_INVALID",
            "unavailable",
        ),
    ],
)
def test_endpoint_settles_post_start_failures_without_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    runner: _FakeRunner,
    status: str,
    error_code: str | None,
    measurement: str,
) -> None:
    value, providers, root = _fixture(
        tmp_path,
        tools=["workspace.read_file"],
        max_tool_calls=1,
    )
    request = validate_endpoint_request(value, cwd=root)
    result = _run(
        execute_endpoint_request(
            request, providers, runner_factory=lambda _workspace, _providers: runner
        ),
        monkeypatch,
    )
    payload = result.as_json()
    assert payload["status"] == status
    assert payload["errorCode"] == error_code
    assert cast(dict[str, object], payload["usage"])["measurement"] == measurement
    assert "private failure" not in stable_json(payload)
    assert set(payload) == {
        "errorCode",
        "effects",
        "memory",
        "model",
        "outcomeSha256",
        "provider",
        "requestSha256",
        "schema",
        "sessionId",
        "status",
        "usage",
    }


def test_broker_filters_tools_and_preserves_an_explicit_empty_executable_set(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    broker = WorkspaceExecutionBroker(
        workspace,
        mode=AgentMode.BUILD,
        allowed_executables=frozenset(),
        allowed_tools=frozenset({"workspace.read_file"}),
    )
    tools = _run(broker.list_tools(CancellationToken()), monkeypatch)
    try:
        assert [tool.name for tool in tools] == ["workspace.read_file"]
        assert broker._process_broker.allowed_executables == set()
    finally:
        broker.close()
