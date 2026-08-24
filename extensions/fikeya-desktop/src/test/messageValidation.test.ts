/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { escapeHtml, parseWebviewMessage } from '../messageValidation';

describe('Fikeya webview message validation', () => {
	test('accepts only the declared modes, layouts, and commands', () => {
		assert.deepStrictEqual([
			parseWebviewMessage({ type: 'selectMode', mode: 'review' }),
			parseWebviewMessage({ type: 'switchLayout', layout: 'agentFocus' }),
			parseWebviewMessage({ type: 'openCommand', command: 'fikeya.runDoctor' }),
			parseWebviewMessage({ type: 'openCommand', command: 'workbench.action.terminal.sendSequence' }),
			parseWebviewMessage({ type: 'selectMode', mode: '../terminal' })
		], [
			{ type: 'selectMode', mode: 'review' },
			{ type: 'switchLayout', layout: 'agentFocus' },
			{ type: 'openCommand', command: 'fikeya.runDoctor' },
			undefined,
			undefined
		]);
	});

	test('escapes all HTML-significant characters', () => {
		assert.strictEqual(escapeHtml(`<script data-value="x">'&</script>`), '&lt;script data-value=&quot;x&quot;&gt;&#39;&amp;&lt;/script&gt;');
	});
});
