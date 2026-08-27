/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveFikeyaHostCapabilities } from '../hostCapabilities';

describe('Fikeya host capabilities', () => {
	test('recognizes the branded desktop product', () => {
		assert.deepStrictEqual(resolveFikeyaHostCapabilities('Fikeya', true), {
			isFikeyaProduct: true,
			supportsDesktopWorkbench: true
		});
	});

	test('enables the workbench integration in compatible desktop Code OSS hosts', () => {
		for (const appName of ['Visual Studio Code', 'Cursor', 'VSCodium', 'Code - OSS']) {
			assert.deepStrictEqual(resolveFikeyaHostCapabilities(appName, true), {
				isFikeyaProduct: false,
				supportsDesktopWorkbench: true
			});
		}
	});

	test('does not expose desktop workbench commands in web extension hosts', () => {
		assert.deepStrictEqual(resolveFikeyaHostCapabilities('Fikeya', false), {
			isFikeyaProduct: true,
			supportsDesktopWorkbench: false
		});
		assert.deepStrictEqual(resolveFikeyaHostCapabilities('Visual Studio Code', false), {
			isFikeyaProduct: false,
			supportsDesktopWorkbench: false
		});
	});
});
