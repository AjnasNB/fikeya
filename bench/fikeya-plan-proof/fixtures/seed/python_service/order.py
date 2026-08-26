# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

"""Order-line normalization with an intentional evaluation defect."""


def normalize_line(sku: str, quantity: int) -> dict[str, object]:
    """Return the order line in its current, deliberately incomplete form."""

    return {"sku": sku, "quantity": quantity}
