"""Content-free interoperability receipts."""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import asdict
from typing import Any, Protocol

from .models import InteropReceipt


def canonical_bytes(value: Any) -> bytes:
    """Encode supported protocol data deterministically without retaining it."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")


def canonical_digest(value: Any) -> str:
    """Return a SHA-256 digest for protocol data."""

    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


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
