#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Run Fikeya's deterministic, no-model plan-to-proof evaluation fixture."""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPOSITORY_ROOT = HERE.parents[1]
FIXTURE_ROOT = HERE / "fixtures" / "seed"
SIDECAR_ROOT = REPOSITORY_ROOT / "integrations" / "qarinah-sidecar"
SIDECAR_PATH = SIDECAR_ROOT / "src" / "sidecar.mjs"
EVALUATED_IMPLEMENTATION_PATHS = (
    REPOSITORY_ROOT / "fikeya-runtime" / "src" / "fikeya_runtime" / "coding.py",
    REPOSITORY_ROOT / "fikeya-runtime" / "src" / "fikeya_runtime" / "plans.py",
    REPOSITORY_ROOT / "fikeya-runtime" / "src" / "fikeya_runtime" / "qarinah.py",
    REPOSITORY_ROOT / "fikeya-runtime" / "src" / "fikeya_runtime" / "state.py",
    SIDECAR_ROOT / "src" / "memory-port.mjs",
    SIDECAR_PATH,
)

sys.path.insert(0, str(REPOSITORY_ROOT / "fikeya-agent-core" / "src"))
sys.path.insert(0, str(REPOSITORY_ROOT / "fikeya-runtime" / "src"))

from fikeya_runtime.plans import PlanService, PlanStatus  # noqa: E402
from fikeya_runtime.qarinah import QarinahSidecarAdapter  # noqa: E402
from fikeya_runtime.state import StateStore  # noqa: E402
from fikeya_runtime.workspace import initialize_workspace  # noqa: E402

SCHEMA_VERSION = "fikeya.plan-proof-evaluation.v1"
CONTEXT_MAX_CHARACTERS = 8_000
DECISION_BODY = (
    "Normalize SKU values by trimming whitespace and uppercasing them. "
    "Quantity must be a positive integer in both the Python service and "
    "JavaScript client."
)
TASK_QUERY = DECISION_BODY

PYTHON_FINAL = '''# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Canonical order-line normalization for the Python service."""


def normalize_line(sku: str, quantity: int) -> dict[str, object]:
    """Normalize one order line according to the shared contract."""

    if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
        raise ValueError("quantity must be a positive integer")
    canonical_sku = sku.strip().upper()
    if not canonical_sku:
        raise ValueError("sku must not be empty")
    return {"sku": canonical_sku, "quantity": quantity}
'''

JAVASCRIPT_FINAL = '''// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Fikeya contributors

// Canonical order-line normalization for the JavaScript client.

export function formatLine(line) {
\tif (!Number.isInteger(line.quantity) || line.quantity <= 0) {
\t\tthrow new TypeError('quantity must be a positive integer');
\t}
\tconst sku = String(line.sku).trim().toUpperCase();
\tif (sku.length === 0) {
\t\tthrow new TypeError('sku must not be empty');
\t}
\treturn `${sku}:${line.quantity}`;
}
'''


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def implementation_manifest() -> dict[str, object]:
    files = {
        path.relative_to(REPOSITORY_ROOT).as_posix(): sha256_file(path)
        for path in EVALUATED_IMPLEMENTATION_PATHS
    }
    encoded = json.dumps(files, separators=(",", ":"), sort_keys=True).encode("utf-8")
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
        shell=False,
    ).stdout.strip()
    return {
        "files": files,
        "gitCommit": revision,
        "manifestSha256": sha256_bytes(encoded),
    }


def run_command(argv: list[str], *, cwd: Path) -> dict[str, object]:
    started = time.monotonic()
    completed = subprocess.run(
        argv,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        shell=False,
        timeout=60,
    )
    output = f"{completed.stdout}\n{completed.stderr}".encode("utf-8")
    return {
        "durationMs": max(1, round((time.monotonic() - started) * 1_000)),
        "exitCode": completed.returncode,
        "outputSha256": sha256_bytes(output),
    }


def command_names() -> tuple[str, str, Path, Path]:
    python_path = shutil.which("python") or shutil.which("python3")
    node_path = shutil.which("node")
    if python_path is None:
        raise RuntimeError("Python 3.10 or newer is required for this fixture.")
    if node_path is None:
        raise RuntimeError("Node.js 22 or newer is required for this fixture.")
    python = Path(python_path).name
    node = Path(node_path).name
    return python, node, Path(python_path).resolve(), Path(node_path).resolve()


def seed_memory(node_path: Path, workspace_root: Path) -> dict[str, object]:
    requests = [
        {
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "memory.initialize",
            "params": {"capture": "content"},
        }
    ]
    process = subprocess.Popen(
        [str(node_path), str(SIDECAR_PATH), "--root", str(workspace_root)],
        cwd=REPOSITORY_ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        shell=False,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    stderr = ""
    try:
        process.stdin.write(json.dumps(requests[0], separators=(",", ":")) + "\n")
        process.stdin.flush()
        initialized_response = json.loads(process.stdout.readline())
        initialized = initialized_response.get("result")
        if not isinstance(initialized, dict):
            raise RuntimeError(f"Qarinah initialization failed: {initialized_response!r}")

        followups = [
            {
                "jsonrpc": "2.0",
                "id": "approve",
                "method": "memory.approve",
                "params": {
                    "capture": "content",
                    "policyHash": initialized["policy"]["policyHash"],
                },
            },
            *[
                {
                    "jsonrpc": "2.0",
                    "id": f"record-{index}",
                    "method": "memory.record",
                    "params": {"event": event},
                }
                for index, event in enumerate(
                    [
                        {
                            "id": "fikeya-eval-order-contract",
                            "type": "decision.recorded",
                            "occurredAt": "2026-08-25T00:00:00.000Z",
                            "sessionId": "fikeya-plan-proof",
                            "payload": {
                                "title": "Canonical order-line contract",
                                "body": DECISION_BODY,
                            },
                        },
                        {
                            "id": "fikeya-eval-verification-contract",
                            "type": "summary.recorded",
                            "occurredAt": "2026-08-25T00:00:01.000Z",
                            "sessionId": "fikeya-plan-proof",
                            "payload": {
                                "title": "Cross-stack verification commands",
                                "body": "Verify the Python implementation with unittest and the JavaScript implementation with the Node test runner.",
                            },
                        },
                    ],
                    start=1,
                )
            ],
        ]
        responses: list[dict[str, object]] = []
        for request in followups:
            process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            if "error" in response:
                raise RuntimeError(f"Qarinah seed request failed: {response!r}")
            responses.append(response["result"])
    finally:
        process.stdin.close()
        process.wait(timeout=30)
        if process.stderr is not None:
            stderr = process.stderr.read()
            process.stderr.close()
        process.stdout.close()
    if process.returncode != 0:
        raise RuntimeError(f"Qarinah sidecar exited with {process.returncode}: {stderr}")
    records = responses[1:]
    return {
        "capture": initialized["capture"],
        "eventCount": len(records),
        "eventHashes": [record["hash"] for record in records],
        "workspaceId": initialized["workspaceId"],
    }


def plan_specification(python: str, node: str, workspace_root: Path) -> dict[str, object]:
    python_path = workspace_root / "python_service" / "order.py"
    javascript_path = workspace_root / "js_client" / "order.ts"
    python_before = sha256_file(python_path)
    javascript_before = sha256_file(javascript_path)
    python_after = sha256_bytes(PYTHON_FINAL.encode("utf-8"))
    javascript_after = sha256_bytes(JAVASCRIPT_FINAL.encode("utf-8"))
    return {
        "schemaVersion": 1,
        "title": "Implement and verify the canonical cross-stack order line",
        "steps": [
            {
                "stepId": "patch-python",
                "title": "Patch the Python service",
                "toolCall": {
                    "arguments": {
                        "content": PYTHON_FINAL,
                        "expectedSha256": python_before,
                        "path": "python_service/order.py",
                    },
                    "callId": "eval:patch-python",
                    "name": "workspace.write_file",
                },
                "verify": {
                    "expectedStatus": "ok",
                    "files": [
                        {"path": "python_service/order.py", "sha256": python_after}
                    ],
                },
            },
            {
                "stepId": "patch-javascript",
                "title": "Patch the JavaScript client",
                "dependsOn": ["patch-python"],
                "toolCall": {
                    "arguments": {
                        "content": JAVASCRIPT_FINAL,
                        "expectedSha256": javascript_before,
                        "path": "js_client/order.ts",
                    },
                    "callId": "eval:patch-javascript",
                    "name": "workspace.write_file",
                },
                "verify": {
                    "expectedStatus": "ok",
                    "files": [
                        {"path": "js_client/order.ts", "sha256": javascript_after}
                    ],
                },
            },
            {
                "stepId": "verify-python",
                "title": "Run the Python verifier",
                "dependsOn": ["patch-javascript"],
                "toolCall": {
                    "arguments": {
                        "arguments": [
                            "-m",
                            "unittest",
                            "discover",
                            "-s",
                            "python_service/tests",
                            "-p",
                            "test_*.py",
                        ],
                        "cwd": ".",
                        "executable": python,
                        "timeoutSeconds": 30,
                    },
                    "callId": "eval:verify-python",
                    "name": "process.run",
                },
                "verify": {"expectedExitCode": 0, "expectedStatus": "ok"},
            },
            {
                "stepId": "verify-javascript",
                "title": "Run the JavaScript verifier",
                "dependsOn": ["verify-python"],
                "toolCall": {
                    "arguments": {
                        "arguments": ["--test", "js_client/order.test.ts"],
                        "cwd": ".",
                        "executable": node,
                        "timeoutSeconds": 30,
                    },
                    "callId": "eval:verify-javascript",
                    "name": "process.run",
                },
                "verify": {"expectedExitCode": 0, "expectedStatus": "ok"},
            },
        ],
    }


def validate_report(report: dict[str, Any]) -> None:
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        raise AssertionError("The evaluation report contains no checks.")
    failures = [check["name"] for check in checks if not check.get("passed")]
    if failures:
        raise AssertionError(f"Evaluation checks failed: {', '.join(failures)}")
    if report.get("overallPassed") is not True:
        raise AssertionError("overallPassed must be true when every check passes.")
    if report["modelExecution"] != {
        "performed": False,
        "providerCalls": 0,
        "tokenMeasurement": "not-measured-no-model-was-run",
    }:
        raise AssertionError("The no-model boundary is not represented exactly.")


def evaluate(workspace_root: Path) -> dict[str, Any]:
    python, node, python_path, node_path = command_names()
    if not (SIDECAR_ROOT / "node_modules" / "qarinah").exists():
        raise RuntimeError(
            "The pinned Qarinah sidecar dependency is missing. Run `npm ci` in "
            "integrations/qarinah-sidecar first."
        )
    shutil.copytree(FIXTURE_ROOT, workspace_root, dirs_exist_ok=True)

    baseline = {
        "python": run_command(
            [python, "-m", "unittest", "discover", "-s", "python_service/tests"],
            cwd=workspace_root,
        ),
        "javascript": run_command(
            [node, "--test", "js_client/order.test.ts"], cwd=workspace_root
        ),
    }

    workspace, _ = initialize_workspace(workspace_root)
    state = StateStore(workspace.state_path)
    session = state.create_session(
        session_id="ses_fikeya_plan_proof",
        metadata={"fixture": "fikeya-plan-proof", "networkRequested": False},
    )

    seed_receipt = seed_memory(node_path, workspace_root)
    memory = QarinahSidecarAdapter(
        workspace_root=workspace_root,
        state=state,
        node_executable=node_path,
        sidecar_path=SIDECAR_PATH,
    ).query(
        session.session_id,
        TASK_QUERY,
        maximum_characters=CONTEXT_MAX_CHARACTERS,
        limit=8,
        minimum_coverage="direct",
    )
    context_pack = json.loads(memory.content)
    if DECISION_BODY not in memory.content:
        raise AssertionError("The expected Qarinah decision was not retrieved.")

    service = PlanService(workspace)
    draft = service.create(plan_specification(python, node, workspace_root))
    reviewed = service.review(draft.plan_id)
    waiting = asyncio.run(service.run(reviewed.plan_id))
    paused_before_execution = (
        workspace_root / "python_service" / "order.py"
    ).read_text(encoding="utf-8") != PYTHON_FINAL
    approved, approvals = service.approve(draft.plan_id, approve_all=True)
    completed = asyncio.run(
        service.run(
            draft.plan_id,
            allowed_executables=frozenset({python, node}),
            resume=True,
        )
    )
    view = service.view(completed)
    plan_receipt = view["receipt"]

    final = {
        "python": run_command(
            [python, "-m", "unittest", "discover", "-s", "python_service/tests"],
            cwd=workspace_root,
        ),
        "javascript": run_command(
            [node, "--test", "js_client/order.test.ts"], cwd=workspace_root
        ),
    }
    statistics = state.workspace_statistics()
    receipt_text = json.dumps(
        {"context": dataclasses.asdict(memory.receipt), "plan": plan_receipt},
        sort_keys=True,
    )
    steps = completed.steps
    checks = [
        {
            "name": "seed fixture fails before the plan",
            "passed": baseline["python"]["exitCode"] != 0
            and baseline["javascript"]["exitCode"] != 0,
        },
        {
            "name": "Qarinah returns direct cited context",
            "passed": memory.receipt.coverage == "direct"
            and (memory.receipt.evidence_count or 0) >= 1
            and len(context_pack.get("items", [])) >= 1,
        },
        {
            "name": "Qarinah honors the requested character ceiling",
            "passed": context_pack.get("budget", {}).get("maxChars")
            == CONTEXT_MAX_CHARACTERS
            and context_pack.get("budget", {}).get("usedChars", -1)
            <= CONTEXT_MAX_CHARACTERS,
        },
        {
            "name": "Fikeya pauses before unapproved execution",
            "passed": waiting.status is PlanStatus.AWAITING_APPROVAL
            and paused_before_execution,
        },
        {
            "name": "all exact approvals are consumed once",
            "passed": len(approvals) == 4
            and all(step.approval and step.approval.consumed_at for step in steps),
        },
        {
            "name": "plan reaches succeeded with verified steps",
            "passed": completed.status is PlanStatus.SUCCEEDED
            and all(
                step.verification is not None
                and step.verification.status.value == "passed"
                for step in steps
            ),
        },
        {
            "name": "Python and JavaScript verifiers pass after the plan",
            "passed": final["python"]["exitCode"] == 0
            and final["javascript"]["exitCode"] == 0,
        },
        {
            "name": "context and plan receipts omit retrieved and source bodies",
            "passed": DECISION_BODY not in receipt_text
            and PYTHON_FINAL not in receipt_text
            and JAVASCRIPT_FINAL not in receipt_text,
        },
        {
            "name": "no provider or paid model is invoked",
            "passed": statistics["providerCalls"] == 0,
        },
    ]

    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "fixture": {
            "id": "cross-stack-order-line-v1",
            "languages": ["Python", "JavaScript"],
            "networkRequested": False,
            "taskQuerySha256": sha256_bytes(TASK_QUERY.encode("utf-8")),
        },
        "implementation": implementation_manifest(),
        "environment": {
            "architecture": platform.machine(),
            "node": subprocess.run(
                [str(node_path), "--version"],
                check=True,
                capture_output=True,
                text=True,
                shell=False,
            ).stdout.strip(),
            "operatingSystem": platform.system(),
            "python": platform.python_version(),
        },
        "baseline": baseline,
        "context": {
            "adapter": "qarinah-sidecar",
            "coverage": memory.receipt.coverage,
            "evidenceCount": memory.receipt.evidence_count,
            "manifestHash": context_pack["manifestHash"],
            "requestedMaxChars": CONTEXT_MAX_CHARACTERS,
            "reportedMaxChars": context_pack["budget"]["maxChars"],
            "usedChars": context_pack["budget"]["usedChars"],
            "receiptId": memory.receipt.receipt_id,
            "requestSha256": memory.receipt.request_sha256,
            "responseBytes": memory.receipt.response_bytes,
            "responseSha256": memory.receipt.response_sha256,
            "seedEventCount": seed_receipt["eventCount"],
        },
        "plan": {
            "approvalCount": len(approvals),
            "planId": completed.plan_id,
            "recordSha256": view["recordSha256"],
            "specSha256": completed.spec_sha256,
            "statesObserved": [
                draft.status.value,
                reviewed.status.value,
                waiting.status.value,
                approved.status.value,
                completed.status.value,
            ],
            "stepCount": len(steps),
            "steps": plan_receipt["steps"],
        },
        "verification": {
            "final": final,
            "files": {
                "js_client/order.ts": sha256_file(
                    workspace_root / "js_client" / "order.ts"
                ),
                "python_service/order.py": sha256_file(
                    workspace_root / "python_service" / "order.py"
                ),
            },
        },
        "modelExecution": {
            "performed": False,
            "providerCalls": statistics["providerCalls"],
            "tokenMeasurement": "not-measured-no-model-was-run",
        },
        "officialBenchmarkMapping": [
            {
                "benchmark": "SWE-bench Verified",
                "alignedDimension": "repository patch is graded by tests",
                "notClaimed": "not a SWE-bench instance or score",
                "url": "https://www.swebench.com/SWE-bench/reference/harness/",
            },
            {
                "benchmark": "Terminal-Bench",
                "alignedDimension": "instruction, local terminal task, deterministic verifier",
                "notClaimed": "not a Terminal-Bench task or leaderboard score",
                "url": "https://github.com/harbor-framework/terminal-bench",
            },
            {
                "benchmark": "Aider polyglot",
                "alignedDimension": "multi-language code editing followed by tests",
                "notClaimed": "not an Aider polyglot run or model score",
                "url": "https://aider.chat/docs/leaderboards/",
            },
        ],
        "checks": checks,
        "overallPassed": all(check["passed"] for check in checks),
        "limitations": [
            "This deterministic integration fixture does not evaluate model intelligence.",
            "It makes no comparative accuracy, cost, speed, or token-savings claim.",
            "It runs one small local task and is not a substitute for full external benchmark datasets.",
            "No token value is reported because no model provider is called.",
            "Commands request no network access, but this fixture does not install an operating-system egress firewall.",
        ],
    }
    validate_report(report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write the JSON report to this path.")
    parser.add_argument(
        "--workspace",
        type=Path,
        help="Use and retain an empty workspace directory instead of a temporary one.",
    )
    args = parser.parse_args(argv)

    if args.workspace is not None:
        workspace_root = args.workspace.resolve()
        workspace_root.mkdir(parents=True, exist_ok=True)
        if any(workspace_root.iterdir()):
            parser.error("--workspace must point to an empty directory")
        report = evaluate(workspace_root)
    else:
        with tempfile.TemporaryDirectory(prefix="fikeya-plan-proof-") as temporary:
            report = evaluate(Path(temporary))

    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
