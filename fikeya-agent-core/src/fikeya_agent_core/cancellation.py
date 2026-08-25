# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Thread-safe cooperative cancellation shared with provider adapters."""

from __future__ import annotations

import threading

from .errors import CancellationError


class CancellationToken:
    """Signal cancellation without granting the core authority to kill processes."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        """Request cancellation."""

        self._event.set()

    @property
    def cancelled(self) -> bool:
        """Return whether cancellation was requested."""

        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        """Raise at a cooperative boundary when cancellation was requested."""

        if self.cancelled:
            raise CancellationError("Agent execution was cancelled.")
