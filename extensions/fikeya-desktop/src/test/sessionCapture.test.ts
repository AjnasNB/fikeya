/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCompletedRunCaptureRequest, FikeyaCompletedRunCaptureInput } from '../sessionCapture';

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;

function completedRun(): FikeyaCompletedRunCaptureInput {
	return {
		extensionPath: 'D:\\fikeya',
		workspacePath: 'D:\\workspace',
		prompt: 'Fix the failing checkout test.',
		profile: {
			name: 'azure-primary',
			kind: 'azure-openai',
			model: 'gpt-coding',
			baseUrl: 'https://example.openai.azure.com',
			credentialType: 'entra-id',
			secretConfigured: false
		},
		turn: {
			sessionId: 'ses_0123456789abcdef',
			callId: 'call_0123456789abcdef',
			providerCallIds: ['call_0123456789abcdef'],
			status: 'completed',
			output: 'The fixture was stale.',
			usage: {
				measurement: 'provider-reported',
				inputTokens: 120,
				outputTokens: 30,
				cachedInputTokens: 20
			},
			memory: {
				status: 'used',
				coverage: 'direct',
				evidenceCount: 3,
				receiptId: `ctx_${'c'.repeat(32)}`,
				responseSha256: hashB
			},
			outcome: {
				plan: 'Inspect the checkout fixture and run its test.',
				summary: 'The fixture was stale.',
				steps: 2,
				toolCalls: [{
					callId: 'tool_0123456789abcdef',
					name: 'run_process',
					status: 'ok',
					outputSha256: hashA,
					durationMs: 410,
					exitCode: 0,
					test: true
				}],
				tests: [{
					callId: 'tool_0123456789abcdef',
					name: 'run_process',
					status: 'ok',
					outputSha256: hashA,
					durationMs: 410,
					exitCode: 0,
					test: true
				}],
				changedFiles: [
					{ path: 'src/checkout.ts', beforeSha256: hashA, afterSha256: hashB },
					{ path: 'src/obsolete.ts', beforeSha256: hashA, afterSha256: null }
				]
			}
		},
		receipts: [{
			apiMode: 'responses',
			cachedInputTokens: 20,
			callId: 'call_0123456789abcdef',
			createdAt: '2026-08-25T10:00:00.000Z',
			durationMs: 830,
			inputTokens: 120,
			model: 'gpt-coding',
			outputTokens: 30,
			provider: 'azure-primary',
			requestBytes: 640,
			requestSha256: hashA,
			responseBytes: 420,
			responseSha256: hashB,
			statusCode: 200,
			usageMeasurement: 'provider-reported'
		}]
	};
}

describe('Fikeya completed-run Qarinah capture', () => {
	test('retains the prompt only for the policy-aware sidecar and carries content-free receipts', () => {
		const request = buildCompletedRunCaptureRequest(completedRun());
		assert.strictEqual(request.prompt, 'Fix the failing checkout test.');
		assert.deepStrictEqual(request.provider, {
			name: 'azure-primary',
			kind: 'azure-openai',
			model: 'gpt-coding'
		});
		assert.strictEqual(request.providerReceipts[0]?.requestSha256, hashA);
		assert.strictEqual(request.providerReceipts[0]?.responseSha256, hashB);
		assert.strictEqual(request.outcome.toolOutcomes[0]?.outputSha256, hashA);
		assert.strictEqual(request.outcome.changedFiles[0]?.afterSha256, hashB);
		assert.strictEqual(request.outcome.changedFiles[1]?.afterSha256, null);
		assert.ok(!JSON.stringify(request.providerReceipts).includes('The fixture was stale.'));
		assert.ok(!JSON.stringify(request.outcome).includes('The fixture was stale.'));
		assert.ok(!Object.hasOwn(request, 'output'));
	});

	test('does not attach a receipt from a different provider or model', () => {
		const input = completedRun();
		const request = buildCompletedRunCaptureRequest({
			...input,
			receipts: input.receipts.map(receipt => ({ ...receipt, provider: 'other-provider' }))
		});
		assert.deepStrictEqual(request.providerReceipts, []);
	});
});
