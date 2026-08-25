/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export type FikeyaPlanStageId = 'draft' | 'review' | 'approval' | 'execute' | 'verify';
export type FikeyaPlanStageStatus = 'pending' | 'active' | 'complete' | 'attention';

export interface FikeyaPlanTimelineInput {
	readonly status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
	readonly hasOutcome: boolean;
}

export interface FikeyaPlanTimelineStage {
	readonly id: FikeyaPlanStageId;
	readonly status: FikeyaPlanStageStatus;
}

export interface FikeyaRecordedPlanTimelineInput {
	readonly status: 'draft' | 'reviewed' | 'awaiting_approval' | 'executing' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
	readonly steps: readonly {
		readonly status: 'pending' | 'awaiting_approval' | 'approved' | 'executing' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
		readonly approval: object | null;
		readonly execution: object | null;
		readonly verification: object | null;
	}[];
}

export interface FikeyaPlanStepSelectionInput {
	readonly stepId: string;
	readonly status: FikeyaRecordedPlanTimelineInput['steps'][number]['status'];
}

export interface FikeyaChatInteractionInput {
	readonly agentRunning: boolean;
	readonly planRunning: boolean;
	readonly planCancellationInProgress: boolean;
}

export interface FikeyaChatPlanSummaryInput {
	readonly title: string;
	readonly status: FikeyaRecordedPlanTimelineInput['status'];
	readonly steps: readonly {
		readonly stepId: string;
		readonly title: string;
		readonly order: number;
		readonly status: FikeyaPlanStepSelectionInput['status'];
	}[];
}

export interface FikeyaChatPlanSummary {
	readonly title: string;
	readonly status: FikeyaRecordedPlanTimelineInput['status'];
	readonly step?: FikeyaChatPlanSummaryInput['steps'][number];
	readonly stepKind: 'current' | 'next' | 'final';
	readonly totalSteps: number;
}

const stageIds: readonly FikeyaPlanStageId[] = ['draft', 'review', 'approval', 'execute', 'verify'];

/** Width at which the beside-editor surface switches to its single-column compact layout. */
export const fikeyaNarrowPanelMaximumWidth = 420;

/**
 * Produces a deliberately coarse presentation timeline from the runtime state already exposed
 * by the extension. It does not invent sub-stage events that the runtime has not emitted.
 */
export function buildPlanTimeline(input: FikeyaPlanTimelineInput): readonly FikeyaPlanTimelineStage[] {
	if (input.status === 'completed' && input.hasOutcome) {
		return stageIds.map(id => ({ id, status: 'complete' }));
	}
	if (input.status === 'failed') {
		return stagesWithStatus('execute', 'attention', []);
	}
	if (input.status === 'cancelled') {
		return stagesWithStatus('approval', 'attention', []);
	}
	if (input.status === 'running') {
		return stagesWithStatus('execute', 'active', []);
	}
	return stagesWithStatus('draft', 'active', []);
}

/**
 * Builds the lifecycle from the durable plan record. Terminal failures and cancellations are
 * placed at the furthest stage supported by recorded approval, execution, or verification
 * evidence instead of being presented as if verification had always started.
 */
export function buildRecordedPlanTimeline(input: FikeyaRecordedPlanTimelineInput): readonly FikeyaPlanTimelineStage[] {
	if (input.status === 'succeeded') {
		return stageIds.map(id => ({ id, status: 'complete' }));
	}

	const terminal = input.status === 'failed' || input.status === 'cancelled';
	const activeId = terminal ? terminalEvidenceStage(input.steps) : planStatusStage(input.status);
	const activeIndex = stageIds.indexOf(activeId);
	return stagesWithStatus(activeId, terminal ? 'attention' : 'active', stageIds.slice(0, activeIndex));
}

/** Selects the first live/actionable plan step and otherwise starts at the first step. */
export function selectInitialPlanStepId(steps: readonly FikeyaPlanStepSelectionInput[]): string | undefined {
	const liveStatuses = new Set<FikeyaPlanStepSelectionInput['status']>(['awaiting_approval', 'executing', 'verifying', 'failed', 'cancelled']);
	return steps.find(step => liveStatuses.has(step.status))?.stepId
		?? steps.find(step => step.status === 'pending')?.stepId
		?? steps[0]?.stepId;
}

/** Keeps Chat mutually exclusive with a running or cancelling durable plan. */
export function isChatInteractionBlocked(input: FikeyaChatInteractionInput): boolean {
	return input.agentRunning || input.planRunning || input.planCancellationInProgress;
}

/** Builds the compact current-plan summary shown beside an active Chat conversation. */
export function buildChatPlanSummary(plan: FikeyaChatPlanSummaryInput): FikeyaChatPlanSummary {
	const terminal = plan.status === 'succeeded' || plan.status === 'failed' || plan.status === 'cancelled';
	if (terminal) {
		return {
			title: plan.title,
			status: plan.status,
			step: plan.steps.find(step => step.status === 'failed' || step.status === 'cancelled') ?? plan.steps.at(-1),
			stepKind: 'final',
			totalSteps: plan.steps.length
		};
	}

	const current = plan.steps.find(step => step.status === 'awaiting_approval'
		|| step.status === 'approved'
		|| step.status === 'executing'
		|| step.status === 'verifying');
	return {
		title: plan.title,
		status: plan.status,
		step: current ?? plan.steps.find(step => step.status === 'pending') ?? plan.steps[0],
		stepKind: current ? 'current' : 'next',
		totalSteps: plan.steps.length
	};
}

export function extractPlanSteps(plan: string | undefined, limit = 12): readonly string[] {
	if (!plan || limit <= 0) {
		return [];
	}
	return plan
		.split(/\r?\n/u)
		.map(line => line.trim().replace(/^(?:[-*\u2022]|\d+[.)])\s+/u, ''))
		.filter(Boolean)
		.slice(0, limit)
		.map(line => line.slice(0, 500));
}

function stagesWithStatus(
	activeId: FikeyaPlanStageId,
	activeStatus: FikeyaPlanStageStatus,
	completedIds: readonly FikeyaPlanStageId[]
): readonly FikeyaPlanTimelineStage[] {
	const completed = new Set(completedIds);
	return stageIds.map(id => ({
		id,
		status: id === activeId ? activeStatus : completed.has(id) ? 'complete' : 'pending'
	}));
}

function planStatusStage(status: FikeyaRecordedPlanTimelineInput['status']): FikeyaPlanStageId {
	switch (status) {
		case 'draft':
			return 'draft';
		case 'reviewed':
			return 'review';
		case 'awaiting_approval':
			return 'approval';
		case 'executing':
			return 'execute';
		case 'verifying':
		case 'succeeded':
			return 'verify';
		case 'failed':
		case 'cancelled':
			return 'review';
	}
}

function terminalEvidenceStage(steps: FikeyaRecordedPlanTimelineInput['steps']): FikeyaPlanStageId {
	if (steps.some(step => step.verification !== null || step.status === 'verifying')) {
		return 'verify';
	}
	if (steps.some(step => step.execution !== null || step.status === 'executing')) {
		return 'execute';
	}
	if (steps.some(step => step.approval !== null || step.status === 'awaiting_approval' || step.status === 'approved')) {
		return 'approval';
	}
	return 'review';
}
