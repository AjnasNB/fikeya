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
	buildStatisticsArguments,
	parseAgentApproval,
	parseAgentReceipts,
	parseAgentTurn,
	parseProviderList,
	parseProviderProbe,
	parseRuntimeReport,
	parseStatistics,
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

	test('configures Google Gemini through its compatible API without exposing the key', () => {
		const args = buildProviderConfigureArguments({
			name: 'google-gemini-work',
			kind: 'google-gemini',
			model: 'gemini-2.5-pro',
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
			credentialType: 'api-key'
		}, true);

		assert.ok(args.includes('google-gemini'));
		assert.ok(args.includes('--secret-stdin'));
		assert.ok(!args.some(argument => argument.includes('AIza')));
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
		assert.deepStrictEqual(args.slice(0, 7), ['agent', 'execute', '.', '--provider', 'openrouter-primary', '--protocol-stdin', '--allow-network']);
		assert.ok(!args.includes(prompt));
		assert.deepStrictEqual(args.slice(-5), ['--context-max-characters', '12000', '--memory', 'auto', '--json-lines']);
		assert.ok(args.includes('--context-max-characters'));
		assert.ok(args.includes('--json-lines'));
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
		const outcome = {
			changedFiles: [{
				afterSha256: `sha256:${'d'.repeat(64)}`,
				beforeSha256: `sha256:${'b'.repeat(64)}`,
				path: 'src/payment.ts'
			}],
			plan: 'Inspect, edit, and verify the focused behavior.',
			steps: 3,
			summary: 'Updated the focused behavior and its test passed.',
			tests: [{
				callId: 'tool_test',
				durationMs: 140,
				exitCode: 0,
				name: 'process.run',
				outputSha256: `sha256:${'e'.repeat(64)}`,
				status: 'ok',
				test: true
			}],
			toolCalls: [{
				callId: 'tool_test',
				durationMs: 140,
				exitCode: 0,
				name: 'process.run',
				outputSha256: `sha256:${'e'.repeat(64)}`,
				status: 'ok',
				test: true
			}]
		};
		assert.deepStrictEqual(parseAgentTurn({
			callId: 'call_0123456789abcdef',
			ok: true,
			outcome,
			output: outcome.summary,
			providerCallIds: ['call_aaaaaaaaaaaaaaaa', 'call_0123456789abcdef'],
			sessionId: 'ses_0123456789abcdef',
			status: 'completed',
			type: 'result',
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
			outcome,
			output: outcome.summary,
			providerCallIds: ['call_aaaaaaaaaaaaaaaa', 'call_0123456789abcdef'],
			sessionId: 'ses_0123456789abcdef',
			status: 'completed',
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
		const output = 'No project context was attached.';
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
			outcome: {
				changedFiles: [],
				plan: 'Answer without project context.',
				steps: 1,
				summary: output,
				tests: [],
				toolCalls: []
			},
			output,
			providerCallIds: ['call_0123456789abcdef'],
			sessionId: 'ses_0123456789abcdef',
			status: 'completed',
			type: 'result',
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

	test('parses an exact one-use approval request and rejects malformed hashes', () => {
		const request = {
			arguments: { path: 'src/payment.ts' },
			argumentsSha256: 'a'.repeat(64),
			callId: 'tool_read',
			expectedRevision: 3,
			requestId: 'approval_read',
			sessionId: 'ses_0123456789abcdef',
			summary: 'Read src/payment.ts',
			toolName: 'workspace.read_file',
			type: 'approval'
		};
		assert.deepStrictEqual(parseAgentApproval(request), request);
		assert.strictEqual(parseAgentApproval({ ...request, argumentsSha256: 'not-a-hash' }), undefined);
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

	test('builds the content-free local statistics command without network flags', () => {
		assert.deepStrictEqual(buildStatisticsArguments('D:\\workspace'), [
			'stats',
			'--workspace',
			'D:\\workspace',
			'--json'
		]);
	});

	test('parses measured local statistics and provider-model breakdowns', () => {
		const value = {
			ok: true,
			source: 'local-runtime-sqlite',
			measurement: 'provider-reported-only',
			generatedAt: '2026-08-25T07:30:00.000Z',
			sessions: 3,
			providerCalls: 4,
			measuredProviderCalls: 3,
			inputTokens: 1_024,
			cachedInputTokens: 256,
			outputTokens: 512,
			qarinahContextReceipts: 2,
			lastActivity: '2026-08-25T07:29:00.000Z',
			breakdown: [{
				provider: 'azure-primary',
				model: 'gpt-coding',
				calls: 4,
				measuredCalls: 3,
				inputTokens: 1_024,
				cachedInputTokens: 256,
				outputTokens: 512,
				lastActivity: '2026-08-25T07:29:00.000Z'
			}]
		};
		assert.deepStrictEqual(parseStatistics(value), {
			source: value.source,
			measurement: value.measurement,
			generatedAt: value.generatedAt,
			sessions: value.sessions,
			providerCalls: value.providerCalls,
			measuredProviderCalls: value.measuredProviderCalls,
			inputTokens: value.inputTokens,
			cachedInputTokens: value.cachedInputTokens,
			outputTokens: value.outputTokens,
			qarinahContextReceipts: value.qarinahContextReceipts,
			lastActivity: value.lastActivity,
			breakdown: value.breakdown
		});
	});

	test('accepts an honest unavailable-measurement snapshot and rejects inconsistent totals', () => {
		const unavailable = {
			ok: true,
			source: 'local-runtime-sqlite',
			measurement: 'unavailable',
			generatedAt: '2026-08-25T07:30:00+00:00',
			sessions: 1,
			providerCalls: 1,
			measuredProviderCalls: 0,
			inputTokens: null,
			cachedInputTokens: null,
			outputTokens: null,
			qarinahContextReceipts: 0,
			lastActivity: null,
			breakdown: [{
				provider: 'local',
				model: 'unknown',
				calls: 1,
				measuredCalls: 0,
				inputTokens: null,
				cachedInputTokens: null,
				outputTokens: null,
				lastActivity: null
			}]
		};
		assert.ok(parseStatistics(unavailable));
		assert.strictEqual(parseStatistics({ ...unavailable, inputTokens: 0 }), undefined);
		assert.strictEqual(parseStatistics({ ...unavailable, measuredProviderCalls: 1 }), undefined);
		assert.strictEqual(parseStatistics({ ...unavailable, generatedAt: 'not-a-date' }), undefined);
	});

	test('rejects provider metadata and probes outside the bounded schema', () => {
		assert.strictEqual(parseProviderList({ ok: true, providers: [{ name: '../escape' }] }), undefined);
		assert.strictEqual(parseProviderProbe({ ok: true, name: 'provider', statusCode: 200, latencyMs: -1 }), undefined);
	});
});
