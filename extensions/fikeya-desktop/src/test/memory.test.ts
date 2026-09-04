/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { captureQarinahRun, FikeyaMemoryRunCaptureRequest, initializeQarinahMemory, parseMemoryInitializationSidecarResponse, parseMemoryRecordSidecarResponse, parseMemoryRunCaptureBatchSidecarResponse, parseMemoryRunCaptureSidecarResponse, parseMemorySidecarResponse, parseMemorySnapshot, resolveQarinahSidecarPath } from '../memory';

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const hashC = `sha256:${'c'.repeat(64)}`;

function memoryView(): Record<string, unknown> {
	return {
		schemaVersion: 'qarinah.developer-memory-view.v1',
		generatedAt: '2026-08-24T10:00:00.000Z',
		manifestHash: hashA,
		workspace: {
			name: 'fikeya',
			eventCount: 42,
			ledgerHeadHash: hashB
		},
		graph: {
			manifestHash: hashC,
			nodes: [
				{
					id: 'memory:decision',
					type: 'memory',
					kind: 'decision',
					label: 'Keep prompts on stdin',
					path: null,
					status: 'current',
					conflicted: false,
					importance: 0.9,
					incoming: 0,
					outgoing: 1,
					sourceEventId: 'evt_example',
					evidenceHash: hashA,
					contentHash: null,
					terms: ['stdin', 'prompt']
				},
				{
					id: 'file:runtime',
					type: 'file',
					kind: 'source',
					label: 'runtime.ts',
					path: 'extensions/fikeya-desktop/src/runtime.ts',
					status: 'current',
					conflicted: false,
					importance: 0.7,
					incoming: 1,
					outgoing: 0,
					sourceEventId: null,
					evidenceHash: null,
					contentHash: hashB,
					terms: ['runtime']
				}
			],
			edges: [{ source: 'memory:decision', target: 'file:runtime', type: 'affects', weight: 0.8 }]
		}
	};
}

describe('Fikeya Qarinah memory bridge', () => {
	test('prefers the compact extension-owned Qarinah view adapter', () => {
		const extensionPath = path.resolve(__dirname, '..', '..');
		assert.strictEqual(resolveQarinahSidecarPath(extensionPath), path.join(extensionPath, 'sidecar', 'qarinah-memory-view.mjs'));
	});

	test('accepts a bounded cited graph projection', () => {
		const parsed = parseMemorySnapshot(memoryView());
		assert.strictEqual(parsed?.workspaceName, 'fikeya');
		assert.strictEqual(parsed?.nodes.length, 2);
		assert.strictEqual(parsed?.edges[0].type, 'affects');
		assert.strictEqual(parsed?.nodes[0].evidenceHash, hashA);
	});

	test('accepts only the expected JSON-RPC response identity', () => {
		const line = JSON.stringify({ jsonrpc: '2.0', id: 'fikeya-memory-view', result: memoryView() });
		assert.strictEqual(parseMemorySidecarResponse(line)?.eventCount, 42);
		assert.strictEqual(parseMemorySidecarResponse(JSON.stringify({ jsonrpc: '2.0', id: 'other', result: memoryView() })), undefined);
	});

	test('accepts a bounded Qarinah initialization receipt', () => {
		const line = JSON.stringify({
			jsonrpc: '2.0',
			id: 'fikeya-memory-init',
			result: {
				schemaVersion: 'qarinah.workspace-initialization.v1',
				workspaceId: `ws_${'a'.repeat(32)}`,
				capture: 'metadata'
			}
		});
		assert.deepStrictEqual(parseMemoryInitializationSidecarResponse(line), {
			workspaceId: `ws_${'a'.repeat(32)}`,
			capture: 'metadata'
		});
		assert.strictEqual(parseMemoryInitializationSidecarResponse(line.replace('metadata', 'all')), undefined);
	});

	test('accepts a content-free Qarinah record receipt', () => {
		const line = JSON.stringify({
			jsonrpc: '2.0',
			id: 'fikeya-memory-record',
			result: {
				schemaVersion: 'qarinah.memory-record.v1',
				eventId: 'evt_12345678-1234-4123-8123-123456789abc',
				eventHash: hashA,
				kind: 'decision'
			}
		});
		assert.deepStrictEqual(parseMemoryRecordSidecarResponse(line), {
			eventId: 'evt_12345678-1234-4123-8123-123456789abc',
			eventHash: hashA,
			kind: 'decision'
		});
		assert.strictEqual(parseMemoryRecordSidecarResponse(line.replace('decision', 'arbitrary')), undefined);
	});

	test('validates the captured turn independently from a concurrently advanced ledger head', () => {
			const promptId = 'evt_12345678-1234-4123-8123-123456789abc';
			const providerId = 'evt_22345678-1234-4123-8123-123456789abc';
			const turnId = 'evt_32345678-1234-4123-8123-123456789abc';
			const message = {
				jsonrpc: '2.0',
				id: 'fikeya-memory-capture-run',
				result: {
					schemaVersion: 'qarinah.fikeya-run-capture.v1',
					capture: 'content',
					sessionId: 'ses_parser_single',
					outcomeStatus: 'completed',
					providerAttemptId: 'evt_provider_attempt',
					providerAttemptMeasurement: 'exact',
					providerCallCount: 1,
					providerReceiptCount: 1,
					providerReceiptsCaptured: 1,
					providerReceiptsTruncated: false,
					eventCount: 9,
					capturedTurnHash: hashC,
					ledgerHeadHash: hashB,
					graphManifestHash: hashA,
					events: [
					{ eventId: promptId, eventHash: hashA, kind: 'prompt.submitted' },
					{ eventId: providerId, eventHash: hashB, kind: 'source' },
					{ eventId: turnId, eventHash: hashC, kind: 'turn.completed' }
					]
				}
			};
			const receipt = parseMemoryRunCaptureSidecarResponse(JSON.stringify(message));
			assert.strictEqual(receipt?.eventCount, 9);
			assert.strictEqual(receipt?.providerAttemptId, 'evt_provider_attempt');
			assert.strictEqual(receipt?.capturedTurnHash, hashC);
			assert.strictEqual(receipt?.ledgerHeadHash, hashB);
			assert.strictEqual(parseMemoryRunCaptureSidecarResponse(JSON.stringify({
				...message,
				result: { ...message.result, capturedTurnHash: hashB }
			})), undefined);
			assert.strictEqual(parseMemoryRunCaptureSidecarResponse(JSON.stringify({
				...message,
				result: { ...message.result, ledgerHeadHash: 'not-a-hash' }
			})), undefined);
		});

	test('binds ordered batch receipts to every request and one shared projection', () => {
		const promptId = 'evt_12345678-1234-4123-8123-123456789abc';
		const providerId = 'evt_22345678-1234-4123-8123-123456789abc';
		const turnId = 'evt_32345678-1234-4123-8123-123456789abc';
		const receipt = {
			schemaVersion: 'qarinah.fikeya-run-capture.v1',
			capture: 'metadata',
			sessionId: 'ses_batch_1',
			outcomeStatus: 'completed',
			providerAttemptId: 'evt_provider_attempt_1',
			providerAttemptMeasurement: 'exact',
			providerCallCount: 1,
			providerReceiptCount: 1,
			providerReceiptsCaptured: 1,
			providerReceiptsTruncated: false,
			eventCount: 30,
			capturedTurnHash: hashC,
			ledgerHeadHash: hashB,
			graphManifestHash: hashA,
			events: [
				{ eventId: promptId, eventHash: hashA, kind: 'prompt.submitted' },
				{ eventId: providerId, eventHash: hashB, kind: 'source' },
				{ eventId: turnId, eventHash: hashC, kind: 'turn.completed' }
			]
		};
		const request = {
			sessionId: 'ses_batch_1',
			providerAttemptId: 'evt_provider_attempt_1',
			providerAttemptMeasurement: 'exact',
			providerCallCount: 1,
			providerReceiptCount: 1,
			providerReceipts: [{}],
			providerReceiptsTruncated: false,
			outcome: { status: 'completed' }
		} as unknown as FikeyaMemoryRunCaptureRequest;
		const secondRequest = {
			...request,
			sessionId: 'ses_batch_2',
			providerAttemptId: 'evt_provider_attempt_2'
		};
		const secondReceipt = {
			...receipt,
			sessionId: 'ses_batch_2',
			providerAttemptId: 'evt_provider_attempt_2'
		};
		const line = (results: readonly unknown[]) => JSON.stringify({
			jsonrpc: '2.0',
			id: 'fikeya-memory-capture-runs',
			result: { schemaVersion: 'qarinah.fikeya-run-capture-batch.v1', results }
		});

		const parsed = parseMemoryRunCaptureBatchSidecarResponse(
			line([{ ok: true, receipt }, { ok: true, receipt: secondReceipt }]),
			[request, secondRequest]
		);
		assert.strictEqual(parsed?.results.length, 2);
		assert.strictEqual(parsed?.results.every(result => result.ok), true);
		assert.strictEqual(parseMemoryRunCaptureBatchSidecarResponse(line([]), []), undefined);
		assert.strictEqual(parseMemoryRunCaptureBatchSidecarResponse(
			line([{ ok: true, receipt }, { ok: true, receipt: secondReceipt }]),
			[request]
		), undefined);
		assert.strictEqual(parseMemoryRunCaptureBatchSidecarResponse(
			line([{ ok: true, receipt: secondReceipt }, { ok: true, receipt }]),
			[request, secondRequest]
		), undefined);
		assert.strictEqual(parseMemoryRunCaptureBatchSidecarResponse(
			line([
				{ ok: true, receipt },
				{ ok: true, receipt: { ...secondReceipt, graphManifestHash: hashB } }
			]),
			[request, secondRequest]
		), undefined);
		const mixed = parseMemoryRunCaptureBatchSidecarResponse(
			line([{ ok: true, receipt }, { ok: false }]),
			[request, secondRequest]
		);
		assert.strictEqual(mixed?.results[1]?.failure, 'invalid-response');
	});

	test('runs the real pinned sidecar and rejects contradictory change evidence', async () => {
		const extensionPath = path.resolve(__dirname, '..', '..');
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-qarinah-sidecar-'));
		const request: FikeyaMemoryRunCaptureRequest = {
			sessionId: 'ses_sidecar_integration',
			providerAttemptId: null,
			providerAttemptMeasurement: 'unavailable',
			callId: null,
			prompt: 'Capture the measured file change.',
			promptSha256: `sha256:${createHash('sha256').update('Capture the measured file change.', 'utf8').digest('hex')}`,
			promptBytes: Buffer.byteLength('Capture the measured file change.', 'utf8'),
			promptTruncated: false,
			provider: { name: 'local', kind: 'openai-compatible', model: 'test-model' },
			usage: { measurement: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null },
			memory: { status: 'off', coverage: null, evidenceCount: null, receiptId: null, responseSha256: null },
			providerReceipts: [],
			providerCallCount: 0,
			providerReceiptCount: 0,
			providerReceiptsTruncated: false,
			outcome: {
				status: 'cancelled',
				terminalFailure: null,
				changedFilesScope: 'regular-project-files-v1',
				steps: 2,
				planSha256: hashA,
				summarySha256: hashB,
				toolOutcomeCount: 0,
				toolOutcomesTruncated: false,
				toolOutcomes: [],
				changedFileCount: 1,
				changedFilesTruncated: true,
				changedFiles: [{
					path: 'src/large.bin', operation: 'edit', beforeExists: true, afterExists: true,
					beforeSha256: null, afterSha256: hashC,
					beforeBytes: 16_777_217, afterBytes: 8, linesAdded: null, linesDeleted: null, lineDeltaStatus: 'too-large'
				}]
			}
		};
		try {
			const initialized = await initializeQarinahMemory(extensionPath, workspacePath);
			assert.strictEqual(initialized.ok, true);
			const captured = await captureQarinahRun(extensionPath, workspacePath, request);
			assert.strictEqual(captured.ok, true);
			assert.strictEqual(captured.receipt?.outcomeStatus, 'cancelled');
			assert.strictEqual(captured.receipt?.events.at(-1)?.kind, 'summary');
			assert.strictEqual(captured.receipt?.providerAttemptId, null);
			assert.strictEqual(captured.receipt?.providerCallCount, 0);
			assert.strictEqual(captured.receipt?.providerReceiptCount, 0);
			const impossibleExactZeroAttempt = await captureQarinahRun(extensionPath, workspacePath, {
				...request,
				sessionId: 'ses_sidecar_impossible_exact_zero',
				providerAttemptMeasurement: 'exact'
			});
			assert.strictEqual(impossibleExactZeroAttempt.ok, false);
			const impossibleCompletedWithoutReceipt = await captureQarinahRun(extensionPath, workspacePath, {
				...request,
				sessionId: 'ses_sidecar_impossible_completed',
				outcome: { ...request.outcome, status: 'completed', terminalFailure: null }
			});
			assert.strictEqual(impossibleCompletedWithoutReceipt.ok, false);
			const ledger = await readFile(path.join(workspacePath, '.qarinah', 'events', 'events.jsonl'), 'utf8');
			assert.ok(ledger.trim().split(/\r?\n/u).length >= 3);
			assert.ok(!ledger.includes('pre_ses_sidecar_integration'));
			const initialFailure = await captureQarinahRun(extensionPath, workspacePath, {
				...request,
				sessionId: 'ses_sidecar_initial_failure',
				providerAttemptId: 'evt_initial_provider_failure',
				providerAttemptMeasurement: 'exact',
				providerCallCount: 1,
				outcome: {
					...request.outcome,
					status: 'failed',
					terminalFailure: { kind: 'connectivity', retryable: true, statusCode: null },
					steps: 1
				}
			});
			assert.strictEqual(initialFailure.ok, true);
			assert.strictEqual(initialFailure.receipt?.providerAttemptId, 'evt_initial_provider_failure');
			assert.strictEqual(initialFailure.receipt?.providerCallCount, 1);
			assert.strictEqual(initialFailure.receipt?.providerReceiptCount, 0);
			const pendingCancellation = await captureQarinahRun(extensionPath, workspacePath, {
				...request,
				sessionId: 'ses_sidecar_pending_cancellation',
				providerAttemptId: 'evt_pending_provider_request',
				providerAttemptMeasurement: 'exact',
				providerCallCount: 1,
				outcome: {
					...request.outcome,
					status: 'cancelled',
					steps: 1
				}
			});
			assert.strictEqual(pendingCancellation.ok, true);
			assert.strictEqual(pendingCancellation.receipt?.providerAttemptId, 'evt_pending_provider_request');
			assert.strictEqual(pendingCancellation.receipt?.providerAttemptMeasurement, 'exact');
			assert.strictEqual(pendingCancellation.receipt?.providerCallCount, 1);
			assert.strictEqual(pendingCancellation.receipt?.providerReceiptCount, 0);
			const sidecarSource = await readFile(path.join(extensionPath, 'sidecar', 'qarinah-memory-view.mjs'), 'utf8');
			assert.match(sidecarSource, /providerCallOccurred: providerAttemptMeasurement === 'unavailable' \? null : providerAttemptId !== null/u);
			const fabricatedCall = await captureQarinahRun(extensionPath, workspacePath, {
				...request,
				callId: 'pre_ses_sidecar_integration'
			});
			assert.strictEqual(fabricatedCall.ok, false);

			const contradictory = {
				...request,
				outcome: {
					...request.outcome,
					changedFilesTruncated: false,
					changedFiles: [{
						...request.outcome.changedFiles[0],
						operation: 'add' as const,
						beforeBytes: 4
					}]
				}
			};
			const rejected = await captureQarinahRun(extensionPath, workspacePath, contradictory);
			assert.strictEqual(rejected.ok, false);
			assert.notStrictEqual(rejected.failure, 'none');
			const contradictoryFailure = await captureQarinahRun(extensionPath, workspacePath, {
				...request,
				sessionId: 'ses_sidecar_contradictory_failure',
				providerAttemptId: 'evt_sidecar_contradictory_failure',
				providerAttemptMeasurement: 'exact',
				providerCallCount: 1,
				outcome: {
					...request.outcome,
					status: 'failed',
					terminalFailure: { kind: 'quota', retryable: false, statusCode: 429 }
				}
			});
			assert.strictEqual(contradictoryFailure.ok, false);
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	test('absorbs an early stdin close and does not resolve before the sidecar exits', async () => {
		const extensionPath = await mkdtemp(path.join(tmpdir(), 'fikeya-sidecar-lifecycle-'));
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-sidecar-workspace-'));
		const sidecarDirectory = path.join(extensionPath, 'sidecar');
		await mkdir(sidecarDirectory);
		const sidecarPath = path.join(sidecarDirectory, 'qarinah-memory-view.mjs');
		const oversizedRequest = { padding: 'x'.repeat(900_000) } as unknown as FikeyaMemoryRunCaptureRequest;
		try {
			await writeFile(sidecarPath, 'process.exit(0);\n', 'utf8');
			const earlyExit = await captureQarinahRun(extensionPath, workspacePath, oversizedRequest);
			assert.strictEqual(earlyExit.ok, false);
			assert.strictEqual(earlyExit.failure, 'process-error');

			await writeFile(sidecarPath, [
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => { input += chunk; });",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');",
				"  setTimeout(() => process.exit(0), 180);",
				"});"
			].join('\n'), 'utf8');
			const startedAt = Date.now();
			const delayedExit = await captureQarinahRun(extensionPath, workspacePath, {} as FikeyaMemoryRunCaptureRequest);
			assert.strictEqual(delayedExit.ok, false);
			assert.strictEqual(delayedExit.failure, 'invalid-response');
			assert.ok(Date.now() - startedAt >= 150, 'the queue boundary must wait for child close');

			await writeFile(sidecarPath, [
				"process.stdin.resume();",
				"process.stdin.on('end', () => {",
				"  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'fikeya-memory-init', result: { schemaVersion: 'qarinah.workspace-initialization.v1', workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', capture: 'metadata' } }) + '\\n');",
				"  setInterval(() => undefined, 1000);",
				"});"
			].join('\n'), 'utf8');
			const hangingStartedAt = Date.now();
			const hangingAfterResponse = await initializeQarinahMemory(extensionPath, workspacePath);
			const hangingElapsed = Date.now() - hangingStartedAt;
			assert.strictEqual(hangingAfterResponse.ok, true);
			assert.ok(hangingElapsed >= 1_800 && hangingElapsed < 6_000, `post-response close bound took ${hangingElapsed}ms`);
		} finally {
			await rm(extensionPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	test('rejects edges that reference nodes outside the bounded projection', () => {
		const value = memoryView();
		const graph = value.graph as { edges: unknown[] };
		graph.edges = [{ source: 'memory:decision', target: 'file:missing', type: 'affects', weight: 1 }];
		assert.strictEqual(parseMemorySnapshot(value), undefined);
	});

	test('rejects malformed provenance hashes and oversized node sets', () => {
		const malformed = memoryView();
		(malformed.graph as { manifestHash: string }).manifestHash = 'not-a-hash';
		assert.strictEqual(parseMemorySnapshot(malformed), undefined);

		const oversized = memoryView();
		const graph = oversized.graph as { nodes: unknown[] };
		graph.nodes = Array.from({ length: 201 }, () => graph.nodes[0]);
		assert.strictEqual(parseMemorySnapshot(oversized), undefined);
	});
});
