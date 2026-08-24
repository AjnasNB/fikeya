/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
	buildAgentRunArguments,
	buildFikeyaRuntimeEnvironment,
	buildProviderConfigureArguments,
	parseAgentReceipts,
	parseAgentTurn,
	parseProviderList,
	parseProviderProbe,
	parseRuntimeReport,
	resolveFikeyaCli
} from '../runtime';

describe('Fikeya runtime protocol', () => {
	test('prefers the absolute extension-owned runtime over PATH', async () => {
		const extensionPath = path.join(tmpdir(), `fikeya-desktop-runtime-${process.pid}-${Date.now()}`);
		const runtimeDirectory = path.join(extensionPath, 'runtime');
		await mkdir(runtimeDirectory, { recursive: true });
		await writeFile(path.join(runtimeDirectory, 'fikeya-runtime.exe'), 'fixture', 'utf8');

		assert.deepStrictEqual(resolveFikeyaCli(extensionPath, 'win32'), {
			executable: path.join(runtimeDirectory, 'fikeya-runtime.exe'),
			source: 'bundled'
		});
		assert.deepStrictEqual(resolveFikeyaCli(extensionPath, 'linux'), {
			executable: 'fikeya',
			source: 'path'
		});
	});

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
		const args = buildAgentRunArguments('openrouter-primary', 2048, 12_000, 'auto');
		assert.deepStrictEqual(args.slice(0, 7), ['agent', 'run', '.', '--provider', 'openrouter-primary', '--prompt-stdin', '--allow-network']);
		assert.ok(!args.includes(prompt));
		assert.deepStrictEqual(args.slice(-5), ['--context-max-characters', '12000', '--memory', 'auto', '--json']);
		assert.ok(args.includes('--context-max-characters'));
		assert.ok(args.includes('--json'));
	});

	test('connects the runtime to the extension-owned Qarinah sidecar without mutating the parent environment', async () => {
		const extensionPath = path.join(tmpdir(), `fikeya-desktop-sidecar-${process.pid}-${Date.now()}`);
		const sidecarDirectory = path.join(extensionPath, 'sidecar');
		await mkdir(sidecarDirectory, { recursive: true });
		await writeFile(path.join(sidecarDirectory, 'qarinah-memory-view.mjs'), 'fixture', 'utf8');
		const parentEnvironment: NodeJS.ProcessEnv = { PATH: 'fixed-path' };

		assert.deepStrictEqual(buildFikeyaRuntimeEnvironment(extensionPath, 'C:\\fake\\Code.exe', parentEnvironment), {
			PATH: 'fixed-path',
			FIKEYA_NODE_EXECUTABLE: 'C:\\fake\\Code.exe',
			FIKEYA_QARINAH_SIDECAR: path.join(sidecarDirectory, 'qarinah-memory-view.mjs')
		});
		assert.deepStrictEqual(parentEnvironment, { PATH: 'fixed-path' });
	});

	test('does not invent Qarinah sidecar configuration for source-only installs', () => {
		const parentEnvironment: NodeJS.ProcessEnv = { PATH: 'fixed-path' };
		const result = buildFikeyaRuntimeEnvironment(path.join(tmpdir(), 'missing-fikeya-extension'), 'node', parentEnvironment);
		assert.deepStrictEqual(result, { PATH: 'fixed-path' });
		assert.notStrictEqual(result, parentEnvironment);
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
			},
			memory: {
				coverage: 'direct',
				evidenceCount: 7,
				receiptId: 'ctx_0123456789abcdef0123456789abcdef',
				responseSha256: `sha256:${'c'.repeat(64)}`,
				status: 'used'
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
			},
			memory: {
				coverage: 'direct',
				evidenceCount: 7,
				receiptId: 'ctx_0123456789abcdef0123456789abcdef',
				responseSha256: `sha256:${'c'.repeat(64)}`,
				status: 'used'
			}
		});
	});

	test('parses deliberate memory-free turns without inventing context evidence', () => {
		assert.deepStrictEqual(parseAgentTurn({
			callId: 'call_0123456789abcdef',
			memory: {
				coverage: null,
				evidenceCount: null,
				receiptId: null,
				responseSha256: null,
				status: 'off'
			},
			ok: true,
			output: 'No project context was attached.',
			sessionId: 'ses_0123456789abcdef',
			usage: {
				cachedInputTokens: null,
				inputTokens: null,
				measurement: 'unavailable',
				outputTokens: null
			}
		})?.memory, {
			coverage: null,
			evidenceCount: null,
			receiptId: null,
			responseSha256: null,
			status: 'off'
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
