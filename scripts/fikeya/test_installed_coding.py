# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Exercise an installed Fikeya CLI against a deterministic local provider.

The fixture opens a new project, initializes its local workspace, performs an
approval-gated edit, executes a focused test, and verifies content-free usage
statistics. It never contacts an external model provider or reads credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fikeya",
        type=Path,
        help="Path to the installed Fikeya console entry point (defaults to PATH).",
    )
    arguments = parser.parse_args()
    if arguments.fikeya is None:
        installed = shutil.which("fikeya")
        if installed is None:
            parser.error("fikeya was not found on PATH; pass --fikeya explicitly")
        arguments.fikeya = Path(installed)
    return arguments


def _run_json(command: list[str], *, environment: dict[str, str]) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        encoding="utf-8",
        env=environment,
        errors="strict",
        timeout=120,
    )
    value = json.loads(completed.stdout)
    if not isinstance(value, dict) or value.get("ok") is not True:
        raise RuntimeError(f"Fikeya command returned an invalid receipt: {value!r}")
    return value


class _ProviderServer(ThreadingHTTPServer):
    decisions: list[dict[str, object]]
    request_count: int


class _ProviderHandler(BaseHTTPRequestHandler):
    server: _ProviderServer

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        if not isinstance(request, dict) or request.get("model") != "fikeya-e2e":
            self.send_error(400)
            return
        try:
            decision = self.server.decisions[self.server.request_count]
        except IndexError:
            self.send_error(409)
            return
        self.server.request_count += 1
        payload = json.dumps(
            {
                "choices": [{"message": {"content": json.dumps(decision)}}],
                "usage": {
                    "completion_tokens": 5,
                    "prompt_tokens": 20,
                    "prompt_tokens_details": {"cached_tokens": 4},
                },
            },
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *arguments: object) -> None:
        del format, arguments


def main() -> int:
    arguments = _arguments()
    fikeya = arguments.fikeya.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="fikeya-installed-e2e-") as temporary:
        root = Path(temporary)
        workspace = root / "project"
        runtime_home = root / "home"
        workspace.mkdir()
        source = workspace / "answer.py"
        source.write_text("VALUE = 1\n", encoding="utf-8")
        expected = hashlib.sha256(source.read_bytes()).hexdigest()
        environment = {**os.environ, "FIKEYA_HOME": str(runtime_home)}

        decisions: list[dict[str, object]] = [
            {"kind": "plan", "content": "Inspect, update, and verify answer.py."},
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {"path": "answer.py"},
                    "callId": "read:answer",
                    "name": "workspace.read_file",
                },
            },
            {
                "kind": "review",
                "reviewAction": "continue",
                "content": "The inspected hash permits the requested edit.",
            },
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {
                        "expectedSha256": expected,
                        "newText": "VALUE = 2",
                        "oldText": "VALUE = 1",
                        "path": "answer.py",
                    },
                    "callId": "edit:answer",
                    "name": "workspace.replace_text",
                },
            },
            {
                "kind": "review",
                "reviewAction": "continue",
                "content": "Run a focused verification.",
            },
            {
                "kind": "tool_call",
                "toolCall": {
                    "arguments": {
                        "arguments": [
                            "-c",
                            "from pathlib import Path; assert Path('answer.py').read_text() == 'VALUE = 2\\n'",
                        ],
                        "cwd": ".",
                        "executable": "python",
                        "timeoutSeconds": 15,
                    },
                    "callId": "test:answer",
                    "name": "process.run",
                },
            },
            {
                "kind": "review",
                "reviewAction": "complete",
                "content": "Updated answer.py and the focused verification passed.",
            },
        ]
        server = _ProviderServer(("127.0.0.1", 0), _ProviderHandler)
        server.decisions = decisions
        server.request_count = 0
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            _run_json([str(fikeya), "init", str(workspace), "--json"], environment=environment)
            port = server.server_address[1]
            _run_json(
                [
                    str(fikeya),
                    "provider",
                    "configure",
                    "installed-e2e",
                    "--kind",
                    "openai-compatible",
                    "--base-url",
                    f"http://127.0.0.1:{port}/v1",
                    "--model",
                    "fikeya-e2e",
                    "--credential-type",
                    "none",
                    "--api-mode",
                    "chat-completions",
                    "--json",
                ],
                environment=environment,
            )
            process = subprocess.Popen(
                [
                    str(fikeya),
                    "agent",
                    "execute",
                    str(workspace),
                    "--provider",
                    "installed-e2e",
                    "--protocol-stdin",
                    "--allow-network",
                    "--memory",
                    "off",
                    "--json-lines",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                encoding="utf-8",
                env=environment,
                errors="strict",
            )
            assert process.stdin is not None
            assert process.stdout is not None
            process.stdin.write(
                json.dumps(
                    {"type": "start", "prompt": "Change VALUE to 2 and verify it."},
                    separators=(",", ":"),
                )
                + "\n"
            )
            process.stdin.flush()
            result: dict[str, Any] | None = None
            approvals: list[str] = []
            for line in process.stdout:
                message = json.loads(line)
                if message.get("type") == "approval" and "toolName" in message:
                    request_id = message.get("requestId")
                    tool_name = message.get("toolName")
                    if not isinstance(request_id, str) or not isinstance(tool_name, str):
                        raise RuntimeError(f"Malformed approval request: {message!r}")
                    approvals.append(tool_name)
                    process.stdin.write(
                        json.dumps(
                            {
                                "decision": "allow_once",
                                "requestId": request_id,
                                "type": "approval",
                            },
                            separators=(",", ":"),
                        )
                        + "\n"
                    )
                    process.stdin.flush()
                elif message.get("type") == "result":
                    result = message
                    break
            process.stdin.close()
            stderr = process.stderr.read() if process.stderr is not None else ""
            return_code = process.wait(timeout=120)
            if return_code != 0 or result is None:
                raise RuntimeError(
                    f"Installed coding run failed ({return_code}): {stderr.strip()}"
                )
            if result.get("status") != "completed":
                raise RuntimeError(f"Installed coding run did not complete: {result!r}")
            if source.read_text(encoding="utf-8") != "VALUE = 2\n":
                raise RuntimeError("Installed coding run did not update the project file.")
            if approvals != [
                "workspace.read_file",
                "workspace.replace_text",
                "process.run",
            ]:
                raise RuntimeError(f"Unexpected approval sequence: {approvals!r}")
            statistics = _run_json(
                [str(fikeya), "stats", "--workspace", str(workspace), "--json"],
                environment=environment,
            )
            tests = result.get("outcome", {}).get("tests")
            if (
                not isinstance(tests, list)
                or len(tests) != 1
                or not isinstance(tests[0], dict)
                or not _canonical_sha256(tests[0].get("outputSha256"))
            ):
                raise RuntimeError(f"Invalid test evidence receipt: {tests!r}")
            report = {
                "schemaVersion": "fikeya.installed-coding-smoke.v1",
                "approvals": approvals,
                "changedFile": "answer.py",
                "output": result.get("output"),
                "providerCalls": statistics.get("providerCalls"),
                "providerRequests": server.request_count,
                "sessionStatus": result.get("status"),
                "tests": tests,
                "tokenMeasurement": statistics.get("measurement"),
                "tokens": {
                    "cachedInput": statistics.get("cachedInputTokens"),
                    "input": statistics.get("inputTokens"),
                    "output": statistics.get("outputTokens"),
                },
            }
            print(json.dumps(report, indent=2, sort_keys=True))
            return 0
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def _canonical_sha256(value: object) -> bool:
    if not isinstance(value, str) or not value.startswith("sha256:"):
        return False
    digest = value.removeprefix("sha256:")
    return len(digest) == 64 and all(character in "0123456789abcdef" for character in digest)


if __name__ == "__main__":
    raise SystemExit(main())
