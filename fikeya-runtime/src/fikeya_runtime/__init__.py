# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Local-first protocol and execution foundation for Fikeya."""

from .browser import (
    BrowserActionResult,
    BrowserEngine,
    BrowserError,
    BrowserLimitError,
    BrowserReceipt,
    BrowserSecurityError,
    BrowserSession,
    BrowserUnavailable,
    SUPPORTED_BROWSER_ENGINES,
)
from .events import EventEnvelope, EventType

__all__ = [
    "BrowserActionResult",
    "BrowserEngine",
    "BrowserError",
    "BrowserLimitError",
    "BrowserReceipt",
    "BrowserSecurityError",
    "BrowserSession",
    "BrowserUnavailable",
    "EventEnvelope",
    "EventType",
    "SUPPORTED_BROWSER_ENGINES",
]
__version__ = "0.1.0b8"
