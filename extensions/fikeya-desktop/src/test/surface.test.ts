/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FikeyaProjectStage, FikeyaProjectView } from '../runtime';
import { buildDurableProjectPresentation } from '../surface';

const sha256 = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

function projectView(
	stage: FikeyaProjectStage,
	nextAction: FikeyaProjectView['nextAction'],
	historyStages: readonly FikeyaProjectStage[]
): FikeyaProjectView {
	const runId = 'project-run-1';
	const planId = 'project-plan-1';
	return {
		ok: stage !== 'failed',
		runId,
		planId,
		stage,
		record: {
			runId,
			workspaceId: 'workspace-1',
			goalSha256: sha256('a'),
			stage,
			revision: historyStages.length,
			createdAt: '2026-08-28T06:00:00.000Z',
			updatedAt: '2026-08-28T06:04:00.000Z',
			transitionCount: Math.max(0, historyStages.length - 1),
			planRevisions: 1,
			executionFailures: 0,
			providerFailures: 0,
			noProgressCount: 0,
			planId,
			planSpecSha256: sha256('b'),
			planHistory: [sha256('b')],
			resumeStage: nextAction ? 'execute' : null,
			stopReason: nextAction?.action === 'review_plan'
				? 'plan_review_required'
				: nextAction?.action === 'approve_plan_steps'
					? 'plan_approval_required'
					: nextAction?.action === 'resume_project' ? 'recoverable_stop' : null,
			failureReason: null
		},
		history: historyStages.map((historyStage, index) => ({
			createdAt: `2026-08-28T06:0${index}:00.000Z`,
			documentSha256: sha256(String((index + 1) % 10)),
			revision: index + 1,
			stage: historyStage
		})),
		nextAction
	};
}

describe('Fikeya durable project presentation', () => {
	test('renders recovered history exactly and exposes the runtime next action', () => {
		const view = projectView(
			'stopped',
			{ action: 'review_plan', planId: 'project-plan-1' },
			['plan', 'audit_plan', 'stopped']
		);
		const presentation = buildDurableProjectPresentation(view);

		assert.deepStrictEqual(presentation.history.map(item => ({
			revision: item.revision,
			stage: item.stage,
			current: item.current,
			documentSha256: item.documentSha256
		})), [
			{ revision: 1, stage: 'plan', current: false, documentSha256: view.history[0].documentSha256 },
			{ revision: 2, stage: 'audit_plan', current: false, documentSha256: view.history[1].documentSha256 },
			{ revision: 3, stage: 'stopped', current: true, documentSha256: view.history[2].documentSha256 }
		]);
		assert.deepStrictEqual({
			currentStage: presentation.currentStage,
			nextAction: presentation.nextAction,
			nextActionId: presentation.nextActionId,
			requiresExactGoal: presentation.requiresExactGoal,
			canCancel: presentation.canCancel
		}, {
			currentStage: 'stopped',
			nextAction: 'review_plan',
			nextActionId: 'project-plan-1',
			requiresExactGoal: false,
			canCancel: true
		});
	});

	test('marks resumed and terminal records without inventing absent audit stages', () => {
		const resumable = buildDurableProjectPresentation(projectView(
			'stopped',
			{ action: 'resume_project', runId: 'project-run-1' },
			['plan', 'audit_plan', 'execute', 'stopped']
		));
		assert.deepStrictEqual(resumable.history.map(item => item.stage), ['plan', 'audit_plan', 'execute', 'stopped']);
		assert.strictEqual(resumable.nextAction, 'resume_project');
		assert.strictEqual(resumable.nextActionId, 'project-run-1');
		assert.strictEqual(resumable.requiresExactGoal, true);
		assert.strictEqual(resumable.terminal, false);
		assert.strictEqual(resumable.canCancel, true);

		const stopped = buildDurableProjectPresentation(projectView('stopped', null, ['plan', 'stopped']));
		assert.deepStrictEqual(stopped.history.map(item => item.stage), ['plan', 'stopped']);
		assert.strictEqual(stopped.terminal, true);
		assert.strictEqual(stopped.canCancel, false);
		assert.strictEqual(stopped.nextAction, null);
	});
});
