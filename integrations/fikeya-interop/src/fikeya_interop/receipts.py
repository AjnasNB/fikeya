"""Content-free interoperability receipts."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Protocol

from .models import InteropReceipt


def canonical_bytes(value: Any) -> bytes:
    """Encode supported protocol data deterministically without retaining it."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")


def canonical_digest(value: Any) -> str:
    """Return a SHA-256 digest for protocol data."""

    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


def build_receipt(
    *,
    protocol: str,
    peer_id: str,
    operation: str,
    started_ns: int,
    input_value: Any,
    output_value: Any,
    status: str,
    truncated: bool = False,
) -> InteropReceipt:
    """Build a content-free receipt after an operation completes."""

    finished_ns = time.monotonic_ns()
    input_bytes = canonical_bytes(input_value)
    output_bytes = canonical_bytes(output_value)
    input_digest = f"sha256:{hashlib.sha256(input_bytes).hexdigest()}"
    output_digest = f"sha256:{hashlib.sha256(output_bytes).hexdigest()}"
    identity = canonical_bytes(
        {
            "protocol": protocol,
            "peer": peer_id,
            "operation": operation,
            "started": started_ns,
            "input": input_digest,
            "output": output_digest,
        }
    )
    receipt_id = f"receipt_{hashlib.sha256(identity).hexdigest()[:24]}"
    return InteropReceipt(
        receipt_id=receipt_id,
        protocol=protocol,
        peer_id=peer_id,
        operation=operation,
        started_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        duration_ms=max(0, (finished_ns - started_ns) // 1_000_000),
        status=status,
        input_digest=input_digest,
        output_digest=output_digest,
        input_bytes=len(input_bytes),
        output_bytes=len(output_bytes),
        truncated=truncated,
    )


class ReceiptSink(Protocol):
    """Destination for content-free operation receipts."""

    def record(self, receipt: InteropReceipt) -> None: ...


class MemoryReceiptSink:
    """Thread-safe in-memory receipt sink for desktop sessions and tests."""

    def __init__(self) -> None:
        self._receipts: list[InteropReceipt] = []
        self._lock = threading.Lock()

    def record(self, receipt: InteropReceipt) -> None:
        with self._lock:
            self._receipts.append(receipt)

    def snapshot(self) -> tuple[InteropReceipt, ...]:
        with self._lock:
            return tuple(self._receipts)

    def as_dicts(self) -> tuple[dict[str, Any], ...]:
        return tuple(asdict(receipt) for receipt in self.snapshot())
