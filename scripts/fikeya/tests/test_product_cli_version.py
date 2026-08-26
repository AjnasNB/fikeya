# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from pathlib import Path
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class ProductCliVersionTests(unittest.TestCase):
    def test_cli_prefers_the_public_distribution_version(self) -> None:
        cli_source = (REPOSITORY_ROOT / "src/vs/code/node/cli.ts").read_text(encoding="utf-8")

        self.assertIn(
            "const displayVersion = product.distributionVersion ?? product.version;",
            cli_source,
        )
        self.assertIn("buildVersionMessage(displayVersion, product.commit)", cli_source)
        self.assertEqual(cli_source.count("buildHelpMessage(product.nameLong, executable, displayVersion"), 2)


if __name__ == "__main__":
    unittest.main()
