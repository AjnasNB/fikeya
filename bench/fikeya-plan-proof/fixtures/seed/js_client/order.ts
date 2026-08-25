// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Fikeya contributors

// Tiny TypeScript client with an intentional evaluation defect.

export function formatLine(line: { sku: string; quantity: number }): string {
	return `${line.sku}:${line.quantity}`;
}
