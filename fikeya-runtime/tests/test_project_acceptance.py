# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Acceptance proof for Fikeya's durable plan-to-verified-project workflow."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import re
import socket
import threading
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
from fikeya_agent_core import ApprovalDecision

from fikeya_runtime.autonomy import (
    AUTONOMY_REVIEW_PROTOCOL,
    AutonomousProjectLoop,
    AutonomyStage,
    ProviderOptions,
)
from fikeya_runtime.browser import BrowserSession, BrowserUnavailable
from fikeya_runtime.inference import CancellationToken
from fikeya_runtime.modes import AgentMode
from fikeya_runtime.plans import PlanService
from fikeya_runtime.workspace import initialize_workspace

_ORIGINAL_SOCKET_CONNECT = socket.socket.connect


def _sha256(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode()).hexdigest()}"


INDEX = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Falling Star</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main aria-label="Star impact animation">
    <div class="earth" aria-label="Earth"></div>
    <div class="star" aria-label="Falling star"></div>
    <h1>A star is falling toward Earth</h1>
    <p id="status" aria-live="polite">Simulation ready</p>
    <button id="launch" type="button">Start simulation</button>
  </main>
  <script src="app.js"></script>
</body>
</html>
"""

STYLES = """*{box-sizing:border-box}body{margin:0;background:#07111f;color:#eef6ff;font-family:system-ui,sans-serif}main{min-height:100vh;display:grid;place-content:center;justify-items:center;overflow:hidden;position:relative}.earth{width:18rem;height:18rem;border-radius:50%;background:radial-gradient(circle at 35% 30%,#58d4ff,#17609b 48%,#071b36 72%);box-shadow:0 0 5rem #2288cc66}.star{position:absolute;top:8%;right:18%;width:2rem;height:2rem;border-radius:50%;background:#fff3b0;box-shadow:0 0 2rem #ffd166}body.running .star{animation:fall 1.2s ease-in forwards}h1,p,button{z-index:2}button{padding:.75rem 1.1rem;border:0;border-radius:999px;background:#99f6e4;color:#082f49;font-weight:700}@keyframes fall{to{transform:translate(-44vw,48vh) scale(.2);opacity:.25}}
"""

SCRIPT = """const button=document.querySelector('#launch');const status=document.querySelector('#status');button.addEventListener('click',()=>{document.body.classList.add('running');status.textContent='Simulation running';button.disabled=true;});
"""


def _site_plan(browser_url: str | None = None) -> dict[str, object]:
    files = (("index.html", INDEX), ("styles.css", STYLES), ("app.js", SCRIPT))
    steps: list[dict[str, object]] = []
    for index, (path, content) in enumerate(files, start=1):
        step_id = f"write-{index}"
        steps.append(
            {
                "stepId": step_id,
                "title": f"Create {path}",
                "dependsOn": [] if index == 1 else [f"write-{index - 1}"],
                "toolCall": {
                    "arguments": {
                        "content": content,
                        "expectedSha256": None,
                        "path": path,
                    },
                    "callId": f"call-{step_id}",
                    "name": "workspace.write_file",
                },
                "verify": {
                    "expectedStatus": "ok",
                    "files": [{"path": path, "sha256": _sha256(content)}],
                },
            }
        )
    if browser_url is not None:
        browser_calls: tuple[tuple[str, str, dict[str, object]], ...] = (
            ("navigate", "browser.navigate", {"url": browser_url}),
            (
                "assert-ready",
                "browser.assert_text",
                {"text": "Simulation ready"},
            ),
            ("click-launch", "browser.click", {"selector": "#launch"}),
            (
                "assert-running",
                "browser.assert_text",
                {"text": "Simulation running"},
            ),
            (
                "capture",
                "browser.screenshot",
                {"path": "artifacts/falling-star.png"},
            ),
            ("close", "browser.close", {}),
        )
        dependency = steps[-1]["stepId"]
        for suffix, tool_name, arguments in browser_calls:
            step_id = f"browser-{suffix}"
            steps.append(
                {
                    "stepId": step_id,
                    "title": f"Verify the site with {tool_name}",
                    "dependsOn": [dependency],
                    "toolCall": {
                        "arguments": arguments,
                        "callId": f"call-{step_id}",
                        "name": tool_name,
                    },
                    "verify": {"expectedStatus": "ok"},
                }
            )
            dependency = step_id
    return {"schemaVersion": 1, "title": "Build the falling-star site", "steps": steps}


def _audit(phase: AutonomyStage) -> str:
    criterion = "criterion-1" if phase is AutonomyStage.VERIFY else f"{phase.value}-proof"
    return json.dumps(
        {
            "checks": [
                {
                    "criterion": criterion,
                    "evidenceSha256": _sha256(f"{phase.value}:accepted"),
                    "passed": True,
                }
            ],
            "feedback": "The bounded evidence satisfies the requested phase.",
            "phase": phase.value,
            "protocol": AUTONOMY_REVIEW_PROTOCOL,
            "verdict": "accept",
        },
        separators=(",", ":"),
        sort_keys=True,
    )


class _Planner:
    def __init__(self, plans: PlanService, browser_url: str | None = None) -> None:
        self.plans = plans
        self.browser_url = browser_url

    def propose(self, **_kwargs: object) -> object:
        return SimpleNamespace(
            plan=self.plans.create(_site_plan(self.browser_url))
        )


@dataclass(frozen=True)
class _CodingResult:
    status: str
    output: str


class _Auditor:
    def __init__(self) -> None:
        self.phases = [
            AutonomyStage.AUDIT_PLAN,
            AutonomyStage.AUDIT_CODE,
            AutonomyStage.VERIFY,
        ]
        self.modes: list[object] = []

    async def run(self, **kwargs: object) -> object:
        self.modes.append(kwargs["mode"])
        prompt = str(kwargs["prompt"])
        match = re.search(
            r'"requiredEvidenceSha256":"(sha256:[0-9a-f]{64})"', prompt
        )
        assert match is not None
        value = json.loads(_audit(self.phases.pop(0)))
        for check in value["checks"]:
            check["evidenceSha256"] = match.group(1)
        return _CodingResult(
            "completed", json.dumps(value, separators=(",", ":"), sort_keys=True)
        )


async def _approve_once(_request: dict[str, object]) -> ApprovalDecision:
    return ApprovalDecision.ALLOW_ONCE


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


def test_falling_star_project_is_planned_audited_built_and_verified(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    root = tmp_path / "falling-star"
    root.mkdir()
    workspace, _ = initialize_workspace(root)
    plans = PlanService(workspace)
    auditor = _Auditor()
    loop = AutonomousProjectLoop(
        workspace,
        _Planner(plans),
        auditor,
        plans=plans,
    )
    goal = "Build and verify an animated star falling toward Earth."
    record = loop.start(goal)
    options = ProviderOptions(provider_name="fixture", allow_network=False)

    paused = asyncio.run(
        loop.advance(
            record.run_id,
            goal=goal,
            provider=options,
            cancellation=CancellationToken(),
            approval_handler=_approve_once,
        )
    )
    assert paused.stage is AutonomyStage.STOPPED
    assert paused.stop_reason == "plan_review_required"
    assert paused.plan_id is not None
    plans.review(paused.plan_id)
    plans.approve(paused.plan_id, approve_all=True)

    restarted = AutonomousProjectLoop(
        workspace,
        _Planner(plans),
        auditor,
        plans=PlanService(workspace),
    )
    restarted.resume(record.run_id)
    completed = asyncio.run(
        restarted.advance(
            record.run_id,
            goal=goal,
            provider=options,
            cancellation=CancellationToken(),
            approval_handler=_approve_once,
        )
    )

    assert completed.stage is AutonomyStage.COMPLETED
    assert completed.completion_evidence_ready
    assert auditor.modes == [AgentMode.PLAN, AgentMode.REVIEW, AgentMode.REVIEW]
    assert (root / "index.html").read_text(encoding="utf-8") == INDEX
    assert (root / "styles.css").read_text(encoding="utf-8") == STYLES
    assert (root / "app.js").read_text(encoding="utf-8") == SCRIPT


def test_falling_star_site_is_browser_interactive_when_playwright_is_available(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(socket.socket, "connect", _ORIGINAL_SOCKET_CONNECT)
    if importlib.util.find_spec("playwright") is None:
        pytest.skip("optional Python Playwright dependency is not installed")
    root = tmp_path / "browser-site"
    root.mkdir()
    try:
        availability_probe = BrowserSession(root, allow_private=True)
    except BrowserUnavailable as error:
        pytest.skip(str(error))
    else:
        availability_probe.close()
    handler = partial(_QuietHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        workspace, _ = initialize_workspace(root)
        plans = PlanService(workspace)
        auditor = _Auditor()
        loop = AutonomousProjectLoop(
            workspace,
            _Planner(
                plans,
                f"http://127.0.0.1:{server.server_port}/",
            ),
            auditor,
            plans=plans,
        )
        goal = "Build and browser-verify an animated star falling toward Earth."
        record = loop.start(goal)
        options = ProviderOptions(
            provider_name="fixture",
            allow_network=False,
            allow_private_browser=True,
        )
        paused = asyncio.run(
            loop.advance(
                record.run_id,
                goal=goal,
                provider=options,
                cancellation=CancellationToken(),
                approval_handler=_approve_once,
            )
        )
        assert paused.plan_id is not None
        plans.review(paused.plan_id)
        plans.approve(paused.plan_id, approve_all=True)
        loop.resume(record.run_id)
        try:
            completed = asyncio.run(
                loop.advance(
                    record.run_id,
                    goal=goal,
                    provider=options,
                    cancellation=CancellationToken(),
                    approval_handler=_approve_once,
                )
            )
        except BrowserUnavailable as error:
            pytest.skip(str(error))
        assert completed.stage is AutonomyStage.COMPLETED
        assert completed.completion_evidence_ready
        assert (root / "artifacts" / "falling-star.png").is_file()
        executed = plans.store.load(paused.plan_id)
        browser_receipts = [
            step.execution
            for step in executed.steps
            if step.tool_call.name.startswith("browser.")
        ]
        assert all(receipt is not None for receipt in browser_receipts)
        assert len(browser_receipts) == 6
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
