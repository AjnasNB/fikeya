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

	test('accepts bounded agent turns only with per-run network consent', () => {
		assert.deepStrictEqual(parseWebviewMessage({
			type: 'runAgent',
			providerName: 'azure-primary',
			prompt: 'Explain the failing test.',
			maxOutputTokens: 2048,
			contextMaxCharacters: 12_000,
			memoryMode: 'auto',
			allowNetwork: true
		}), {
			type: 'runAgent',
			providerName: 'azure-primary',
			prompt: 'Explain the failing test.',
			maxOutputTokens: 2048,
			contextMaxCharacters: 12_000,
			memoryMode: 'auto',
			allowNetwork: true
		});

		assert.strictEqual(parseWebviewMessage({
			type: 'runAgent',
			providerName: 'azure-primary',
			prompt: 'No consent.',
			maxOutputTokens: 2048,
			contextMaxCharacters: 12_000,
			memoryMode: 'required',
			allowNetwork: false
		}), undefined);
	});

	test('rejects oversized prompts and unsafe provider identifiers', () => {
		assert.strictEqual(parseWebviewMessage({
			type: 'runAgent',
			providerName: '../provider',
			prompt: 'hello',
			maxOutputTokens: 1024,
			contextMaxCharacters: 12_000,
			memoryMode: 'auto',
			allowNetwork: true
		}), undefined);
		assert.strictEqual(parseWebviewMessage({
			type: 'runAgent',
			providerName: 'local',
			prompt: '🧠'.repeat(70_000),
			maxOutputTokens: 1024,
			contextMaxCharacters: 12_000,
			memoryMode: 'auto',
			allowNetwork: true
		}), undefined);
		assert.strictEqual(parseWebviewMessage({
			type: 'runAgent',
			providerName: 'local',
			prompt: 'hello',
			maxOutputTokens: 1024,
			contextMaxCharacters: 64_001,
			memoryMode: 'auto',
			allowNetwork: true
		}), undefined);
	});

	test('accepts only bounded provider and refresh actions', () => {
		assert.deepStrictEqual([
			parseWebviewMessage({ type: 'refreshProviders' }),
			parseWebviewMessage({ type: 'testProvider', providerName: 'openrouter-primary' }),
			parseWebviewMessage({ type: 'removeProvider', providerName: 'bad name' }),
			parseWebviewMessage({ type: 'cancelAgent' }),
			parseWebviewMessage({ type: 'refreshReceipts' }),
			parseWebviewMessage({ type: 'refreshMemory' })
		], [
			{ type: 'refreshProviders' },
			{ type: 'testProvider', providerName: 'openrouter-primary' },
			undefined,
			{ type: 'cancelAgent' },
			{ type: 'refreshReceipts' },
			{ type: 'refreshMemory' }
		]);
	});
});
