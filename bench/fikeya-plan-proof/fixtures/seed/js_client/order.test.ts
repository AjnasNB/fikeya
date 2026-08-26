// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Fikeya contributors

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLine } from './order.ts';

test('normalizes one order line', () => {
	assert.equal(formatLine({ sku: '  item-42 ', quantity: 3 }), 'ITEM-42:3');
});

test('rejects an invalid quantity', () => {
	assert.throws(() => formatLine({ sku: 'item-42', quantity: 0 }), /positive integer/);
});
