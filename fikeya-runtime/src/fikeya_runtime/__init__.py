# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Local-first protocol and execution foundation for Fikeya."""

from .events import EventEnvelope, EventType

__all__ = ["EventEnvelope", "EventType"]
__version__ = "0.1.0b1"
