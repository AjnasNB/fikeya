/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { agentComposerConstraints, agentComposerDefaults, invokeAgentRunRequest, isAgentComposerNumberValid } from '../agentComposer';
import { escapeHtml, parseWebviewMessage } from '../messageValidation';

describe('Fikeya webview message validation', () => {
	test('accepts the bounded local conversation reset action', () => {
		assert.deepStrictEqual(parseWebviewMessage({ type: 'clearConversation' }), { type: 'clearConversation' });
	});

	test('validates message actions without accepting paths or schemes outside the workspace boundary', () => {
		assert.deepStrictEqual(parseWebviewMessage({ type: 'copyText', text: 'copy me' }), { type: 'copyText', text: 'copy me' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'reviewDiff', content: '@@ -1 +1 @@\n-old\n+new' }), { type: 'reviewDiff', content: '@@ -1 +1 @@\n-old\n+new' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'openFile', path: 'src/index.ts' }), { type: 'openFile', path: 'src/index.ts' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'openFile', path: '../secret.txt' }), undefined);
		assert.deepStrictEqual(parseWebviewMessage({ type: 'openExternal', url: 'https://fikeya.com/docs/' }), { type: 'openExternal', url: 'https://fikeya.com/docs/' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'openExternal', url: 'javascript:alert(1)' }), undefined);
	});

	test('accepts only local workspace surfaces', () => {
		assert.deepStrictEqual([
			parseWebviewMessage({ type: 'selectSurface', surface: 'chat' }),
			parseWebviewMessage({ type: 'selectSurface', surface: 'plan' }),
			parseWebviewMessage({ type: 'selectSurface', surface: 'context' }),
			parseWebviewMessage({ type: 'selectSurface', surface: 'usage' }),
			parseWebviewMessage({ type: 'selectSurface', surface: 'terminal' })
		], [
			{ type: 'selectSurface', surface: 'chat' },
			{ type: 'selectSurface', surface: 'plan' },
			{ type: 'selectSurface', surface: 'context' },
			{ type: 'selectSurface', surface: 'usage' },
			undefined
		]);
	});

	test('accepts only the declared commands and rejects retired surface controls', () => {
		assert.deepStrictEqual([
			parseWebviewMessage({ type: 'openCommand', command: 'fikeya.runDoctor' }),
			parseWebviewMessage({ type: 'openCommand', command: 'fikeya.mode.lab' }),
			parseWebviewMessage({ type: 'openCommand', command: 'fikeya.mode.research' }),
			parseWebviewMessage({ type: 'openCommand', command: 'fikeya.view.usage' }),
			parseWebviewMessage({ type: 'openCommand', command: 'fikeya.view.setup' }),
			parseWebviewMessage({ type: 'openCommand', command: 'workbench.action.terminal.sendSequence' }),
			parseWebviewMessage({ type: 'selectMode', mode: 'review' }),
			parseWebviewMessage({ type: 'switchLayout', layout: 'agentFocus' })
		], [
			{ type: 'openCommand', command: 'fikeya.runDoctor' },
			{ type: 'openCommand', command: 'fikeya.mode.lab' },
			{ type: 'openCommand', command: 'fikeya.mode.research' },
			{ type: 'openCommand', command: 'fikeya.view.usage' },
			{ type: 'openCommand', command: 'fikeya.view.setup' },
			undefined,
			undefined,
			undefined
		]);
	});

	test('escapes all HTML-significant characters', () => {
		assert.strictEqual(escapeHtml(`<script data-value="x">'&</script>`), '&lt;script data-value=&quot;x&quot;&gt;&#39;&amp;&lt;/script&gt;');
	});

	test('accepts bounded agent turns only with per-run network consent', () => {
		const request = {
			type: 'runAgent',
			providerName: 'azure-primary',
			prompt: 'Explain the failing test.',
			maxOutputTokens: 2048,
			contextMaxCharacters: 12_000,
			memoryMode: 'auto',
			allowNetwork: true
		};
		assert.deepStrictEqual(parseWebviewMessage(request), {
			type: 'runAgent',
			providerName: 'azure-primary',
			prompt: 'Explain the failing test.',
			maxOutputTokens: 2048,
			contextMaxCharacters: 12_000,
			memoryMode: 'auto',
			allowNetwork: true
		});
		assert.deepStrictEqual(parseWebviewMessage({ ...request, type: 'proposePlan' }), {
			type: 'proposePlan',
			providerName: 'azure-primary',
			prompt: 'Explain the failing test.',
			maxOutputTokens: 2048,
			contextMaxCharacters: 12_000,
			memoryMode: 'auto',
			allowNetwork: true
		});

		assert.strictEqual(parseWebviewMessage({
			type: 'proposePlan',
			providerName: 'azure-primary',
			prompt: 'No consent.',
			maxOutputTokens: 2048,
			contextMaxCharacters: 12_000,
			memoryMode: 'required',
			allowNetwork: false
		}), undefined);
	});

	test('submits untouched Chat defaults and invokes the selected provider', async () => {
		assert.deepStrictEqual({
			context: isAgentComposerNumberValid(agentComposerDefaults.contextMaxCharacters, agentComposerConstraints.contextMaxCharacters),
			output: isAgentComposerNumberValid(agentComposerDefaults.maxOutputTokens, agentComposerConstraints.maxOutputTokens)
		}, { context: true, output: true });

		const request = parseWebviewMessage({
			type: 'runAgent',
			providerName: 'local-default',
			prompt: 'Inspect the current project.',
			...agentComposerDefaults,
			allowNetwork: true
		});
		assert.ok(request && request.type === 'runAgent');

		let invocation: readonly [string, string, number, number, string] | undefined;
		await invokeAgentRunRequest(request, async (providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode) => {
			invocation = [providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode];
		});
		assert.deepStrictEqual(invocation, [
			'local-default',
			'Inspect the current project.',
			agentComposerDefaults.maxOutputTokens,
			agentComposerDefaults.contextMaxCharacters,
			agentComposerDefaults.memoryMode
		]);
	});

	test('accepts an exact bounded plan specification and declared lifecycle actions', () => {
		const specification = {
			schemaVersion: 1,
			title: 'Inspect the project',
			steps: [{
				stepId: 'inspect',
				title: 'List files',
				toolCall: { callId: 'plan:list', name: 'workspace.list_files', arguments: { path: '.' } },
				verify: { expectedStatus: 'ok' }
			}]
		};
		assert.deepStrictEqual(parseWebviewMessage({ type: 'createPlan', specification }), { type: 'createPlan', specification });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'newPlan' }), { type: 'newPlan' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'refreshPlan' }), { type: 'refreshPlan' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'planAction', action: 'review' }), { type: 'planAction', action: 'review' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'planAction', action: 'approve-step', stepId: 'inspect' }), { type: 'planAction', action: 'approve-step', stepId: 'inspect' });
		assert.strictEqual(parseWebviewMessage({ type: 'planAction', action: 'approve-step', stepId: '../inspect' }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'planAction', action: 'delete' }), undefined);
	});

	test('rejects forward-dependent and unsupported-tool plan specifications', () => {
		const laterDependency = {
			title: 'Invalid ordering',
			steps: [{ stepId: 'first', title: 'First', dependsOn: ['later'], toolCall: { callId: 'first:call', name: 'workspace.list_files', arguments: {} } }, { stepId: 'later', title: 'Later', toolCall: { callId: 'later:call', name: 'workspace.list_files', arguments: {} } }]
		};
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: laterDependency }), undefined);
		const unsupported = {
			title: 'Unsupported tool',
			steps: [{ stepId: 'fetch', title: 'Fetch', toolCall: { callId: 'fetch:call', name: 'network.fetch', arguments: { url: 'https://example.com' } } }]
		};
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: unsupported }), undefined);
	});

	test('matches runtime plan invariants before specifications cross stdin', () => {
		const hash = `sha256:${'a'.repeat(64)}`;
		const valid = {
			schemaVersion: 1,
			title: 'Inspect and verify',
			steps: [
				{ stepId: 'inspect', title: 'Inspect', toolCall: { callId: 'call:inspect', name: 'workspace.list_files', arguments: { path: '.' } } },
				{ stepId: 'verify', title: 'Verify', dependsOn: ['inspect'], toolCall: { callId: 'call:verify', name: 'workspace.read_file', arguments: { path: 'README.md' } }, verify: { expectedStatus: 'ok', expectedExitCode: 0, expectedOutputSha256: hash, files: [{ path: 'README.md', sha256: hash }] } }
			]
		};
		assert.ok(parseWebviewMessage({ type: 'createPlan', specification: valid }));
		const duplicateCall = structuredClone(valid);
		duplicateCall.steps[1].toolCall.callId = 'call:inspect';
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: duplicateCall }), undefined);
		const duplicateDependency = structuredClone(valid);
		duplicateDependency.steps[1].dependsOn = ['inspect', 'inspect'];
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: duplicateDependency }), undefined);
		const unsafeVerification = structuredClone(valid);
		const unsafeFile = unsafeVerification.steps[1].verify?.files[0];
		assert.ok(unsafeFile);
		unsafeFile.path = '.fikeya/state.sqlite3';
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: unsafeVerification }), undefined);
		const unknownVerificationField = structuredClone(valid);
		(unknownVerificationField.steps[1].verify as Record<string, unknown>).runWithoutApproval = true;
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: unknownVerificationField }), undefined);
		const nonFiniteArguments = structuredClone(valid);
		Object.assign(nonFiniteArguments.steps[0].toolCall.arguments, { limit: Number.NaN });
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: nonFiniteArguments }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: { ...valid, title: '🧠'.repeat(1_025) } }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'createPlan', specification: { ...valid, executeNow: true } }), undefined);
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
			parseWebviewMessage({ type: 'refreshStatistics' }),
			parseWebviewMessage({ type: 'refreshMemory' })
		], [
			{ type: 'refreshProviders' },
			{ type: 'testProvider', providerName: 'openrouter-primary' },
			undefined,
			{ type: 'cancelAgent' },
			{ type: 'refreshReceipts' },
			{ type: 'refreshStatistics' },
			{ type: 'refreshMemory' }
		]);
	});
});
