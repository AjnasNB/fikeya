# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

import os
import sys

# PyInstaller expands the reviewed browser payload beside Playwright's packaged
# driver. Force frozen builds to use that immutable payload instead of a mutable
# per-user ms-playwright cache. Source/CLI installations retain normal Playwright
# discovery and can provision their own browser with the pinned installer.
if getattr(sys, "frozen", False):
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "0"

from fikeya_runtime.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
