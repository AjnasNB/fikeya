/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	buildAgentRunArguments,
	buildProviderConfigureArguments,
	parseAgentReceipts,
	parseAgentTurn,
	parseProviderList,
	parseProviderProbe,
	parseRuntimeReport
} from '../runtime';

describe('Fikeya runtime protocol', () => {
	test('parses the actual init response shape', () => {
		assert.deepStrictEqual(parseRuntimeReport({
			created: true,
			message: 'Initialized Fikeya workspace.',
			ok: true,
			root: 'D:\\workspace',
			workspaceId: 'ws_example'
		}, 'init'), {
			status: 'initialized',
			initialized: true,
			workspaceId: 'ws_example'
		});
	});

	test('derives workspace, Qarinah, and provider status from doctor checks', () => {
		assert.deepStrictEqual(parseRuntimeReport({
			ok: true,
			checks: [
				{ name: 'workspace', ok: true, detail: 'ws_example' },
				{ name: 'provider-metadata', ok: true, detail: '7 configured' },
				{ name: 'qarinah', ok: false, optional: true, detail: 'optional CLI not found' }
			]
		}, 'doctor'), {
			status: 'ready',
			initialized: true,
			workspaceId: 'ws_example',
			qarinah: 'optional CLI not found',
			providerCount: 7
		});
	});

	test('never places provider credential bytes in process arguments', () => {
		const secret = 'credential-must-remain-on-stdin';
		const args = buildProviderConfigureArguments({
			name: 'openrouter-primary',
			kind: 'openrouter',
			model: 'example/model',
			baseUrl: 'https://openrouter.ai/api/v1',
			credentialType: 'bearer'
		}, true);

		assert.ok(args.includes('--secret-stdin'));
		assert.ok(args.includes('--json'));
		assert.ok(!args.includes(secret));
		assert.ok(!args.some(argument => /api[-_]?key|credential-must-remain/i.test(argument)));
	});

	test('omits secret stdin for credential-free local providers', () => {
		const args = buildProviderConfigureArguments({
			name: 'ollama-local',
			kind: 'ollama',
			model: 'qwen3',
			baseUrl: 'http://127.0.0.1:11434',
			credentialType: 'none'
		}, false);

		assert.ok(!args.includes('--secret-stdin'));
	});

	test('configures Azure Entra ID without a credential payload', () => {
		const args = buildProviderConfigureArguments({
			name: 'azure-production',
			kind: 'azure-openai',
			model: 'coding-deployment',
			baseUrl: 'https://example.openai.azure.com',
			credentialType: 'entra-id'
		}, false);

		assert.deepStrictEqual(args.slice(-3), ['--credential-type', 'entra-id', '--json']);
		assert.ok(!args.includes('--secret-stdin'));
	});

	test('parses live provider profiles without credential bytes', () => {
		assert.deepStrictEqual(parseProviderList({
			ok: true,
			providers: [{
				baseUrl: 'https://example.openai.azure.com',
				credentialType: 'entra-id',
				kind: 'azure-openai',
				model: 'coding-deployment',
				name: 'azure-primary',
				secretConfigured: false
			}]
		}), [{
			baseUrl: 'https://example.openai.azure.com',
			credentialType: 'entra-id',
			kind: 'azure-openai',
			model: 'coding-deployment',
			name: 'azure-primary',
			secretConfigured: false
		}]);
	});

	test('keeps prompt content out of agent process arguments', () => {
		const prompt = 'private prompt content';
		const args = buildAgentRunArguments('openrouter-primary', 2048);
		assert.deepStrictEqual(args.slice(0, 7), ['agent', 'run', '.', '--provider', 'openrouter-primary', '--prompt-stdin', '--allow-network']);
		assert.ok(!args.includes(prompt));
		assert.ok(args.includes('--json'));
	});

	test('parses completed turns and exact provider-reported usage', () => {
		assert.deepStrictEqual(parseAgentTurn({
			callId: 'call_0123456789abcdef',
			ok: true,
			output: 'The test fails because the fixture is stale.',
			sessionId: 'ses_0123456789abcdef',
			usage: {
				cachedInputTokens: 32,
				inputTokens: 128,
				measurement: 'provider-reported',
				outputTokens: 64
			}
		}), {
			callId: 'call_0123456789abcdef',
			output: 'The test fails because the fixture is stale.',
			sessionId: 'ses_0123456789abcdef',
			usage: {
				cachedInputTokens: 32,
				inputTokens: 128,
				measurement: 'provider-reported',
				outputTokens: 64
			}
		});
	});

	test('parses content-free call receipts with provenance hashes', () => {
		const hashA = `sha256:${'a'.repeat(64)}`;
		const hashB = `sha256:${'b'.repeat(64)}`;
		assert.deepStrictEqual(parseAgentReceipts({
			ok: true,
			receipts: [{
				apiMode: 'responses',
				cachedInputTokens: 32,
				callId: 'call_0123456789abcdef',
				createdAt: '2026-08-24T10:00:00.000Z',
				durationMs: 412,
				inputTokens: 128,
				model: 'coding-deployment',
				outputTokens: 64,
				provider: 'azure-primary',
				requestBytes: 700,
				requestSha256: hashA,
				responseBytes: 900,
				responseSha256: hashB,
				statusCode: 200,
				usageMeasurement: 'provider-reported'
			}],
			sessionId: 'ses_0123456789abcdef'
		})?.[0], {
			apiMode: 'responses',
			cachedInputTokens: 32,
			callId: 'call_0123456789abcdef',
			createdAt: '2026-08-24T10:00:00.000Z',
			durationMs: 412,
			inputTokens: 128,
			model: 'coding-deployment',
			outputTokens: 64,
			provider: 'azure-primary',
			requestBytes: 700,
			requestSha256: hashA,
			responseBytes: 900,
			responseSha256: hashB,
			statusCode: 200,
			usageMeasurement: 'provider-reported'
		});
	});

	test('rejects provider metadata and probes outside the bounded schema', () => {
		assert.strictEqual(parseProviderList({ ok: true, providers: [{ name: '../escape' }] }), undefined);
		assert.strictEqual(parseProviderProbe({ ok: true, name: 'provider', statusCode: 200, latencyMs: -1 }), undefined);
	});
});
