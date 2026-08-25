# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def verify_built_in_ai_extensions(product: Any, source: str) -> None:
    """Fail closed unless a packaged Fikeya product explicitly disables built-in AI extensions."""
    if not isinstance(product, dict):
        raise ValueError(f"{source} must contain a JSON object.")
    value = product.get("builtInAiExtensions")
    if value != []:
        raise ValueError(
            f"{source} builtInAiExtensions must be exactly []; received {value!r}. "
            "Fikeya release packages must not bundle Microsoft Copilot or another built-in AI extension."
        )


def verify_packaged_product(path: Path) -> None:
    try:
        product = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"Packaged product.json was not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Packaged product.json is invalid JSON: {path}: {error}") from error
    verify_built_in_ai_extensions(product, str(path))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify provider-neutral fields in a packaged Fikeya product.json."
    )
    parser.add_argument("product_json", type=Path, help="Path to the packaged resources/app/product.json")
    arguments = parser.parse_args()
    try:
        verify_packaged_product(arguments.product_json.resolve())
    except ValueError as error:
        parser.exit(1, f"ERROR: {error}\n")
    print(f"Packaged Fikeya product verified: {arguments.product_json}")
    print("Verified builtInAiExtensions is exactly [].")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
