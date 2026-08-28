/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { appendConversationMessage, FikeyaConversationMessage, parseConversationState, projectProviderHistory, serializeConversationState } from '../conversation';
import { buildChatPlanSummary, buildPlanTimeline, buildRecordedPlanTimeline, extractPlanSteps, fikeyaNarrowPanelMaximumWidth, isChatInteractionBlocked, selectInitialPlanStepId } from '../surface';

function message(index: number, content = `message ${index}`): FikeyaConversationMessage {
	return {
		id: `message-${index}`,
		role: index % 2 === 0 ? 'assistant' : 'user',
		content,
		createdAt: '2026-08-25T00:00:00.000Z'
	};
}

describe('Fikeya live conversation state', () => {
	test('retains the newest bounded messages', () => {
		let messages: readonly FikeyaConversationMessage[] = [];
		for (let index = 0; index < 60; index += 1) {
			messages = appendConversationMessage(messages, message(index));
		}
		assert.strictEqual(messages.length, 48);
		assert.strictEqual(messages[0].id, 'message-12');
		assert.strictEqual(messages.at(-1)?.id, 'message-59');
	});

	test('bounds a large response without losing the newest message', () => {
		const messages = appendConversationMessage([], message(1, 'x'.repeat(300_000)));
		assert.strictEqual(messages.length, 1);
		assert.match(messages[0].content, /Conversation preview truncated/);
		assert.ok(messages[0].content.length < 241_000);
	});

	test('drops old content when the total conversation budget is exceeded', () => {
		let messages: readonly FikeyaConversationMessage[] = [];
		for (let index = 0; index < 8; index += 1) {
			messages = appendConversationMessage(messages, message(index, String(index).repeat(200_000)));
		}
		assert.ok(messages.length < 8);
		assert.strictEqual(messages.at(-1)?.id, 'message-7');
		assert.ok(messages.reduce((total, item) => total + item.content.length, 0) <= 960_000);
	});

	test('renders an identical assistant answer only once within one user turn', () => {
		let messages: readonly FikeyaConversationMessage[] = [
			{ ...message(1, 'Inspect the project.'), role: 'user' }
		];
		messages = appendConversationMessage(messages, { ...message(2, 'One canonical answer.'), providerName: 'planner' });
		messages = appendConversationMessage(messages, { ...message(4, 'One canonical answer.\r\n'), providerName: 'reviewer' });
		assert.deepStrictEqual(messages.map(item => [item.role, item.content, item.providerName]), [
			['user', 'Inspect the project.', undefined],
			['assistant', 'One canonical answer.', 'planner']
		]);

		messages = appendConversationMessage(messages, { ...message(3, 'Ask again.'), role: 'user' });
		messages = appendConversationMessage(messages, { ...message(6, 'One canonical answer.'), providerName: 'lead' });
		assert.strictEqual(messages.length, 4, 'a later user turn may legitimately receive the same answer');
		assert.strictEqual(messages.at(-1)?.providerName, 'lead');
	});

	test('round-trips a redacted bounded workspace snapshot after restart', () => {
		const messages: readonly FikeyaConversationMessage[] = [
			{ ...message(1, 'Inspect src/index.ts with sk-or-v1-1234567890abcdefgh.'), providerName: 'openrouter-main' },
			{ ...message(2, 'The relevant function is createServer().'), tone: 'normal' }
		];
		const restarted = parseConversationState(serializeConversationState(messages));
		assert.deepStrictEqual(restarted, [
			{ ...messages[0], content: 'Inspect src/index.ts with [REDACTED CREDENTIAL].' },
			messages[1]
		]);
	});

	test('retains only content-free attachment metadata across restarts', () => {
		const imageAttachment = {
			kind: 'image' as const,
			name: 'screen.png',
			mimeType: 'image/png',
			sizeBytes: 8,
			sha256: `sha256:${'a'.repeat(64)}`
		};
		const textAttachment = {
			kind: 'text' as const,
			name: 'index.ts',
			relativePath: 'src/index.ts',
			mimeType: 'text/plain',
			sizeBytes: 24,
			sha256: `sha256:${'b'.repeat(64)}`
		};
		const attachments = [imageAttachment, textAttachment];
		const serialized = serializeConversationState([{ ...message(1, 'Explain these files.'), attachments }]);
		assert.doesNotMatch(serialized, /data:image|base64Data|export const/u);
		assert.deepStrictEqual(parseConversationState(serialized), [{ ...message(1, 'Explain these files.'), attachments }]);
	});

	test('fails closed for malformed, oversized, or partially invalid snapshots', () => {
		const valid = message(1);
		assert.deepStrictEqual({
			malformed: parseConversationState('{'),
			wrongVersion: parseConversationState(JSON.stringify({ schemaVersion: 2, messages: [valid] })),
			invalidRole: parseConversationState(JSON.stringify({ schemaVersion: 1, messages: [{ ...valid, role: 'tool' }] })),
			invalidTimestamp: parseConversationState(JSON.stringify({ schemaVersion: 1, messages: [{ ...valid, createdAt: 'yesterday' }] })),
			controlOnly: parseConversationState(JSON.stringify({ schemaVersion: 1, messages: [{ ...valid, content: '\u0000\u202E' }] })),
			oversized: parseConversationState('x'.repeat(1_100_001))
		}, {
			malformed: [],
			wrongVersion: [],
			invalidRole: [],
			invalidTimestamp: [],
			controlOnly: [],
			oversized: []
		});
	});

	test('trims a persisted restart snapshot to the newest bounded messages', () => {
		const messages = Array.from({ length: 60 }, (_, index) => message(index));
		const restarted = parseConversationState(serializeConversationState(messages));
		assert.deepStrictEqual({
			length: restarted.length,
			first: restarted[0]?.id,
			last: restarted.at(-1)?.id
		}, { length: 48, first: 'message-12', last: 'message-59' });
	});

	test('projects a bounded role-typed follow-up history without local notices', () => {
		const messages: readonly FikeyaConversationMessage[] = [
			{ ...message(1, 'Find the parser.') },
			{ ...message(2, 'The parser is in src/parser.ts.') },
			{ ...message(3, 'Provider temporarily unavailable.'), role: 'notice', tone: 'error' },
			{ ...message(4, 'Explain its second branch.'), role: 'user' }
		];
		assert.deepStrictEqual(projectProviderHistory(messages), [
			{ role: 'user', content: 'Find the parser.' },
			{ role: 'assistant', content: 'The parser is in src/parser.ts.' },
			{ role: 'user', content: 'Explain its second branch.' }
		]);
	});

	test('bounds provider history by count and character budget while keeping a user-led follow-up', () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({
			...message(index, `${index}:${'x'.repeat(20_000)}`),
			role: index % 2 === 0 ? 'user' as const : 'assistant' as const
		}));
		const history = projectProviderHistory(messages);
		assert.deepStrictEqual({
			startsWithUser: history[0]?.role,
			lastRole: history.at(-1)?.role,
			withinCount: history.length <= 12,
			withinCharacters: history.reduce((total, item) => total + item.content.length, 0) <= 64_000,
			containsTruncationMarker: history.every(item => item.content.includes('provider-history content truncated'))
		}, {
			startsWithUser: 'user',
			lastRole: 'assistant',
			withinCount: true,
			withinCharacters: true,
			containsTruncationMarker: true
		});
	});
});

describe('Fikeya chat webview refresh state', () => {
	test('renders the inline webview JavaScript with literal escapes intact', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		const scriptStart = source.lastIndexOf('<script nonce=');
		const scriptTagEnd = source.indexOf('>', scriptStart);
		const scriptBodyStart = scriptTagEnd + 1;
		const scriptEnd = source.indexOf('</script>', scriptBodyStart);
		const script = source.slice(scriptBodyStart, scriptEnd).replace(/^\r?\n/u, '');
		assert.ok(scriptStart > 0 && scriptTagEnd > scriptStart && scriptEnd > scriptBodyStart);
		assert.match(source.slice(0, scriptStart), /return String\.raw`<!DOCTYPE html>/u);
		assert.doesNotThrow(() => new Function(script));
		assert.match(script, /document\.addEventListener\('submit', event => event\.preventDefault\(\), true\)/u);
		assert.match(script, /replaceAll\('\\\\', '\/'\)/u);
	});

	test('restores composer focus against the rendered Chat surface', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /focusSurface: initialSurface/u);
		assert.match(source, /persistedState\.focusSurface === initialSurface/u);
		assert.match(source, /focusTarget\?\.focus\(\{ preventScroll: true \}\)/u);
		assert.doesNotMatch(source, /focusSurface: \(vscode\.getState\(\) \|\| \{\}\)\.surface/u);
	});

	test('retains both expanded and collapsed inline Plan state for the same durable plan', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /data-chat-plan-details/u);
		assert.match(source, /persistedState\.chatPlanId === activePlanId/u);
		assert.match(source, /typeof persistedState\.chatPlanOpen === 'boolean'/u);
		assert.match(source, /chatPlanDetails\.open = persistedState\.chatPlanOpen/u);
		assert.match(source, /chatPlanDetails\.addEventListener\('toggle', saveChatPlanState\)/u);
	});

	test('continues to merge prompt, scroll, and graph state instead of replacing it', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /vscode\.setState\(\{ \.\.\.\(vscode\.getState\(\) \|\| \{\}\), \.\.\.patch \}\)/u);
		assert.match(source, /chatDraft: promptField\?\.value \|\| ''/u);
		assert.match(source, /chatScrollTop: chatThread\.scrollTop/u);
		assert.match(source, /persistedState\.graphState/u);
	});

	test('renders the compact five-mode composer with durable local selection and behavior copy', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		for (const mode of ['ask', 'plan', 'build', 'review', 'research']) {
			assert.match(source, new RegExp(`id: '${mode}'`, 'u'));
		}
		assert.doesNotMatch(source, /<option value="agent"/u);
		assert.doesNotMatch(source, /<option value="multitask"/u);
		assert.match(source, /data-parallel-toggle type="button" aria-pressed="false"/u);
		assert.match(source, /aria-describedby="composer-mode-help"/u);
		assert.match(source, /data-composer-mode-help role="status"/u);
		assert.match(source, /\['ask', 'plan', 'build', 'review', 'research'\]\.includes\(persistedState\.chatMode\)/u);
		assert.match(source, /chatMode: chatModeField\?\.value \|\| 'build'/u);
		assert.match(source, /chatParallelAgents: parallelAgentsEnabled/u);
		assert.match(source, /buildComposerModeProviderPrompt\(composerMode, prompt\)/u);
	});

	test('keeps attachment reads, send availability, and focus safe across mode changes', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /attachmentReadCount \+= 1/u);
		assert.match(source, /hasAttachments: attachmentReadCount > 0 \|\| imageAttachments\.length > 0 \|\| textFileAttachments\.length > 0/u);
		assert.match(source, /runButton\.disabled = runBlocked \|\| attachmentReadCount > 0/u);
		assert.match(source, /chatModeField\?\.addEventListener\('change', updateComposerMode\)/u);
		assert.match(source, /executeAgentAction\(chatModeField\?\.value === 'plan' \? 'plan' : parallelAgentsEnabled \? 'multitask' : 'run'\)/u);
		assert.match(source, /agentForm\.requestSubmit\(\)/u);
		assert.doesNotMatch(source, /data-network-confirmation/u);
		assert.doesNotMatch(source, /chatModeField\?\.addEventListener\('change', refresh/u);
	});

	test('keeps Project chat persistent and accepts Explorer resource drops across the surface', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /data-agent-surface/u);
		assert.match(source, /attachDroppedResources/u);
		assert.match(source, /ResourceURLs/u);
		assert.match(source, /application\/vnd\.code\.uri-list/u);
		assert.match(source, /this\.projectPanelRequired = true/u);
		assert.match(source, /if \(this\.projectPanelRequired && !this\.disposed && !this\.panel\)/u);
		assert.doesNotMatch(source, /data-layout-switch/u);
	});

	test('uses one accessible animated copy action instead of a floating button cluster', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /role="toolbar" aria-label=/u);
		assert.match(source, /data-copy-message="\$\{escapeHtml\(messageId\)\}"/u);
		assert.match(source, /postUi\('copyConversationMessage', \{ messageId \}\)/u);
		assert.match(source, /data-copy-state="copied"/u);
		assert.match(source, /@keyframes fikeya-action-confirm/u);
		assert.match(source, /@media \(prefers-reduced-motion: reduce\)/u);
		assert.doesNotMatch(source, /class="quiet copy-message"/u);
	});

	test('shows accessible autonomous stages with cancel and durable-plan resume actions', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /\['PLAN', 'AUDIT_PLAN', 'EXECUTE', 'AUDIT_CODE', 'VERIFY'\]/u);
		assert.match(source, /aria-current="step"/u);
		assert.match(source, /data-agent-cancel/u);
		assert.match(source, /data-plan-action="resume"/u);
		assert.match(source, /data-plan-action="cancel"/u);
		assert.match(source, /role="status"/u);
	});
});

describe('Fikeya plan surface', () => {
	test('keeps the five plan stages visible before a run', () => {
		const timeline = buildPlanTimeline({ status: 'idle', hasOutcome: false });
		assert.deepStrictEqual(timeline.map(stage => stage.id), ['draft', 'review', 'approval', 'execute', 'verify']);
		assert.strictEqual(timeline[0].status, 'active');
		assert.ok(timeline.slice(1).every(stage => stage.status === 'pending'));
	});

	test('marks a verified completed run without inventing a partial state', () => {
		const timeline = buildPlanTimeline({ status: 'completed', hasOutcome: true });
		assert.ok(timeline.every(stage => stage.status === 'complete'));
	});

	test('puts failed and cancelled runs at an inspectable attention boundary', () => {
		const failed = buildPlanTimeline({ status: 'failed', hasOutcome: false });
		const cancelled = buildPlanTimeline({ status: 'cancelled', hasOutcome: false });
		assert.strictEqual(failed.find(stage => stage.id === 'execute')?.status, 'attention');
		assert.strictEqual(cancelled.find(stage => stage.id === 'approval')?.status, 'attention');
		assert.ok(failed.filter(stage => stage.id !== 'execute').every(stage => stage.status === 'pending'));
	});

	test('shows a running execution without fabricating unreported earlier stages', () => {
		const running = buildPlanTimeline({ status: 'running', hasOutcome: false });
		assert.strictEqual(running.find(stage => stage.id === 'execute')?.status, 'active');
		assert.ok(running.filter(stage => stage.id !== 'execute').every(stage => stage.status === 'pending'));
	});

	test('extracts bounded readable steps from a provider plan', () => {
		assert.deepStrictEqual(extractPlanSteps('1. Inspect files\n- Edit the parser\n* Run tests', 2), [
			'Inspect files',
			'Edit the parser'
		]);
		assert.deepStrictEqual(extractPlanSteps(undefined), []);
	});

	test('derives terminal lifecycle attention from durable evidence', () => {
		const step = { status: 'cancelled' as const, approval: null, execution: null, verification: null };
		const cancelledBeforeApproval = buildRecordedPlanTimeline({ status: 'cancelled', steps: [step] });
		const failedDuringExecution = buildRecordedPlanTimeline({ status: 'failed', steps: [{ ...step, status: 'failed', approval: {}, execution: {} }] });
		const failedDuringVerification = buildRecordedPlanTimeline({ status: 'failed', steps: [{ ...step, status: 'failed', approval: {}, execution: {}, verification: {} }] });
		assert.deepStrictEqual({
			cancelled: cancelledBeforeApproval.map(stage => stage.status),
			execution: failedDuringExecution.map(stage => stage.status),
			verification: failedDuringVerification.map(stage => stage.status)
		}, {
			cancelled: ['complete', 'attention', 'pending', 'pending', 'pending'],
			execution: ['complete', 'complete', 'complete', 'attention', 'pending'],
			verification: ['complete', 'complete', 'complete', 'complete', 'attention']
		});
	});

	test('selects the first live or actionable plan step instead of the last step', () => {
		assert.strictEqual(selectInitialPlanStepId([
			{ stepId: 'inspect', status: 'pending' },
			{ stepId: 'edit', status: 'pending' },
			{ stepId: 'verify', status: 'pending' }
		]), 'inspect');
		assert.strictEqual(selectInitialPlanStepId([
			{ stepId: 'inspect', status: 'succeeded' },
			{ stepId: 'edit', status: 'awaiting_approval' },
			{ stepId: 'verify', status: 'pending' }
		]), 'edit');
	});

	test('blocks Chat across agent runs, plan runs, and plan cancellation', () => {
		assert.deepStrictEqual([
			isChatInteractionBlocked({ agentRunning: false, planRunning: false, planCancellationInProgress: false }),
			isChatInteractionBlocked({ agentRunning: true, planRunning: false, planCancellationInProgress: false }),
			isChatInteractionBlocked({ agentRunning: false, planRunning: true, planCancellationInProgress: false }),
			isChatInteractionBlocked({ agentRunning: false, planRunning: false, planCancellationInProgress: true })
		], [false, true, true, true]);
	});

	test('summarizes the current or next durable step beside Chat', () => {
		const reviewed = buildChatPlanSummary({
			title: 'Inspect and repair',
			status: 'reviewed',
			steps: [
				{ stepId: 'inspect', title: 'Inspect the project', order: 1, status: 'pending' },
				{ stepId: 'repair', title: 'Repair the defect', order: 2, status: 'pending' }
			]
		});
		const awaitingApproval = buildChatPlanSummary({
			title: 'Inspect and repair',
			status: 'awaiting_approval',
			steps: [
				{ stepId: 'inspect', title: 'Inspect the project', order: 1, status: 'succeeded' },
				{ stepId: 'repair', title: 'Repair the defect', order: 2, status: 'awaiting_approval' }
			]
		});
		const completed = buildChatPlanSummary({
			title: 'Inspect and repair',
			status: 'succeeded',
			steps: [
				{ stepId: 'inspect', title: 'Inspect the project', order: 1, status: 'succeeded' },
				{ stepId: 'repair', title: 'Repair the defect', order: 2, status: 'succeeded' }
			]
		});

		assert.deepStrictEqual({
			reviewed: [reviewed.stepKind, reviewed.step?.stepId, reviewed.totalSteps],
			approval: [awaitingApproval.stepKind, awaitingApproval.step?.stepId, awaitingApproval.totalSteps],
			completed: [completed.stepKind, completed.step?.stepId, completed.totalSteps]
		}, {
			reviewed: ['next', 'inspect', 2],
			approval: ['current', 'repair', 2],
			completed: ['final', 'repair', 2]
		});
	});

	test('keeps a 360 pixel beside-editor panel inside the compact layout contract', () => {
		assert.deepStrictEqual({
			compactAt360: 360 <= fikeyaNarrowPanelMaximumWidth,
			compactAtBoundary: 420 <= fikeyaNarrowPanelMaximumWidth,
			compactAboveBoundary: 421 <= fikeyaNarrowPanelMaximumWidth
		}, { compactAt360: true, compactAtBoundary: true, compactAboveBoundary: false });
	});
});
