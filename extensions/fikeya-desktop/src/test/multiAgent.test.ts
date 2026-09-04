/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FikeyaAgentProfile } from '../agentProfiles';
import {
	FikeyaMultiAgentDependencies,
	isFikeyaAdvisoryToolAllowed,
	startFikeyaMultiAgentRun
} from '../multiAgent';
import type {
	FikeyaAgentApprovalDecision,
	FikeyaAgentRunHandle,
	FikeyaAgentTurn,
	FikeyaCliResult,
	FikeyaProviderReceipt
} from '../runtime';

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>(resolve => resolvePromise = resolve);
	return { promise, resolve: resolvePromise };
}

function profile(id: string): FikeyaAgentProfile {
	return {
		schemaVersion: 1,
		id,
		displayName: `Agent ${id}`,
		providerName: `provider-${id}`,
		role: 'custom',
		instruction: `Handle the ${id} concern independently.`,
		maxOutputTokens: 1_024,
		contextMaxCharacters: 12_000,
		memoryMode: 'auto'
	};
}

function turn(id: string): FikeyaAgentTurn {
	return {
		sessionId: `session-${id}`,
		providerAttemptId: `provider-attempt-${id}`,
		providerAttemptIds: [`provider-attempt-${id}`],
		providerAttemptMeasurement: 'exact',
		callId: `call-${id}`,
		providerCallIds: [`provider-call-${id}`],
		status: 'completed',
		failure: null,
		output: `Result ${id}`,
		usage: { measurement: 'provider-reported', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
		memory: { status: 'used', coverage: 'complete', evidenceCount: 2, receiptId: null, responseSha256: null },
		outcome: { plan: '', summary: `Result ${id}`, steps: 1, toolCalls: [], tests: [], changedFiles: [], changedFilesTruncated: false, changedFilesScope: 'regular-project-files-v1' }
	};
}

function receipt(id: string): FikeyaProviderReceipt {
	return {
		apiMode: 'responses',
		cachedInputTokens: 2,
		callId: `provider-call-${id}`,
		createdAt: '2026-08-27T00:00:00.000Z',
		durationMs: 20,
		inputTokens: 10,
		model: `model-${id}`,
		outputTokens: 5,
		provider: `provider-${id}`,
		requestBytes: 50,
		requestSha256: `sha256:${'a'.repeat(64)}`,
		responseBytes: 25,
		responseSha256: `sha256:${'b'.repeat(64)}`,
		statusCode: 200,
		usageMeasurement: 'provider-reported'
	};
}

function successfulResult(id: string): FikeyaCliResult<FikeyaAgentTurn> {
	return { ok: true, exitCode: 0, value: turn(id), failure: 'none' };
}

function handle(result: Promise<FikeyaCliResult<FikeyaAgentTurn>>, cancel: () => void = () => undefined): FikeyaAgentRunHandle {
	return { result, cancel, onProgress: () => () => undefined };
}

function dependencies(
	startAgentRun: FikeyaMultiAgentDependencies['startAgentRun'],
	now: () => number = () => 1_000
): FikeyaMultiAgentDependencies {
	return {
		startAgentRun,
		loadAgentReceipts: async sessionId => ({
			ok: true,
			exitCode: 0,
			value: [receipt(sessionId.replace('session-', ''))],
			failure: 'none'
		}),
		now,
		createBatchId: () => 'batch_fixture'
	};
}

describe('Fikeya multi-agent orchestration', () => {
	test('allows only read-only workspace tools for advisory agents', () => {
		assert.strictEqual(isFikeyaAdvisoryToolAllowed('workspace.list_files'), true);
		assert.strictEqual(isFikeyaAdvisoryToolAllowed('workspace.read_file'), true);
		assert.strictEqual(isFikeyaAdvisoryToolAllowed('workspace.search_text'), true);
		assert.strictEqual(isFikeyaAdvisoryToolAllowed('workspace.replace_text'), false);
		assert.strictEqual(isFikeyaAdvisoryToolAllowed('workspace.write_file'), false);
		assert.strictEqual(isFikeyaAdvisoryToolAllowed('process.run'), false);
	});

	test('runs independent agents through a bounded worker pool and retains per-agent receipts', async () => {
		const gates = new Map(['a', 'b', 'c'].map(id => [id, deferred<FikeyaCliResult<FikeyaAgentTurn>>()]));
		const started: string[] = [];
		let active = 0;
		let maximumActive = 0;
		const operation = startFikeyaMultiAgentRun(
			{ selectedAgentIds: ['a', 'b', 'c'], prompt: 'Review the workspace.', maxConcurrency: 2, allowNetwork: true },
			['a', 'b', 'c'].map(profile),
			'D:\\workspace',
			async () => 'deny_once',
			dependencies((agent, prompt) => {
				started.push(agent.id);
				assert.match(prompt, new RegExp(`Handle the ${agent.id} concern`));
				active++;
				maximumActive = Math.max(maximumActive, active);
				return handle(gates.get(agent.id)!.promise.finally(() => active--));
			})
		);
		await Promise.resolve();
		assert.deepStrictEqual(started, ['a', 'b']);
		gates.get('a')!.resolve(successfulResult('a'));
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(started, ['a', 'b', 'c']);
		gates.get('b')!.resolve(successfulResult('b'));
		gates.get('c')!.resolve(successfulResult('c'));

		const result = await operation.result;
		assert.deepStrictEqual({
			status: result.status,
			maximumActive,
			agents: result.agents.map(agent => ({
				id: agent.profile.id,
				status: agent.status,
				receipts: agent.receipts.map(item => item.callId)
			}))
		}, {
			status: 'completed',
			maximumActive: 2,
			agents: [
				{ id: 'a', status: 'completed', receipts: ['provider-call-a'] },
				{ id: 'b', status: 'completed', receipts: ['provider-call-b'] },
				{ id: 'c', status: 'completed', receipts: ['provider-call-c'] }
			]
		});
	});

	test('serializes approval prompts across concurrently running agents', async () => {
		const approvalGates = new Map(['a', 'b'].map(id => [id, deferred<FikeyaAgentApprovalDecision>()]));
		const approvalCalls: string[] = [];
		const operation = startFikeyaMultiAgentRun(
			{ selectedAgentIds: ['a', 'b'], prompt: 'Inspect safely.', maxConcurrency: 2, allowNetwork: true },
			['a', 'b'].map(profile),
			'D:\\workspace',
			async agent => {
				approvalCalls.push(agent.id);
				return approvalGates.get(agent.id)!.promise;
			},
			dependencies((agent, _prompt, _history, _workspacePath, requestApproval) => handle((async () => {
				await requestApproval({
					type: 'approval', requestId: `request-${agent.id}`, sessionId: `session-${agent.id}`,
					callId: `call-${agent.id}`, toolName: 'workspace.read_file', argumentsSha256: 'sha256:fixture',
					expectedRevision: 1, summary: 'Read one file', arguments: { path: 'README.md' }
				});
				return successfulResult(agent.id);
			})()))
		);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(approvalCalls, ['a']);
		approvalGates.get('a')!.resolve('allow_once');
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(approvalCalls, ['a', 'b']);
		approvalGates.get('b')!.resolve('deny_once');
		assert.strictEqual((await operation.result).status, 'completed');
	});

	test('denies mutating advisory tools without presenting an approval prompt', async () => {
		const approvalCalls: string[] = [];
		const decisions: FikeyaAgentApprovalDecision[] = [];
		const operation = startFikeyaMultiAgentRun(
			{ selectedAgentIds: ['a'], prompt: 'Inspect safely.', maxConcurrency: 1, allowNetwork: true },
			[profile('a')],
			'D:\\workspace',
			async agent => {
				approvalCalls.push(agent.id);
				return 'allow_once';
			},
			dependencies((agent, _prompt, _history, _workspacePath, requestApproval) => handle((async () => {
				for (const toolName of ['workspace.write_file', 'workspace.replace_text', 'process.run']) {
					decisions.push(await requestApproval({
						type: 'approval', requestId: `request-${toolName}`, sessionId: `session-${agent.id}`,
						callId: `call-${agent.id}`, toolName, argumentsSha256: 'sha256:fixture',
						expectedRevision: 1, summary: 'Attempt a mutation', arguments: { path: 'README.md' }
					}));
				}
				return successfulResult(agent.id);
			})()))
		);

		assert.strictEqual((await operation.result).status, 'completed');
		assert.deepStrictEqual(decisions, ['deny_once', 'deny_once', 'deny_once']);
		assert.deepStrictEqual(approvalCalls, []);
	});

	test('cancels active provider processes and never starts queued agents', async () => {
		const cancelled: string[] = [];
		const operation = startFikeyaMultiAgentRun(
			{ selectedAgentIds: ['a', 'b', 'c'], prompt: 'Stop when requested.', maxConcurrency: 2, allowNetwork: true },
			['a', 'b', 'c'].map(profile),
			'D:\\workspace',
			async () => 'cancel',
			dependencies(agent => {
				const gate = deferred<FikeyaCliResult<FikeyaAgentTurn>>();
				return handle(gate.promise, () => {
					cancelled.push(agent.id);
					gate.resolve({ ok: false, exitCode: null, failure: 'cancelled' });
				});
			})
		);
		await Promise.resolve();
		operation.cancel();

		const result = await operation.result;
		assert.deepStrictEqual({
			status: result.status,
			cancelled,
			agents: result.agents.map(agent => ({ id: agent.profile.id, status: agent.status }))
		}, {
			status: 'cancelled',
			cancelled: ['a', 'b'],
			agents: [
				{ id: 'a', status: 'cancelled' },
				{ id: 'b', status: 'cancelled' },
				{ id: 'c', status: 'cancelled' }
			]
		});
	});
});
