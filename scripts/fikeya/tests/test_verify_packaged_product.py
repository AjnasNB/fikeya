# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.fikeya.verify_packaged_product import (
    verify_built_in_ai_extensions,
    verify_packaged_product,
)


class PackagedProductVerificationTests(unittest.TestCase):
    def test_accepts_an_explicit_empty_built_in_ai_extension_list(self) -> None:
        verify_built_in_ai_extensions({"builtInAiExtensions": []}, "product.json")

    def test_rejects_missing_or_non_empty_built_in_ai_extensions(self) -> None:
        for product in (
            {},
            {"builtInAiExtensions": None},
            {"builtInAiExtensions": ""},
            {"builtInAiExtensions": ["github.copilot-chat"]},
        ):
            with self.subTest(product=product):
                with self.assertRaisesRegex(ValueError, "must be exactly"):
                    verify_built_in_ai_extensions(product, "product.json")

    def test_reads_the_packaged_product_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            product_path = Path(temporary_directory) / "resources" / "app" / "product.json"
            product_path.parent.mkdir(parents=True)
            product_path.write_text(json.dumps({"builtInAiExtensions": []}), encoding="utf-8")
            verify_packaged_product(product_path)


if __name__ == "__main__":
    unittest.main()
