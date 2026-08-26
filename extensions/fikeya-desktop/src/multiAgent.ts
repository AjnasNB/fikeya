/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { FikeyaProviderHistoryMessage } from './conversation';
import { FikeyaAgentProfile, parseFikeyaAgentProfiles } from './agentProfiles';
import {
	FikeyaAgentApproval,
	FikeyaAgentApprovalDecision,
	FikeyaAgentRunHandle,
	FikeyaAgentTurn,
	FikeyaCliResult,
	FikeyaProviderReceipt,
	FikeyaRunProgress,
	FikeyaRuntimeFailure,
	loadFikeyaAgentReceipts,
	startFikeyaAgentRun
} from './runtime';

const defaultMaximumConcurrency = 3;
const absoluteMaximumConcurrency = 8;
const maximumSelectedAgents = 16;
const maximumSharedPromptBytes = 240_000;

export interface FikeyaMultiAgentRequest {
	readonly selectedAgentIds: readonly string[];
	readonly prompt: string;
	readonly history?: readonly FikeyaProviderHistoryMessage[];
	readonly maxConcurrency?: number;
	readonly allowNetwork: true;
}

export type FikeyaMultiAgentStatus = 'completed' | 'partial' | 'failed' | 'cancelled';
export type FikeyaMultiAgentItemStatus = 'completed' | 'failed' | 'cancelled';

export interface FikeyaMultiAgentItemResult {
	readonly profile: FikeyaAgentProfile;
	readonly status: FikeyaMultiAgentItemStatus;
	readonly runtime: FikeyaCliResult<FikeyaAgentTurn>;
	readonly receipts: readonly FikeyaProviderReceipt[];
	readonly receiptFailure: FikeyaRuntimeFailure;
	readonly startedAt: string;
	readonly durationMs: number;
}

export interface FikeyaMultiAgentBatchResult {
	readonly batchId: string;
	readonly status: FikeyaMultiAgentStatus;
	readonly maxConcurrency: number;
	readonly startedAt: string;
	readonly durationMs: number;
	readonly agents: readonly FikeyaMultiAgentItemResult[];
}

export interface FikeyaMultiAgentProgress {
	readonly batchId: string;
	readonly agentId: string;
	readonly status: 'queued' | 'running' | FikeyaMultiAgentItemStatus;
	readonly runtime?: FikeyaRunProgress;
}

export type FikeyaMultiAgentProgressHandler = (progress: FikeyaMultiAgentProgress) => void;
export type FikeyaMultiAgentApprovalHandler = (
	profile: FikeyaAgentProfile,
	request: FikeyaAgentApproval
) => Promise<FikeyaAgentApprovalDecision>;

export interface FikeyaMultiAgentRunHandle {
	readonly result: Promise<FikeyaMultiAgentBatchResult>;
	onProgress(handler: FikeyaMultiAgentProgressHandler): () => void;
	cancel(): void;
}

export interface FikeyaMultiAgentDependencies {
	startAgentRun(
		profile: FikeyaAgentProfile,
		prompt: string,
		history: readonly FikeyaProviderHistoryMessage[],
		workspacePath: string,
		approvalHandler: (request: FikeyaAgentApproval) => Promise<FikeyaAgentApprovalDecision>
	): FikeyaAgentRunHandle;
	loadAgentReceipts(sessionId: string, workspacePath: string): Promise<FikeyaCliResult<readonly FikeyaProviderReceipt[]>>;
	now(): number;
	createBatchId(): string;
}

const defaultDependencies: FikeyaMultiAgentDependencies = {
	startAgentRun: (profile, prompt, history, workspacePath, approvalHandler) => startFikeyaAgentRun(
		profile.providerName,
		prompt,
		profile.maxOutputTokens,
		profile.contextMaxCharacters,
		profile.memoryMode,
		workspacePath,
		approvalHandler,
		history
	),
	loadAgentReceipts: loadFikeyaAgentReceipts,
	now: () => Date.now(),
	createBatchId: () => `batch_${randomUUID().replaceAll('-', '')}`
};

/**
 * Runs selected, independent agent profiles through a bounded worker pool. Provider processes run
 * in parallel while tool approvals remain serialized, so concurrent agents cannot stack prompts.
 */
export function startFikeyaMultiAgentRun(
	request: FikeyaMultiAgentRequest,
	profiles: readonly FikeyaAgentProfile[],
	workspacePath: string,
	approvalHandler: FikeyaMultiAgentApprovalHandler,
	dependencies: FikeyaMultiAgentDependencies = defaultDependencies
): FikeyaMultiAgentRunHandle {
	const validatedProfiles = parseFikeyaAgentProfiles(profiles);
	const selectedProfiles = selectProfiles(request.selectedAgentIds, validatedProfiles);
	const maxConcurrency = normalizeConcurrency(request.maxConcurrency);
	if (request.allowNetwork !== true
		|| validatedProfiles.length !== profiles.length
		|| !request.prompt.trim()
		|| Buffer.byteLength(request.prompt, 'utf8') > maximumSharedPromptBytes
		|| !workspacePath.trim()
		|| selectedProfiles.length !== request.selectedAgentIds.length
		|| selectedProfiles.length === 0
		|| selectedProfiles.length > maximumSelectedAgents) {
		throw new Error('The Fikeya multi-agent request is invalid.');
	}

	const batchId = dependencies.createBatchId();
	const handlers = new Set<FikeyaMultiAgentProgressHandler>();
	const activeRuns = new Map<string, FikeyaAgentRunHandle>();
	const cancelledAgents = new Set<string>();
	const history = request.history ?? [];
	const startedAtMs = dependencies.now();
	let cancelled = false;
	let approvalQueue = Promise.resolve();

	const emit = (progress: FikeyaMultiAgentProgress): void => {
		for (const handler of handlers) {
			try {
				handler(progress);
			} catch {
				// Observers cannot interrupt or fail a provider run.
			}
		}
	};

	for (const profile of selectedProfiles) {
		emit({ batchId, agentId: profile.id, status: 'queued' });
	}

	const results: Array<FikeyaMultiAgentItemResult | undefined> = new Array(selectedProfiles.length);
	let nextProfileIndex = 0;

	const requestApproval = (
		profile: FikeyaAgentProfile,
		approval: FikeyaAgentApproval
	): Promise<FikeyaAgentApprovalDecision> => {
		const decision = approvalQueue.then(async () => {
			if (cancelled || cancelledAgents.has(profile.id)) {
				return 'cancel' as const;
			}
			try {
				return await approvalHandler(profile, approval);
			} catch {
				return 'cancel' as const;
			}
		});
		approvalQueue = decision.then(() => undefined, () => undefined);
		return decision;
	};

	const runProfile = async (profile: FikeyaAgentProfile): Promise<FikeyaMultiAgentItemResult> => {
		const agentStartedAt = dependencies.now();
		if (cancelled) {
			return cancelledResult(profile, agentStartedAt, dependencies.now());
		}
		emit({ batchId, agentId: profile.id, status: 'running' });
		let operation: FikeyaAgentRunHandle;
		try {
			operation = dependencies.startAgentRun(
				profile,
				buildAgentPrompt(profile, request.prompt),
				history,
				workspacePath,
				approval => requestApproval(profile, approval)
			);
		} catch {
			const result = failedResult(profile, agentStartedAt, dependencies.now());
			emit({ batchId, agentId: profile.id, status: 'failed' });
			return result;
		}
		activeRuns.set(profile.id, operation);
		const disposeProgress = operation.onProgress(runtime => emit({
			batchId,
			agentId: profile.id,
			status: 'running',
			runtime
		}));
		let runtime: FikeyaCliResult<FikeyaAgentTurn>;
		try {
			runtime = await operation.result;
		} catch {
			runtime = { ok: false, exitCode: null, failure: 'runtime-error' };
		} finally {
			disposeProgress();
			activeRuns.delete(profile.id);
		}

		let receipts: readonly FikeyaProviderReceipt[] = [];
		let receiptFailure: FikeyaRuntimeFailure = 'none';
		if (runtime.ok && runtime.value) {
			try {
				const receiptResult = await dependencies.loadAgentReceipts(runtime.value.sessionId, workspacePath);
				receipts = receiptResult.value ?? [];
				receiptFailure = receiptResult.failure;
			} catch {
				receiptFailure = 'runtime-error';
			}
		}
		const status = itemStatus(runtime);
		const finishedAt = dependencies.now();
		const result = {
			profile,
			status,
			runtime,
			receipts,
			receiptFailure,
			startedAt: new Date(agentStartedAt).toISOString(),
			durationMs: Math.max(0, finishedAt - agentStartedAt)
		} satisfies FikeyaMultiAgentItemResult;
		emit({ batchId, agentId: profile.id, status });
		return result;
	};

	const worker = async (): Promise<void> => {
		while (nextProfileIndex < selectedProfiles.length) {
			const index = nextProfileIndex++;
			const profile = selectedProfiles[index];
			if (cancelled) {
				results[index] = cancelledResult(profile, dependencies.now(), dependencies.now());
				emit({ batchId, agentId: profile.id, status: 'cancelled' });
				continue;
			}
			results[index] = await runProfile(profile);
		}
	};

	const result = Promise.all(Array.from(
		{ length: Math.min(maxConcurrency, selectedProfiles.length) },
		() => worker()
	)).then(() => {
		const completedAt = dependencies.now();
		const agentResults = results.map((agentResult, index) => agentResult
			?? cancelledResult(selectedProfiles[index], completedAt, completedAt));
		return {
			batchId,
			status: batchStatus(agentResults),
			maxConcurrency,
			startedAt: new Date(startedAtMs).toISOString(),
			durationMs: Math.max(0, completedAt - startedAtMs),
			agents: agentResults
		} satisfies FikeyaMultiAgentBatchResult;
	});

	return {
		result,
		onProgress: handler => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		cancel: () => {
			if (cancelled) {
				return;
			}
			cancelled = true;
			for (const [agentId, operation] of activeRuns) {
				cancelledAgents.add(agentId);
				operation.cancel();
			}
		}
	};
}

function selectProfiles(
	selectedAgentIds: readonly string[],
	profiles: readonly FikeyaAgentProfile[]
): readonly FikeyaAgentProfile[] {
	if (new Set(selectedAgentIds).size !== selectedAgentIds.length) {
		return [];
	}
	const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
	const selected: FikeyaAgentProfile[] = [];
	for (const agentId of selectedAgentIds) {
		const profile = profilesById.get(agentId);
		if (!profile) {
			return [];
		}
		selected.push(profile);
	}
	return selected;
}

function normalizeConcurrency(value: number | undefined): number {
	if (value === undefined) {
		return defaultMaximumConcurrency;
	}
	if (!Number.isSafeInteger(value) || value < 1 || value > absoluteMaximumConcurrency) {
		throw new Error(`Fikeya multi-agent concurrency must be between 1 and ${absoluteMaximumConcurrency}.`);
	}
	return value;
}

function buildAgentPrompt(profile: FikeyaAgentProfile, prompt: string): string {
	if (!profile.instruction) {
		return prompt;
	}
	return [
		`Fikeya agent: ${profile.displayName}`,
		`Role: ${profile.role}`,
		'Agent-specific instruction:',
		profile.instruction,
		'',
		'Shared task:',
		prompt
	].join('\n');
}

function itemStatus(result: FikeyaCliResult<FikeyaAgentTurn>): FikeyaMultiAgentItemStatus {
	if (result.failure === 'cancelled' || result.value?.status === 'cancelled') {
		return 'cancelled';
	}
	return result.ok && result.value?.status === 'completed' ? 'completed' : 'failed';
}

function cancelledResult(
	profile: FikeyaAgentProfile,
	startedAt: number,
	finishedAt: number
): FikeyaMultiAgentItemResult {
	return {
		profile,
		status: 'cancelled',
		runtime: { ok: false, exitCode: null, failure: 'cancelled' },
		receipts: [],
		receiptFailure: 'none',
		startedAt: new Date(startedAt).toISOString(),
		durationMs: Math.max(0, finishedAt - startedAt)
	};
}

function failedResult(
	profile: FikeyaAgentProfile,
	startedAt: number,
	finishedAt: number
): FikeyaMultiAgentItemResult {
	return {
		profile,
		status: 'failed',
		runtime: { ok: false, exitCode: null, failure: 'runtime-error' },
		receipts: [],
		receiptFailure: 'none',
		startedAt: new Date(startedAt).toISOString(),
		durationMs: Math.max(0, finishedAt - startedAt)
	};
}

function batchStatus(results: readonly FikeyaMultiAgentItemResult[]): FikeyaMultiAgentStatus {
	const completed = results.filter(result => result.status === 'completed').length;
	if (completed === results.length) {
		return 'completed';
	}
	if (completed > 0) {
		return 'partial';
	}
	return results.some(result => result.status === 'cancelled') ? 'cancelled' : 'failed';
}
