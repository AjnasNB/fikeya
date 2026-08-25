/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import {
	captureQarinahRun,
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
 * Converts one successful provider turn into the narrow Qarinah capture contract. The provider
 * output is deliberately absent: the durable provider receipt already supplies its bounded hash,
 * byte count, status, latency, and provider-reported usage.
 */
export function buildCompletedRunCaptureRequest(input: FikeyaCompletedRunCaptureInput): FikeyaMemoryRunCaptureRequest {
	const providerCallIds = new Set(input.turn.providerCallIds);
	const providerReceipts = input.receipts
		.filter(candidate => providerCallIds.has(candidate.callId)
			&& candidate.provider === input.profile.name
			&& candidate.model === input.profile.model)
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
	return {
		sessionId: input.turn.sessionId,
		callId: input.turn.callId,
		prompt: input.prompt,
		provider: {
			name: input.profile.name,
			kind: input.profile.kind,
			model: input.profile.model
		},
		usage: input.turn.usage,
		memory: input.turn.memory,
		providerReceipts,
		outcome: {
			status: 'completed',
			steps: input.turn.outcome.steps,
			planSha256: sha256(input.turn.outcome.plan),
			summarySha256: sha256(input.turn.outcome.summary),
			toolOutcomeCount: input.turn.outcome.toolCalls.length,
			toolOutcomesTruncated: toolOutcomes.length !== input.turn.outcome.toolCalls.length,
			toolOutcomes,
			changedFileCount: input.turn.outcome.changedFiles.length,
			changedFilesTruncated: changedFiles.length !== input.turn.outcome.changedFiles.length,
			changedFiles
		}
	};
}

function sha256(value: string): string {
	return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Captures a completed run through the local pinned sidecar; an untrusted workspace fails closed. */
export function captureCompletedFikeyaRun(input: FikeyaCompletedRunCaptureInput): Promise<FikeyaMemoryRunCaptureResult> {
	return captureQarinahRun(
		input.extensionPath,
		input.workspacePath,
		buildCompletedRunCaptureRequest(input)
	);
}
