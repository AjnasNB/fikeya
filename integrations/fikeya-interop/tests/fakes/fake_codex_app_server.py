"""Deterministic JSONL peer used by subprocess boundary tests."""

from __future__ import annotations

import json
import os
import sys


def send(value: object) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def receive() -> dict[str, object] | None:
    line = sys.stdin.readline()
    if not line:
        return None
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    return value


def main() -> int:
    initialized = False
    counter = 0
    while message := receive():
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params")
        params = params if isinstance(params, dict) else {}
        if method == "initialize":
            send(
                {
                    "id": request_id,
                    "result": {
                        "userAgent": "fake-codex/1.0",
                        "sawSensitiveEnvironment": any(
                            marker in name.upper()
                            for name in os.environ
                            for marker in ("API_KEY", "SECRET", "TOKEN", "PASSWORD")
                        ),
                    },
                }
            )
        elif method == "initialized":
            initialized = True
        elif not initialized:
            send({"id": request_id, "error": {"code": -32000, "message": "Not initialized"}})
        elif method == "thread/start":
            counter += 1
            approval_id = f"approval-{counter}"
            send(
                {
                    "id": approval_id,
                    "method": "item/commandExecution/requestApproval",
                    "params": {
                        "threadId": f"thread-{counter}",
                        "turnId": f"turn-{counter}",
                        "itemId": f"item-{counter}",
                        "cwd": params.get("cwd"),
                        "reason": "exercise the permission bridge",
                    },
                }
            )
            approval = receive()
            if approval is None:
                return 1
            result = approval.get("result")
            decision = result.get("decision") if isinstance(result, dict) else None
            if decision not in {"accept", "acceptForSession"}:
                send({"id": request_id, "error": {"code": -32000, "message": "declined"}})
            else:
                send({"id": request_id, "result": {"thread": {"id": f"thread-{counter}"}}})
        elif method == "thread/resume":
            send({"id": request_id, "result": {"thread": {"id": params.get("threadId")}}})
        elif method == "thread/fork":
            send({"id": request_id, "result": {"thread": {"id": "thread-fork"}}})
        elif method == "turn/start":
            send({"id": request_id, "result": {"turn": {"id": "turn-live"}}})
            send({"method": "turn/started", "params": {"turn": {"id": "turn-live"}}})
        elif method == "turn/interrupt":
            send({"id": request_id, "result": {}})
            send({"method": "turn/completed", "params": {"turn": {"id": "turn-live", "status": "interrupted"}}})
        elif method == "oversized":
            send({"id": request_id, "result": {"text": "x" * 4096}})
        else:
            send({"id": request_id, "error": {"code": -32601, "message": "Method not found"}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
