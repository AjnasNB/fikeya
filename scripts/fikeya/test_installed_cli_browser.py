#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exercise browser tools through an isolated, installed Fikeya CLI."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from test_installed_browser import smoke_local_fixture


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fikeya", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--browser-cache", type=Path, required=True)
    args = parser.parse_args()
    workspace = args.workspace.resolve(strict=True)
    if not workspace.is_dir() or any(workspace.iterdir()):
        raise RuntimeError("CLI browser smoke workspace must be an empty directory.")
    receipt = smoke_local_fixture(
        args.fikeya.resolve(strict=True),
        workspace,
        browser_cache=args.browser_cache,
    )
    print(
        json.dumps(
            {
                "schemaVersion": "fikeya.installed-cli-browser-smoke.v1",
                **receipt,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TypeError) as error:
        print(f"CLI browser smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
