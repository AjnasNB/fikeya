/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
	captureQarinahRun,
	captureQarinahRuns,
	FikeyaMemoryRunCaptureRequest,
	FikeyaMemoryRunCaptureResult
} from './memory';
import {
	FikeyaAgentTurn,
	FikeyaProviderProfile,
	FikeyaProviderReceipt
} from './runtime';

export interface FikeyaCompletedRunCaptureInput {
	readonly extensionPath: string;
	readonly workspacePath: string;
	readonly prompt: string;
	readonly profile: FikeyaProviderProfile;
	readonly turn: FikeyaAgentTurn;
	readonly receipts: readonly FikeyaProviderReceipt[];
}

/**
 * Converts one terminal provider turn into the narrow Qarinah capture contract. The provider
 * output is deliberately absent: the durable provider receipt already supplies its bounded hash,
 * byte count, status, latency, and provider-reported usage.
 */
export function buildCompletedRunCaptureRequest(input: FikeyaCompletedRunCaptureInput): FikeyaMemoryRunCaptureRequest {
	const providerReceiptIds = new Set(input.turn.providerCallIds);
	const matchingProviderReceipts = input.receipts
		.filter(candidate => providerReceiptIds.has(candidate.callId)
			&& candidate.provider === input.profile.name
			&& candidate.model === input.profile.model);
	const providerReceipts = matchingProviderReceipts
		.slice(-16)
		.map(receipt => ({
			apiMode: receipt.apiMode,
			callId: receipt.callId,
			createdAt: receipt.createdAt,
			durationMs: receipt.durationMs,
			requestBytes: receipt.requestBytes,
			requestSha256: receipt.requestSha256,
			responseBytes: receipt.responseBytes,
			responseSha256: receipt.responseSha256,
			statusCode: receipt.statusCode
		}));
	const toolOutcomes = input.turn.outcome.toolCalls.slice(-12);
	const changedFiles = input.turn.outcome.changedFiles.slice(-32);
	const promptSha256 = sha256(input.prompt);
	const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
	const capturedPrompt = boundedUtf8Excerpt(input.prompt, 16_000);
	let request: FikeyaMemoryRunCaptureRequest = {
		sessionId: input.turn.sessionId,
		providerAttemptId: input.turn.providerAttemptId,
		providerAttemptMeasurement: input.turn.providerAttemptMeasurement,
		callId: input.turn.callId,
		prompt: capturedPrompt.text,
		promptSha256,
		promptBytes,
		promptTruncated: capturedPrompt.truncated,
		provider: {
			name: input.profile.name,
			kind: input.profile.kind,
			model: input.profile.model
		},
		usage: input.turn.usage,
		memory: input.turn.memory,
		providerReceipts,
		providerCallCount: input.turn.providerAttemptIds.length,
		providerReceiptCount: input.turn.providerCallIds.length,
		providerReceiptsTruncated: providerReceipts.length !== input.turn.providerCallIds.length,
		outcome: {
			status: input.turn.status,
			terminalFailure: input.turn.failure,
			changedFilesScope: input.turn.outcome.changedFilesScope,
			steps: input.turn.outcome.steps,
			planSha256: sha256(input.turn.outcome.plan),
			summarySha256: sha256(input.turn.outcome.summary),
			toolOutcomeCount: input.turn.outcome.toolCalls.length,
			toolOutcomesTruncated: toolOutcomes.length !== input.turn.outcome.toolCalls.length,
			toolOutcomes,
			changedFileCount: input.turn.outcome.changedFiles.length,
			changedFilesTruncated: input.turn.outcome.changedFilesTruncated || changedFiles.length !== input.turn.outcome.changedFiles.length,
			changedFiles
		}
	};
	// Fit the exact serialized JSON-RPC line, not just raw field bytes. Paths and
	// prompts may contain characters that JSON expands to six-byte escape sequences.
	while (captureLineBytes(request) > 1024 * 1024 && request.outcome.changedFiles.length > 0) {
		request = {
			...request,
			outcome: {
				...request.outcome,
				changedFilesTruncated: true,
				changedFiles: request.outcome.changedFiles.slice(1)
			}
		};
	}
	while (captureLineBytes(request) > 1024 * 1024 && request.outcome.toolOutcomes.length > 0) {
		request = {
			...request,
			outcome: {
				...request.outcome,
				toolOutcomesTruncated: true,
				toolOutcomes: request.outcome.toolOutcomes.slice(1)
			}
		};
	}
	while (captureLineBytes(request) > 1024 * 1024 && request.providerReceipts.length > 0) {
		request = {
			...request,
			providerReceiptsTruncated: true,
			providerReceipts: request.providerReceipts.slice(1)
		};
	}
	if (captureLineBytes(request) > 1024 * 1024) {
		const minimalPrompt = boundedUtf8Excerpt(request.prompt, 1_024);
		request = { ...request, prompt: minimalPrompt.text, promptTruncated: true };
	}
	return request;
}

const workspaceCaptureTails = new Map<string, Promise<void>>();
const maximumCaptureBatchSize = 16;

function captureLineBytes(request: FikeyaMemoryRunCaptureRequest): number {
	return Buffer.byteLength(JSON.stringify({
		jsonrpc: '2.0',
		id: 'fikeya-memory-capture-run',
		method: 'memory.captureRun',
		params: request
	}), 'utf8');
}

function boundedUtf8Excerpt(value: string, maximumBytes: number): { readonly text: string; readonly truncated: boolean } {
	if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
		return { text: value, truncated: false };
	}
	const marker = '\n...[bounded by Fikeya capture]...\n';
	const markerBytes = Buffer.byteLength(marker, 'utf8');
	const headBudget = Math.floor((maximumBytes - markerBytes) * 0.75);
	const tailBudget = maximumBytes - markerBytes - headBudget;
	const codePoints = [...value];
	let head = '';
	let headBytes = 0;
	for (const character of codePoints) {
		const bytes = Buffer.byteLength(character, 'utf8');
		if (headBytes + bytes > headBudget) {
			break;
		}
		head += character;
		headBytes += bytes;
	}
	let tail = '';
	let tailBytes = 0;
	for (let index = codePoints.length - 1; index >= 0; index -= 1) {
		const character = codePoints[index];
		const bytes = Buffer.byteLength(character, 'utf8');
		if (tailBytes + bytes > tailBudget) {
			break;
		}
		tail = character + tail;
		tailBytes += bytes;
	}
	return { text: `${head}${marker}${tail}`, truncated: true };
}

function sha256(value: string): string {
	return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Captures a terminal run through the local pinned sidecar; an untrusted workspace fails closed. */
export function captureCompletedFikeyaRun(input: FikeyaCompletedRunCaptureInput): Promise<FikeyaMemoryRunCaptureResult> {
	return enqueueWorkspaceCapture(input.workspacePath, () => captureCompletedFikeyaRunDirect(input));
}

function captureCompletedFikeyaRunDirect(input: FikeyaCompletedRunCaptureInput): Promise<FikeyaMemoryRunCaptureResult> {
	return captureQarinahRun(
		input.extensionPath,
		input.workspacePath,
		buildCompletedRunCaptureRequest(input)
	);
}

export type FikeyaCompletedRunCaptureExecutor = (
	input: FikeyaCompletedRunCaptureInput
) => Promise<FikeyaMemoryRunCaptureResult>;

/** Serializes terminal advisor captures because every sidecar writes to one shared Qarinah ledger. */
export async function captureCompletedFikeyaRuns(
	inputs: readonly FikeyaCompletedRunCaptureInput[],
	capture?: FikeyaCompletedRunCaptureExecutor
): Promise<readonly FikeyaMemoryRunCaptureResult[]> {
	const results: Array<FikeyaMemoryRunCaptureResult | undefined> = new Array(inputs.length);
	const groups = new Map<string, Array<{ readonly index: number; readonly input: FikeyaCompletedRunCaptureInput }>>();
	for (const [index, input] of inputs.entries()) {
		const extensionKey = capture ? '' : `\0${path.resolve(input.extensionPath)}`;
		const key = `${workspaceCaptureKey(input.workspacePath)}${extensionKey}`;
		const group = groups.get(key) ?? [];
		group.push({ index, input });
		groups.set(key, group);
	}
	await Promise.all([...groups.values()].map(async group => {
		const first = group[0];
		if (!first) {
			return;
		}
		await enqueueWorkspaceCapture(first.input.workspacePath, async () => {
			if (capture) {
				for (const item of group) {
					try {
						results[item.index] = await capture(item.input);
					} catch {
						results[item.index] = { ok: false, failure: 'process-error' };
					}
				}
				return;
			}

			const prepared = group.map(item => ({
				...item,
				request: buildCompletedRunCaptureRequest(item.input)
			}));
			for (const chunk of captureBatches(prepared)) {
				let captured: readonly FikeyaMemoryRunCaptureResult[];
				try {
					captured = await captureQarinahRuns(
							chunk[0].input.extensionPath,
							chunk[0].input.workspacePath,
							chunk.map(item => item.request)
						);
				} catch {
					captured = chunk.map(() => ({ ok: false, failure: 'process-error' }));
				}
				for (const [offset, item] of chunk.entries()) {
					results[item.index] = captured[offset] ?? { ok: false, failure: 'invalid-response' };
				}
			}
		});
	}));
	return results.map(result => result ?? { ok: false, failure: 'process-error' });
}

function captureBatches<T extends { readonly request: FikeyaMemoryRunCaptureRequest }>(items: readonly T[]): readonly T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	for (const item of items) {
		if (current.length >= maximumCaptureBatchSize) {
			batches.push(current);
			current = [item];
		} else {
			current = [...current, item];
		}
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

function workspaceCaptureKey(workspacePath: string): string {
	let resolved = path.resolve(workspacePath);
	try {
		resolved = realpathSync.native(resolved);
	} catch {
		// The capture itself reports an unavailable workspace; keep a deterministic lexical queue key.
	}
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function enqueueWorkspaceCapture<T>(workspacePath: string, capture: () => Promise<T>): Promise<T> {
	const workspaceKey = workspaceCaptureKey(workspacePath);
	const previous = workspaceCaptureTails.get(workspaceKey) ?? Promise.resolve();
	const result = previous.then(capture);
	const tail = result.then(() => undefined, () => undefined);
	workspaceCaptureTails.set(workspaceKey, tail);
	void tail.then(() => {
		if (workspaceCaptureTails.get(workspaceKey) === tail) {
			workspaceCaptureTails.delete(workspaceKey);
		}
	});
	return result;
}
