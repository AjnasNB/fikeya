# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import asyncio
import io
import json
import socket
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from uuid import uuid4

import pytest
from fikeya_agent_core import ApprovalDecision, CancellationToken

from fikeya_runtime.cli import main
from fikeya_runtime.coding import WorkspaceExecutionBroker
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
from fikeya_runtime.errors import ProviderError, StateError, WorkspaceError
from fikeya_runtime.modes import AgentMode
from fikeya_runtime.providers import ProviderKind, ProviderStore, build_profile
from fikeya_runtime.util import sha256_text, stable_json
from fikeya_runtime.workspace import initialize_workspace

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect
_READ_TOOLS = [
    "workspace.list_files",
    "workspace.read_file",
    "workspace.search_text",
]


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
            receipts.append(SimpleNamespace(name=tool_name))
        return SimpleNamespace(
            session_id=kwargs["session_id"],
            status=self.status,
            steps=self.steps,
            usage=self.usage,
            tool_calls=tuple(receipts),
        )


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
        "memory": {"contextMaxCharacters": 4_096, "mode": "off"},
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


def test_endpoint_version_probe_is_exact_and_v1_is_rejected(capsys: object) -> None:
    assert main(["endpoint", "version", "--protocol", ENDPOINT_PROTOCOL, "--json"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert set(output) == {"name", "schema", "version"}
    assert output["name"] == "fikeya"
    assert output["schema"] == "maqam.endpoint-runtime.v1"

    assert main(
        ["endpoint", "version", "--protocol", "maqam.endpoint-harness.v1", "--json"]
    ) == 2
    failure = json.loads(capsys.readouterr().out)
    assert failure == {
        "error": "The requested Fikeya endpoint protocol is unsupported.",
        "ok": False,
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
    with pytest.raises(ProviderError, match="must be maqam.endpoint-harness-request.v2"):
        validate_endpoint_request(downgrade, cwd=root)


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


@pytest.mark.parametrize(
    ("mutation", "error_type", "message"),
    [
        (lambda value: value.update({"workingDirectory": "."}), WorkspaceError, "absolute"),
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


def test_endpoint_rejects_scope_profile_model_and_chat_limit_mismatches(
    tmp_path: Path,
) -> None:
    value, providers, root = _fixture(tmp_path)
    cast(dict[str, object], value["authorization"])["scopeSha256"] = "sha256:" + ("0" * 64)
    with pytest.raises(ProviderError, match="scope"):
        validate_endpoint_request(value, cwd=root)

    value, providers, root = _fixture(tmp_path / "profile")
    request = validate_endpoint_request(value, cwd=root)
    cast(dict[str, object], value["provider"])["model"] = "wrong"
    _rescope(value)
    wrong_model = validate_endpoint_request(value, cwd=root)
    with pytest.raises(ProviderError, match="model"):
        _run(execute_endpoint_request(wrong_model, providers), pytest.MonkeyPatch())

    value, _providers, root = _fixture(
        tmp_path / "chat", tools=[], max_tool_calls=1
    )
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
