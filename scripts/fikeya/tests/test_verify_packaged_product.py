# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.fikeya.verify_packaged_product import (
    verify_built_in_ai_extensions,
    verify_packaged_product,
    verify_windows_executable_metadata,
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

    def test_accepts_the_exact_windows_executable_identity(self) -> None:
        verify_windows_executable_metadata(
            {
                "productName": "Fikeya",
                "companyName": "Ajnas N B",
                "fileDescription": "Fikeya",
                "originalFilename": "Fikeya.exe",
                "fileVersion": "0.1.0.2",
                "productVersion": "0.1.0-beta.2",
                "fileVersionRaw": "0.1.0.2",
                "productVersionRaw": "0.1.0.2",
                "authenticodeStatus": "NotSigned",
            },
            public_version="0.1.0-beta.2",
            numeric_version="0.1.0.2",
        )

    def test_rejects_a_normalized_prerelease_windows_version(self) -> None:
        metadata = {
            "productName": "Fikeya",
            "companyName": "Ajnas N B",
            "fileDescription": "Fikeya",
            "originalFilename": "Fikeya.exe",
            "fileVersion": "0.1.0-beta.2",
            "productVersion": "0.1.0-beta.2",
            "fileVersionRaw": "0.1.0.0",
            "productVersionRaw": "0.1.0.0",
            "authenticodeStatus": "NotSigned",
        }
        with self.assertRaisesRegex(ValueError, "fileVersion"):
            verify_windows_executable_metadata(
                metadata,
                public_version="0.1.0-beta.2",
                numeric_version="0.1.0.2",
            )


if __name__ == "__main__":
    unittest.main()
