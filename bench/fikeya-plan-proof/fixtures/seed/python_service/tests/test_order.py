# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import unittest

from python_service.order import normalize_line


class NormalizeLineTests(unittest.TestCase):
    def test_normalizes_a_valid_line(self) -> None:
        self.assertEqual(
            normalize_line("  part-7 ", 2),
            {"sku": "PART-7", "quantity": 2},
        )

    def test_rejects_a_non_positive_quantity(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive integer"):
            normalize_line("PART-7", 0)


if __name__ == "__main__":
    unittest.main()
