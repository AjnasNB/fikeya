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

const stageIds: readonly FikeyaPlanStageId[] = ['draft', 'review', 'approval', 'execute', 'verify'];

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
