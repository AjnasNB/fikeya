/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { initializeQarinahMemory } from '../memory';
import { buildCompletedRunCaptureRequest, captureCompletedFikeyaRuns, FikeyaCompletedRunCaptureInput } from '../sessionCapture';

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
			providerAttemptId: 'evt_provider_attempt_1',
			providerAttemptIds: ['evt_provider_attempt_1'],
			providerAttemptMeasurement: 'exact',
			callId: 'call_0123456789abcdef',
			providerCallIds: ['call_0123456789abcdef'],
			status: 'completed',
			failure: null,
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
				changedFilesScope: 'regular-project-files-v1',
				changedFilesTruncated: false,
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
					{
						path: 'src/checkout.ts', operation: 'edit', beforeExists: true, afterExists: true,
						beforeSha256: hashA, afterSha256: hashB,
						beforeBytes: 120, afterBytes: 142, linesAdded: 4, linesDeleted: 2, lineDeltaStatus: 'exact'
					},
					{
						path: 'src/obsolete.ts', operation: 'delete', beforeExists: true, afterExists: false,
						beforeSha256: hashA, afterSha256: null,
						beforeBytes: 80, afterBytes: null, linesAdded: 0, linesDeleted: 5, lineDeltaStatus: 'exact'
					}
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
	test('serializes concurrent capture batches that share one Qarinah ledger', async () => {
		const inputs = Array.from({ length: 16 }, () => completedRun());
		let inFlight = 0;
		let maximumInFlight = 0;
		let completed = 0;
		const capture = async () => {
			inFlight += 1;
			maximumInFlight = Math.max(maximumInFlight, inFlight);
			await new Promise<void>(resolve => setImmediate(resolve));
			inFlight -= 1;
			completed += 1;
			return { ok: true, failure: 'none' as const };
		};
		const batches = await Promise.all([
			captureCompletedFikeyaRuns(inputs.slice(0, 8), capture),
			captureCompletedFikeyaRuns(inputs.slice(8), capture)
		]);
		const results = batches.flat();
		assert.strictEqual(results.length, 16);
		assert.strictEqual(completed, 16);
		assert.strictEqual(maximumInFlight, 1, 'shared-ledger writers must not contend for Qarinah append locks');
		assert.ok(results.every(result => result.ok));
	});

	test('retains every event from sixteen maximum-outcome advisors in the real pinned ledger', async () => {
		const extensionPath = path.resolve(__dirname, '..', '..');
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-qarinah-advisor-batch-'));
		try {
			const initialized = await initializeQarinahMemory(extensionPath, workspacePath);
			assert.strictEqual(initialized.ok, true);
			const inputs = Array.from({ length: 16 }, (_, advisorIndex): FikeyaCompletedRunCaptureInput => {
				const base = completedRun();
				const suffix = String(advisorIndex).padStart(2, '0');
				const callId = `call_advisor_batch_${suffix}`;
				const attemptId = `evt_advisor_batch_${suffix}`;
				const sessionId = `ses_advisor_batch_${suffix}`;
				const toolCalls = Array.from({ length: 12 }, (_, toolIndex) => ({
					...base.turn.outcome.toolCalls[0]!,
					callId: `tool_advisor_${suffix}_${String(toolIndex).padStart(2, '0')}`
				}));
				return {
					...base,
					extensionPath,
					workspacePath,
					prompt: `advisor ${suffix}`,
					turn: {
						...base.turn,
						sessionId,
						memory: { status: 'off', coverage: null, evidenceCount: null, receiptId: null, responseSha256: null },
						providerAttemptId: attemptId,
						providerAttemptIds: [attemptId],
						callId,
						providerCallIds: [callId],
						outcome: {
							...base.turn.outcome,
							steps: 12,
							toolCalls,
							tests: toolCalls,
							changedFiles: [],
							changedFilesTruncated: false
						}
					},
					receipts: [{ ...base.receipts[0]!, callId }]
				};
			});
			const startedAt = Date.now();
			const results = await captureCompletedFikeyaRuns(inputs);
			const elapsedMilliseconds = Date.now() - startedAt;
			assert.strictEqual(results.length, 16);
			assert.ok(results.every(result => result.ok), JSON.stringify(results));
			assert.ok(elapsedMilliseconds < 120_000, `serialized advisor capture took ${elapsedMilliseconds}ms`);

			const capturedEventIds = results.flatMap(result => result.receipt?.events.map(event => event.eventId) ?? []);
			assert.strictEqual(capturedEventIds.length, 240, 'each advisor must retain prompt, provider, 12 tools, and turn');
			assert.strictEqual(new Set(capturedEventIds).size, 240, 'distinct advisor sessions must produce distinct ledger events');
			const ledgerText = await readFile(path.join(workspacePath, '.qarinah', 'events', 'events.jsonl'), 'utf8');
			assert.ok(ledgerText.trim().split(/\r?\n/u).length >= 240);
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	test('uses one sidecar process for sixteen control-heavy near-limit captures', async () => {
		const extensionPath = await mkdtemp(path.join(tmpdir(), 'fikeya-capture-batch-extension-'));
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-capture-batch-workspace-'));
		const sidecarDirectory = path.join(extensionPath, 'sidecar');
		await mkdir(sidecarDirectory);
		const sidecarPath = path.join(sidecarDirectory, 'qarinah-memory-view.mjs');
		const launchPath = path.join(workspacePath, 'sidecar-launches.txt');
		const fakeSidecar = `
import fs from 'node:fs';
import path from 'node:path';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(process.cwd(), 'sidecar-launches.txt'), 'launch\\n');
  const message = JSON.parse(input);
  const hashA = ${JSON.stringify(hashA)};
  const hashB = ${JSON.stringify(hashB)};
  const hashC = ${JSON.stringify(`sha256:${'c'.repeat(64)}`)};
  const results = message.params.runs.map((run, index) => {
    const prefix = String(index + 1).padStart(8, '0');
    const events = [
      { eventId: 'evt_' + prefix + '-1234-4123-8123-123456789abc', eventHash: hashA, kind: 'prompt.submitted' },
      { eventId: 'evt_' + prefix + '-2234-4123-8123-123456789abc', eventHash: hashB, kind: 'source' },
      { eventId: 'evt_' + prefix + '-3234-4123-8123-123456789abc', eventHash: hashC, kind: run.outcome.status === 'completed' ? 'turn.completed' : 'summary' }
    ];
    return { ok: true, receipt: {
      schemaVersion: 'qarinah.fikeya-run-capture.v1', capture: 'metadata', sessionId: run.sessionId,
      outcomeStatus: run.outcome.status, providerAttemptId: run.providerAttemptId,
      providerAttemptMeasurement: run.providerAttemptMeasurement, providerCallCount: run.providerCallCount,
      providerReceiptCount: run.providerReceiptCount, providerReceiptsCaptured: run.providerReceipts.length,
      providerReceiptsTruncated: run.providerReceiptsTruncated, eventCount: message.params.runs.length * 3,
      capturedTurnHash: hashC, ledgerHeadHash: hashB, graphManifestHash: hashA, events
    } };
  });
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
    schemaVersion: 'qarinah.fikeya-run-capture-batch.v1', results
  } }) + '\\n');
});
`;
		try {
			await writeFile(sidecarPath, fakeSidecar, 'utf8');
			const inputs = Array.from({ length: 16 }, (_, index): FikeyaCompletedRunCaptureInput => {
				const base = completedRun();
				const suffix = String(index).padStart(2, '0');
				const callId = `call_control_heavy_${suffix}`;
				const attemptId = `evt_control_heavy_${suffix}`;
				const changedFiles = Array.from({ length: 32 }, (_, fileIndex) => ({
					path: `src/${suffix}-${String(fileIndex).padStart(2, '0')}-${'\u0002'.repeat(4_070)}`,
					operation: 'add' as const,
					beforeExists: false,
					afterExists: true,
					beforeSha256: null,
					afterSha256: hashA,
					beforeBytes: null,
					afterBytes: 1,
					linesAdded: 1,
					linesDeleted: 0,
					lineDeltaStatus: 'exact' as const
				}));
				return {
					...base,
					extensionPath,
					workspacePath,
					prompt: '\u0001'.repeat(262_144),
					turn: {
						...base.turn,
						sessionId: `ses_control_heavy_${suffix}`,
						providerAttemptId: attemptId,
						providerAttemptIds: [attemptId],
						callId,
						providerCallIds: [callId],
						outcome: { ...base.turn.outcome, changedFiles, changedFilesTruncated: false }
					},
					receipts: [{ ...base.receipts[0]!, callId }]
				};
			});
			const requests = inputs.map(buildCompletedRunCaptureRequest);
			const batchBytes = Buffer.byteLength(JSON.stringify({
				jsonrpc: '2.0', id: 'fikeya-memory-capture-runs', method: 'memory.captureRuns', params: { runs: requests }
			}), 'utf8');
			assert.ok(batchBytes > 1024 * 1024 && batchBytes <= 16 * 1024 * 1024, `batch body was ${batchBytes} bytes`);

			const results = await captureCompletedFikeyaRuns(inputs);
			assert.strictEqual(results.length, 16);
			assert.ok(results.every(result => result.ok), JSON.stringify(results));
			assert.strictEqual((await readFile(launchPath, 'utf8')).trim().split(/\r?\n/u).length, 1);
		} finally {
			await rm(extensionPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	test('retains the prompt only for the policy-aware sidecar and carries content-free receipts', () => {
		const request = buildCompletedRunCaptureRequest(completedRun());
		assert.strictEqual(request.providerAttemptId, 'evt_provider_attempt_1');
		assert.strictEqual(request.providerAttemptMeasurement, 'exact');
		assert.strictEqual(request.prompt, 'Fix the failing checkout test.');
		assert.strictEqual(request.promptBytes, 30);
		assert.strictEqual(request.promptTruncated, false);
		assert.match(request.promptSha256, /^sha256:[0-9a-f]{64}$/);
		assert.deepStrictEqual(request.provider, {
			name: 'azure-primary',
			kind: 'azure-openai',
			model: 'gpt-coding'
		});
		assert.strictEqual(request.providerReceipts[0]?.requestSha256, hashA);
		assert.strictEqual(request.providerReceipts[0]?.responseSha256, hashB);
		assert.strictEqual(request.outcome.toolOutcomes[0]?.outputSha256, hashA);
		assert.strictEqual(request.outcome.changedFiles[0]?.afterSha256, hashB);
		assert.strictEqual(request.outcome.changedFiles[0]?.operation, 'edit');
		assert.strictEqual(request.outcome.changedFiles[0]?.linesAdded, 4);
		assert.strictEqual(request.outcome.changedFiles[0]?.linesDeleted, 2);
		assert.strictEqual(request.outcome.changedFiles[1]?.afterSha256, null);
		assert.strictEqual(request.outcome.terminalFailure, null);
		assert.strictEqual(request.outcome.changedFilesTruncated, false);
		assert.strictEqual(request.providerCallCount, 1);
		assert.strictEqual(request.providerReceiptCount, 1);
		assert.strictEqual(request.providerReceiptsTruncated, false);
		assert.ok(!JSON.stringify(request.providerReceipts).includes('The fixture was stale.'));
		assert.ok(!JSON.stringify(request.outcome).includes('The fixture was stale.'));
		assert.ok(!Object.hasOwn(request, 'output'));
	});

	test('retains strict quota and authentication failure classifications without message content', () => {
		const input = completedRun();
		for (const terminalFailure of [
			{ kind: 'quota' as const, retryable: true, statusCode: 429 },
			{ kind: 'authentication' as const, retryable: false, statusCode: 401 }
		]) {
			const request = buildCompletedRunCaptureRequest({
				...input,
				turn: { ...input.turn, status: 'failed', failure: terminalFailure }
			});
			assert.deepStrictEqual(request.outcome.terminalFailure, terminalFailure);
			assert.ok(!JSON.stringify(request.outcome.terminalFailure).includes(input.turn.output));
		}
	});

	test('preserves an upstream changed-file truncation signal', () => {
		const input = completedRun();
		const request = buildCompletedRunCaptureRequest({
			...input,
			turn: {
				...input.turn,
				outcome: { ...input.turn.outcome, changedFilesTruncated: true }
			}
		});
		assert.strictEqual(request.outcome.changedFileCount, 2);
		assert.strictEqual(request.outcome.changedFilesTruncated, true);
	});

	test('does not attach a receipt from a different provider or model', () => {
		const input = completedRun();
		const request = buildCompletedRunCaptureRequest({
			...input,
			receipts: input.receipts.map(receipt => ({ ...receipt, provider: 'other-provider' }))
		});
		assert.deepStrictEqual(request.providerReceipts, []);
		assert.strictEqual(request.providerCallCount, 1);
		assert.strictEqual(request.providerReceiptCount, 1);
		assert.strictEqual(request.providerReceiptsTruncated, true);
	});

	test('counts attempted requests independently from completed receipt IDs', () => {
		const input = completedRun();
		const request = buildCompletedRunCaptureRequest({
			...input,
			turn: {
				...input.turn,
				providerAttemptId: 'evt_provider_attempt_3',
				providerAttemptIds: [
					'evt_provider_attempt_1',
					'evt_provider_attempt_2',
					'evt_provider_attempt_3'
				],
				callId: 'call_2',
				providerCallIds: ['call_1', 'call_2'],
				status: 'failed',
				failure: { kind: 'runtime', retryable: false, statusCode: null }
			},
			receipts: [
				{ ...input.receipts[0], callId: 'call_1' },
				{ ...input.receipts[0], callId: 'call_2' }
			]
		});

		assert.strictEqual(request.providerAttemptId, 'evt_provider_attempt_3');
		assert.strictEqual(request.providerCallCount, 3);
		assert.strictEqual(request.providerReceiptCount, 2);
		assert.strictEqual(request.providerReceipts.length, 2);
		assert.strictEqual(request.providerReceiptsTruncated, false);
		assert.strictEqual(request.outcome.status, 'failed');
	});

	test('preserves a pending-request cancellation as one attempt and zero receipts', () => {
		const input = completedRun();
		const request = buildCompletedRunCaptureRequest({
			...input,
			receipts: [],
			turn: {
				...input.turn,
				providerAttemptId: 'evt_pending_request',
				providerAttemptIds: ['evt_pending_request'],
				callId: null,
				providerCallIds: [],
				status: 'cancelled'
			}
		});

		assert.strictEqual(request.providerAttemptId, 'evt_pending_request');
		assert.strictEqual(request.callId, null);
		assert.strictEqual(request.providerCallCount, 1);
		assert.strictEqual(request.providerReceiptCount, 0);
		assert.deepStrictEqual(request.providerReceipts, []);
	});

	test('distinguishes missing provider receipts from bounded retained receipts', () => {
		const input = completedRun();
		const callIds = Array.from({ length: 17 }, (_, index) => `call_${String(index).padStart(16, '0')}`);
		const attemptIds = Array.from({ length: 17 }, (_, index) => `evt_attempt_${String(index).padStart(16, '0')}`);
		const receipts = callIds.map((callId, index) => ({
			...input.receipts[0],
			callId,
			createdAt: `2026-08-25T10:00:${String(index).padStart(2, '0')}.000Z`
		}));
		const request = buildCompletedRunCaptureRequest({
			...input,
			turn: {
				...input.turn,
				providerAttemptId: attemptIds.at(-1)!,
				providerAttemptIds: attemptIds,
				callId: callIds.at(-1)!,
				providerCallIds: callIds
			},
			receipts
		});
		assert.strictEqual(request.providerCallCount, 17);
		assert.strictEqual(request.providerReceiptCount, 17);
		assert.strictEqual(request.providerReceipts.length, 16);
		assert.strictEqual(request.providerReceiptsTruncated, true);
		assert.strictEqual(request.providerReceipts[0]?.callId, callIds[1]);
	});

	test('preserves a cancelled terminal status for partial evidence', () => {
		const input = completedRun();
		const request = buildCompletedRunCaptureRequest({
			...input,
			turn: { ...input.turn, status: 'cancelled' }
		});
		assert.strictEqual(request.outcome.status, 'cancelled');
	});

	test('preserves the exact absence of a provider call on early cancellation', () => {
		const input = completedRun();
		const request = buildCompletedRunCaptureRequest({
			...input,
			receipts: [],
			turn: {
				...input.turn,
				providerAttemptId: null,
				providerAttemptIds: [],
				callId: null,
				providerCallIds: [],
				status: 'cancelled'
			}
		});
		assert.strictEqual(request.callId, null);
		assert.strictEqual(request.providerCallCount, 0);
		assert.strictEqual(request.providerReceiptCount, 0);
		assert.deepStrictEqual(request.providerReceipts, []);
	});

	test('fits the fully serialized capture line with control-heavy prompt and paths', () => {
		const input = completedRun();
		const prompt = '\u0001'.repeat(262_144);
		const changedFiles = Array.from({ length: 32 }, (_, index) => ({
			path: `src/${String(index).padStart(2, '0')}-${'\u0002'.repeat(4_080)}`,
			operation: 'add' as const,
			beforeExists: false,
			afterExists: true,
			beforeSha256: null,
			afterSha256: hashA,
			beforeBytes: null,
			afterBytes: 1,
			linesAdded: 1,
			linesDeleted: 0,
			lineDeltaStatus: 'exact' as const
		}));
		const request = buildCompletedRunCaptureRequest({
			...input,
			prompt,
			turn: { ...input.turn, outcome: { ...input.turn.outcome, changedFiles } }
		});
		const line = JSON.stringify({
			jsonrpc: '2.0', id: 'fikeya-memory-capture-run', method: 'memory.captureRun', params: request
		});

		assert.ok(Buffer.byteLength(line, 'utf8') <= 1024 * 1024);
		assert.strictEqual(request.promptBytes, 262_144);
		assert.strictEqual(request.promptTruncated, true);
		assert.ok(Buffer.byteLength(request.prompt, 'utf8') <= 16_000);
		assert.strictEqual(request.outcome.changedFileCount, 32);
		assert.strictEqual(
			request.outcome.changedFilesTruncated,
			request.outcome.changedFiles.length !== 32
		);
	});
});
