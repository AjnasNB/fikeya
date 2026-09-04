# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

from fikeya_runtime.errors import ToolPresetError
from fikeya_runtime.mcp_stdio import (
    McpProtocolError,
    McpStdioHost,
    McpTextContent,
)
from fikeya_runtime.tool_presets import (
    PresetCatalog,
    ToolEnablementStore,
    ToolPresetLoader,
)
from fikeya_runtime.workspace import initialize_workspace

_PRESET_ID = "cockroach-browser"
_SECRET = "test-browser-credential-that-must-never-be-disclosed"
_TOOLS = [
    "browser_capabilities",
    "browser_engines",
    "browser_engine_preflight",
    "browser_health",
    "browser_sessions",
    "browser_snapshot",
    "browser_capture",
    "browser_network",
    "browser_audit",
    "browser_propose_action",
]


def test_real_stdio_child_initializes_lists_and_calls_with_typed_results(
    tmp_path: Path,
) -> None:
    workspace, loader, preset = _workspace_and_loader(tmp_path)
    _write_fake_server(workspace.root / "mcp", mode="normal", noisy_stderr=True)

    with McpStdioHost.connect(
        loader,
        workspace,
        preset.preset_id,
        expected_preset_digest=preset.digest,
        secret_resolver=lambda _name: _SECRET,
        executable_resolver=lambda _command: sys.executable,
        stderr_capture_bytes=4_096,
    ) as host:
        assert host.server_identity is not None
        assert host.server_identity.name == "cockroach-browser"
        assert host.server_identity.version == "0.5.0-rc.1"
        assert [tool.name for tool in host.list_tools()] == _TOOLS
        result = host.call_tool("browser_capabilities", {"message": "bounded test"})
        assert result.is_error is False
        assert result.structured_content == {
            "echo": "bounded test",
            "workspace": str(workspace.root),
        }
        assert result.content == (McpTextContent("bounded test"),)
        assert _SECRET not in host.stderr_text
        assert "[redacted]" in host.stderr_text
        assert "[stderr truncated]" in host.stderr_text
        process = host.process

    assert process.poll() is not None


@pytest.mark.parametrize(
    ("version", "accepted"),
    [
        ("0.5.0-rc.1", True),
        ("0.5.0-rc.2", True),
        ("0.5.0-rc.1+fikeya.1", True),
        ("0.5.0", True),
        ("0.5.9", True),
        ("0.4.1", False),
        ("0.5.0-beta.99", False),
        ("0.5.0-rc.0", False),
        ("0.5.0-rc.01", False),
        ("0.5.1-alpha.1", False),
        ("0.6.0-rc.1", False),
        ("0.6.0", False),
        (f"0.5.0-{'x' * 33}", False),
        ("0.5.0-" + ".".join(["x"] * 17), False),
        ("1000000000.5.0", False),
        (f"0.5.0-rc.1+{'x' * 129}", False),
    ],
)
def test_server_identity_enforces_reviewed_prerelease_range(
    tmp_path: Path, version: str, accepted: bool
) -> None:
    workspace, loader, preset = _workspace_and_loader(tmp_path)
    _write_fake_server(workspace.root / "mcp", mode="normal", version=version)

    def connect() -> McpStdioHost:
        return McpStdioHost.connect(
            loader,
            workspace,
            preset.preset_id,
            expected_preset_digest=preset.digest,
            secret_resolver=lambda _name: _SECRET,
            executable_resolver=lambda _command: sys.executable,
        )

    if accepted:
        with connect() as host:
            assert host.server_identity is not None
            assert host.server_identity.version == version
    else:
        with pytest.raises(McpProtocolError, match="outside the reviewed preset range"):
            connect()


def test_digest_mismatch_is_rejected_before_spawn(tmp_path: Path) -> None:
    workspace, loader, preset = _workspace_and_loader(tmp_path)
    _write_fake_server(workspace.root / "mcp", mode="normal")

    with pytest.raises(ToolPresetError, match="digest changed"):
        McpStdioHost.connect(
            loader,
            workspace,
            preset.preset_id,
            expected_preset_digest=f"sha256:{'0' * 64}",
            secret_resolver=lambda _name: _SECRET,
            executable_resolver=lambda _command: sys.executable,
        )


@pytest.mark.parametrize(
    ("mode", "message"),
    [
        ("wrong-id", "unmatched response id"),
        ("wrong-version", "outside the reviewed preset range"),
        ("extra-tool", "outside the reviewed preset"),
    ],
)
def test_untrusted_peer_identity_and_tool_contract_are_rejected(
    tmp_path: Path, mode: str, message: str
) -> None:
    workspace, loader, preset = _workspace_and_loader(tmp_path)
    _write_fake_server(workspace.root / "mcp", mode=mode)

    if mode == "extra-tool":
        host = McpStdioHost.connect(
            loader,
            workspace,
            preset.preset_id,
            expected_preset_digest=preset.digest,
            secret_resolver=lambda _name: _SECRET,
            executable_resolver=lambda _command: sys.executable,
        )
        with host, pytest.raises(McpProtocolError, match=message):
            host.list_tools()
    else:
        with pytest.raises(McpProtocolError, match=message):
            McpStdioHost.connect(
                loader,
                workspace,
                preset.preset_id,
                expected_preset_digest=preset.digest,
                secret_resolver=lambda _name: _SECRET,
                executable_resolver=lambda _command: sys.executable,
            )


def test_oversized_response_kills_the_real_child(tmp_path: Path) -> None:
    workspace, loader, preset = _workspace_and_loader(
        tmp_path, max_response_bytes=1_024
    )
    _write_fake_server(workspace.root / "mcp", mode="oversize")
    host = McpStdioHost.connect(
        loader,
        workspace,
        preset.preset_id,
        expected_preset_digest=preset.digest,
        secret_resolver=lambda _name: _SECRET,
        executable_resolver=lambda _command: sys.executable,
    )
    with host, pytest.raises(McpProtocolError, match="response-byte limit"):
        host.call_tool("browser_capabilities", {"message": "oversize"})
    host.process.wait(timeout=2)
    assert host.process.poll() is not None


def test_request_timeout_kills_the_real_child(tmp_path: Path) -> None:
    workspace, loader, preset = _workspace_and_loader(tmp_path, request_timeout_ms=500)
    _write_fake_server(workspace.root / "mcp", mode="timeout")
    host = McpStdioHost.connect(
        loader,
        workspace,
        preset.preset_id,
        expected_preset_digest=preset.digest,
        secret_resolver=lambda _name: _SECRET,
        executable_resolver=lambda _command: sys.executable,
    )
    with host, pytest.raises(McpProtocolError, match="timed out"):
        host.call_tool("browser_capabilities", {"message": "wait"})
    host.process.wait(timeout=2)
    assert host.process.poll() is not None


def test_close_kills_every_descendant_of_the_real_mcp_child(tmp_path: Path) -> None:
    workspace, loader, preset = _workspace_and_loader(tmp_path)
    _write_fake_server(workspace.root / "mcp", mode="descendant")
    marker = workspace.root / "descendant-survived.txt"
    host = McpStdioHost.connect(
        loader,
        workspace,
        preset.preset_id,
        expected_preset_digest=preset.digest,
        secret_resolver=lambda _name: _SECRET,
        executable_resolver=lambda _command: sys.executable,
    )

    assert host.process_tree.contained is True
    host.close()
    time.sleep(1.7)

    assert host.process.poll() is not None
    assert not marker.exists()


def test_tool_arguments_follow_the_discovered_object_schema(tmp_path: Path) -> None:
    workspace, loader, preset = _workspace_and_loader(tmp_path)
    _write_fake_server(workspace.root / "mcp", mode="normal")
    with McpStdioHost.connect(
        loader,
        workspace,
        preset.preset_id,
        expected_preset_digest=preset.digest,
        secret_resolver=lambda _name: _SECRET,
        executable_resolver=lambda _command: sys.executable,
    ) as host:
        with pytest.raises(ToolPresetError, match="missing required"):
            host.call_tool("browser_capabilities", {})
        with pytest.raises(ToolPresetError, match="unknown fields"):
            host.call_tool("browser_capabilities", {"message": "ok", "surprise": True})


def _workspace_and_loader(
    tmp_path: Path,
    *,
    max_response_bytes: int | None = None,
    request_timeout_ms: int | None = None,
) -> tuple[object, ToolPresetLoader, object]:
    root = tmp_path / "project"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    if max_response_bytes is None and request_timeout_ms is None:
        catalog = PresetCatalog()
    else:
        catalog_path = tmp_path / "catalog"
        catalog_path.mkdir()
        document = _bundled_document()
        limits = document["limits"]
        assert isinstance(limits, dict)
        if max_response_bytes is not None:
            limits["maxResponseBytes"] = max_response_bytes
        if request_timeout_ms is not None:
            limits["requestTimeoutMs"] = request_timeout_ms
        (catalog_path / "cockroach-browser.preset.json").write_text(
            json.dumps(document), encoding="utf-8"
        )
        catalog = PresetCatalog(catalog_path)
    loader = ToolPresetLoader(catalog)
    preset = catalog.get(_PRESET_ID)
    ToolEnablementStore(workspace).enable(preset, confirmed=True)
    return workspace, loader, preset


def _bundled_document() -> dict[str, object]:
    repository = Path(__file__).resolve().parents[2]
    path = (
        repository
        / "fikeya-runtime"
        / "src"
        / "fikeya_runtime"
        / "presets"
        / "cockroach-browser.preset.json"
    )
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _write_fake_server(
    path: Path,
    *,
    mode: str,
    noisy_stderr: bool = False,
    version: str = "0.5.0-rc.1",
) -> None:
    source = f"""# deterministic fake MCP child
import json
import os
from pathlib import Path
import subprocess
import sys
import time

MODE = {mode!r}
TOOLS = {json.dumps(_TOOLS)}
VERSION = {version!r}

if {noisy_stderr!r}:
    sys.stderr.write(os.environ.get("COCKROACH_BROWSER_TOKEN", "") + "x" * 10000)
    sys.stderr.flush()

if MODE == "descendant":
    child = (
        "import time; from pathlib import Path; time.sleep(1.5); "
        "Path('descendant-survived.txt').write_text('unsafe', encoding='utf-8')"
    )
    subprocess.Popen([sys.executable, "-c", child])

def send(request_id, result):
    if MODE == "wrong-id":
        request_id += 1
    sys.stdout.write(json.dumps({{"jsonrpc": "2.0", "id": request_id, "result": result}}, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        version = "0.4.1" if MODE == "wrong-version" else VERSION
        send(request["id"], {{
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {{"tools": {{"listChanged": False}}}},
            "serverInfo": {{"name": "cockroach-browser", "version": version}}
        }})
    elif method == "tools/list":
        names = TOOLS + (["unreviewed_tool"] if MODE == "extra-tool" else [])
        send(request["id"], {{"tools": [{{
            "name": name,
            "description": "Deterministic test tool",
            "inputSchema": {{
                "type": "object",
                "properties": {{"message": {{"type": "string"}}}},
                "required": ["message"],
                "additionalProperties": False
            }}
        }} for name in names]}})
    elif method == "tools/call":
        if MODE == "timeout":
            time.sleep(2)
        if MODE == "oversize":
            send(request["id"], {{"content": [{{"type": "text", "text": "x" * 4096}}]}})
            continue
        message = request["params"]["arguments"]["message"]
        send(request["id"], {{
            "content": [{{"type": "text", "text": message}}],
            "isError": False,
            "structuredContent": {{"echo": message, "workspace": os.getcwd()}}
        }})
"""
    path.write_text(source, encoding="utf-8")
