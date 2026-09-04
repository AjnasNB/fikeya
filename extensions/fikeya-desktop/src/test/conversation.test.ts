/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { appendConversationMessage, clearPersistedConversationSnapshotIfDisabled, FikeyaConversationChangedFileEvidence, FikeyaConversationMessage, parseConversationState, projectConversationRunEvidence, projectProviderHistory, serializeConversationState } from '../conversation';
import { buildChatPlanSummary, buildPlanTimeline, buildRecordedPlanTimeline, extractPlanSteps, fikeyaNarrowPanelMaximumWidth, isChatInteractionBlocked, selectInitialPlanStepId } from '../surface';

function message(index: number, content = `message ${index}`): FikeyaConversationMessage {
	return {
		id: `message-${index}`,
		role: index % 2 === 0 ? 'assistant' : 'user',
		content,
		createdAt: '2026-08-25T00:00:00.000Z'
	};
}

function changedFile(index = 0): FikeyaConversationChangedFileEvidence {
	return {
		path: `src/change-${index}.ts`,
		operation: 'edit',
		beforeExists: true,
		afterExists: true,
		beforeSha256: `sha256:${'a'.repeat(63)}${index % 10}`,
		afterSha256: `sha256:${'b'.repeat(63)}${index % 10}`,
		beforeBytes: 120 + index,
		afterBytes: 144 + index,
		linesAdded: 4,
		linesDeleted: 2,
		lineDeltaStatus: 'exact'
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

	test('does not collapse distinct run evidence when answer text is identical', () => {
		const evidence = (index: number) => projectConversationRunEvidence({
			status: 'completed',
			outcome: {
				changedFilesScope: 'regular-project-files-v1',
				changedFilesTruncated: false,
				changedFiles: [changedFile(index)]
			}
		});
		let messages: readonly FikeyaConversationMessage[] = [{ ...message(1, 'Run twice.'), role: 'user' }];
		messages = appendConversationMessage(messages, { ...message(2, 'Done.'), runEvidence: evidence(1) });
		messages = appendConversationMessage(messages, { ...message(4, 'Done.'), runEvidence: evidence(2) });
		assert.strictEqual(messages.length, 3);
		assert.deepStrictEqual(messages.slice(1).map(item => item.runEvidence?.changedFiles[0]?.path), [
			'src/change-1.ts',
			'src/change-2.ts'
		]);
	});

	test('round-trips a known-pattern-sanitized bounded workspace snapshot after restart', () => {
		const messages: readonly FikeyaConversationMessage[] = [
			{ ...message(1, 'Inspect src/index.ts with sk-or-v1-1234567890abcdefgh and synthetic-custom-secret-format:examplevalue123456.'), providerName: 'openrouter-main' },
			{ ...message(2, 'The relevant function is createServer().'), tone: 'normal' }
		];
		const restarted = parseConversationState(serializeConversationState(messages));
		assert.deepStrictEqual(restarted, [
			{ ...messages[0], content: 'Inspect src/index.ts with [REDACTED CREDENTIAL] and synthetic-custom-secret-format:examplevalue123456.' },
			messages[1]
		]);
	});

	test('clears a saved snapshot on opt-out without changing process-local messages', async () => {
		const processLocalMessages: readonly FikeyaConversationMessage[] = [message(1), message(2)];
		let persistedSnapshot: string | undefined = serializeConversationState(processLocalMessages);
		const clearSnapshot = async () => {
			persistedSnapshot = undefined;
		};

		assert.strictEqual(await clearPersistedConversationSnapshotIfDisabled(true, clearSnapshot), false);
		assert.notStrictEqual(persistedSnapshot, undefined);
		assert.strictEqual(await clearPersistedConversationSnapshotIfDisabled(false, clearSnapshot), true);
		assert.strictEqual(persistedSnapshot, undefined);
		assert.deepStrictEqual(processLocalMessages, [message(1), message(2)]);
	});

	test('retains exact per-run changed-file evidence across later runs and restart', () => {
		const firstEvidence = projectConversationRunEvidence({
			status: 'completed',
			outcome: {
				changedFilesScope: 'regular-project-files-v1',
				changedFilesTruncated: false,
				changedFiles: [changedFile()]
			}
		});
		const secondFile: FikeyaConversationChangedFileEvidence = {
			path: 'obsolete/config.json',
			operation: 'delete',
			beforeExists: true,
			afterExists: false,
			beforeSha256: `sha256:${'c'.repeat(64)}`,
			afterSha256: null,
			beforeBytes: 81,
			afterBytes: null,
			linesAdded: 0,
			linesDeleted: 3,
			lineDeltaStatus: 'exact'
		};
		const secondEvidence = projectConversationRunEvidence({
			status: 'failed',
			outcome: {
				changedFilesScope: 'regular-project-files-v1',
				changedFilesTruncated: true,
				changedFiles: [secondFile]
			}
		});
		let messages: readonly FikeyaConversationMessage[] = [];
		messages = appendConversationMessage(messages, { ...message(1, 'Make the first change.'), role: 'user' });
		messages = appendConversationMessage(messages, { ...message(2, 'First run complete.'), runEvidence: firstEvidence });
		messages = appendConversationMessage(messages, { ...message(3, 'Run another task.'), role: 'user' });
		messages = appendConversationMessage(messages, { ...message(4, 'Second run stopped.'), runEvidence: secondEvidence, tone: 'error' });

		const serialized = serializeConversationState(messages);
		const restarted = parseConversationState(serialized);
		assert.deepStrictEqual(restarted[1]?.runEvidence, firstEvidence);
		assert.deepStrictEqual(restarted[3]?.runEvidence, secondEvidence);
		assert.match(serialized, /src\/change-0\.ts/u);
		assert.match(serialized, /obsolete\/config\.json/u);
	});

	test('never sends local run-evidence attachments into provider history', () => {
		const runEvidence = projectConversationRunEvidence({
			status: 'completed',
			outcome: {
				changedFilesScope: 'regular-project-files-v1',
				changedFilesTruncated: false,
				changedFiles: [changedFile()]
			}
		});
		const messages: readonly FikeyaConversationMessage[] = [
			{ ...message(1, 'Apply the change.'), role: 'user' },
			{ ...message(2, 'Done.'), runEvidence }
		];
		const history = projectProviderHistory(messages);
		assert.deepStrictEqual(history, [
			{ role: 'user', content: 'Apply the change.' },
			{ role: 'assistant', content: 'Done.' }
		]);
		assert.doesNotMatch(JSON.stringify(history), /change-0|beforeSha256|runEvidence/u);
	});

	test('bounds saved run evidence and discloses projection truncation', () => {
		const runEvidence = projectConversationRunEvidence({
			status: 'cancelled',
			outcome: {
				changedFilesScope: 'regular-project-files-v1',
				changedFilesTruncated: true,
				changedFiles: Array.from({ length: 40 }, (_, index) => changedFile(index))
			}
		});
		assert.deepStrictEqual({
			retained: runEvidence.changedFiles.length,
			measured: runEvidence.measuredChangedFileCount,
			projectionTruncated: runEvidence.projectionTruncated,
			accountingIncomplete: runEvidence.accountingIncomplete
		}, {
			retained: 32,
			measured: 40,
			projectionTruncated: true,
			accountingIncomplete: true
		});
		const restarted = parseConversationState(serializeConversationState([{ ...message(2), runEvidence }]));
		assert.deepStrictEqual(restarted[0]?.runEvidence, runEvidence);
	});

	test('keeps evidence-heavy restart snapshots inside the durable store limit', () => {
		const messages = Array.from({ length: 10 }, (_, runIndex) => ({
			...message(runIndex * 2, `Run ${runIndex} complete.`),
			runEvidence: projectConversationRunEvidence({
				status: 'completed' as const,
				outcome: {
					changedFilesScope: 'regular-project-files-v1' as const,
					changedFilesTruncated: false,
					changedFiles: Array.from({ length: 32 }, (_, fileIndex) => ({
						...changedFile(fileIndex),
						path: `src/${runIndex}-${fileIndex}-${'x'.repeat(3_900)}.ts`
					}))
				}
			})
		}));
		const serialized = serializeConversationState(messages);
		const restarted = parseConversationState(serialized);
		assert.ok(serialized.length <= 1_100_000);
		assert.ok(restarted.length > 0 && restarted.length < messages.length);
		assert.strictEqual(restarted.at(-1)?.id, messages.at(-1)?.id);
		assert.strictEqual(restarted.at(-1)?.runEvidence?.changedFiles.length, 32);
	});

	test('fails closed when persisted run evidence is contradictory or carries extra content', () => {
		const runEvidence = projectConversationRunEvidence({
			status: 'completed',
			outcome: {
				changedFilesScope: 'regular-project-files-v1',
				changedFilesTruncated: false,
				changedFiles: [changedFile()]
			}
		});
		const invalidOperation = {
			...runEvidence,
			changedFiles: [{ ...runEvidence.changedFiles[0], operation: 'add' }]
		};
		const smuggledContent = {
			...runEvidence,
			changedFiles: [{ ...runEvidence.changedFiles[0], fileContent: 'private source text' }]
		};
		assert.deepStrictEqual(parseConversationState(JSON.stringify({
			schemaVersion: 1,
			messages: [{ ...message(2), runEvidence: invalidOperation }]
		})), []);
		assert.deepStrictEqual(parseConversationState(JSON.stringify({
			schemaVersion: 1,
			messages: [{ ...message(2), runEvidence: smuggledContent }]
		})), []);
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
	test('keeps saved run evidence behind the disabled-by-default workspace history setting', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
		};
		const packageStrings = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.nls.json'), 'utf8')) as Record<string, string>;
		const persistenceDescription = packageStrings['configuration.chat.persistWorkspaceHistory.description'] ?? '';
		assert.strictEqual(manifest.contributes?.configuration?.properties?.['fikeya.chat.persistWorkspaceHistory']?.default, false);
		assert.match(persistenceDescription, /Chat text and changed-file paths pass through a best-effort known-pattern sanitizer/u);
		assert.match(persistenceDescription, /attachment metadata is not secret-scanned and unknown formats may remain/u);
		assert.match(persistenceDescription, /Do not store secrets/u);
		assert.doesNotMatch(persistenceDescription, /credential-redacted/u);
		assert.match(source, /if \(!this\.conversationPersistenceEnabled\(\)\) \{\s*await this\.context\.workspaceState\.update\(FikeyaWebviewViewProvider\.conversationKey, undefined\);/u);
		assert.match(source, /vscode\.workspace\.onDidChangeConfiguration\(event => \{\s*if \(event\.affectsConfiguration\('fikeya\.chat\.persistWorkspaceHistory'\)\) \{\s*void this\.clearPersistedConversationOnOptOut\(\);/u);
		assert.match(source, /this\.conversationPersistenceConfigurationBinding\.dispose\(\);/u);
		const clearMethodStart = source.indexOf('private async clearPersistedConversationOnOptOut');
		const clearMethodEnd = source.indexOf('\n\tprivate ', clearMethodStart + 1);
		const clearMethod = source.slice(clearMethodStart, clearMethodEnd);
		assert.ok(clearMethodStart > 0 && clearMethodEnd > clearMethodStart);
		assert.match(clearMethod, /clearPersistedConversationSnapshotIfDisabled\(\s*this\.conversationPersistenceEnabled\(\),/u);
		assert.match(clearMethod, /workspaceState\.update\(FikeyaWebviewViewProvider\.conversationKey, undefined\)/u);
		assert.doesNotMatch(clearMethod, /this\.state\s*=/u, 'turning persistence off must keep the process-local conversation');
	});

	test('surfaces exact changed-file and Qarinah capture evidence', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /outcome-file-operation/u);
		assert.match(source, /\{0\} lines touched · \+\{1\} \/ -\{2\}/u);
		assert.match(source, /Before and after SHA-256/u);
		assert.match(source, /Saved run evidence/u);
		assert.match(source, /Saved history retained \{0\} of \{1\} measured regular-file content-change entries/u);
		assert.match(source, /runEvidence: projectConversationRunEvidence\(result\.value\)/u);
		assert.match(source, /Recorded in Qarinah · \{0\} run events/u);
		assert.match(source, /The workspace ledger now has \{0\} events/u);
		assert.match(source, /Qarinah capture could not be confirmed\. The ledger may contain partial run events/u);
		assert.doesNotMatch(source, /Qarinah did not record this run/u);
		assert.match(source, /Showing \{0\} of \{1\} measured regular-file content changes; accounting was incomplete/u);
		assert.match(source, /Qarinah retained \{0\} measured regular-file content-change entries/u);
		assert.match(source, /No regular-file content changes were measured; accounting was incomplete/u);
		assert.match(source, /Qarinah retained 12 of \{0\} bounded tool-outcome entries/u);
		assert.match(source, /Provider-attempt accounting is unavailable for this legacy runtime result/u);
		assert.match(source, /This legacy runtime proves at least \{0\} provider attempts/u);
		assert.match(source, /\{0\} provider requests were attempted; \{1\} completed with durable receipt IDs/u);
		assert.match(source, /\{0\} measured regular-file content changes · \{1\}\/\{2\} test commands passed/u);
		assert.doesNotMatch(source, /\{1\}\/\{2\} tests passed/u);
		assert.match(source, /Scope: regular-file content changes only; runtime\/VCS state, installed dependencies, virtual environments, and conventional build, distribution, coverage, and tool-cache trees are excluded/u);
		assert.doesNotMatch(source, /provider && item\.status === 'completed'/u);
		assert.match(source, /status: result\.value\.status/u);
		assert.match(source, /structuredRuntimeFailure === 'quota'/u);
		assert.match(source, /await this\.offerProviderHandoff\(prompt, maxOutputTokens, contextMaxCharacters, memoryMode/u);
		assert.match(source, /Qarinah evidence is recompiled when enabled and available/u);
		assert.doesNotMatch(source, /same Qarinah project context/u);
		assert.match(source, /receipts: captureReceipts/u);
		assert.match(source, /this\.state\.agent\.sessionId !== captureSessionId \|\| this\.state\.agent\.callId !== captureCallId/u);
		assert.doesNotMatch(source, /\{0\} files saved/u);
		const methodStart = source.indexOf('\tprivate async runAgent(');
		const methodEnd = source.indexOf('\n\tprivate async saveWorkspaceEditsBeforeAgentRun(', methodStart);
		const method = source.slice(methodStart, methodEnd);
		const barrier = method.indexOf('this.beginQarinahCapture();');
		const releaseOperation = method.indexOf('this.activeAgentRun = undefined;');
		const receipts = method.indexOf('await this.refreshReceipts(false);');
		const capture = method.indexOf('await captureCompletedFikeyaRun({');
		const releaseBarrier = method.lastIndexOf('this.endQarinahCapture();');
		assert.ok(barrier > 0 && releaseOperation > barrier && receipts > releaseOperation
			&& capture > receipts && releaseBarrier > capture, 'single-run finalization must hold the Qarinah barrier before exposing terminal state');
	});

	test('publishes terminal multi-agent evidence, completes lead reads, then durably captures advisors', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		const methodStart = source.indexOf('\tprivate async runMultiAgent(');
		const methodEnd = source.indexOf('\n\tprivate async proposePlan(', methodStart);
		assert.ok(methodStart > 0 && methodEnd > methodStart);
		const method = source.slice(methodStart, methodEnd);
		const terminalPersist = method.lastIndexOf('await this.persistConversation();');
		const terminalRefresh = method.indexOf('this.refresh();', terminalPersist);
		const leadRun = method.indexOf('await this.runAgent(');
		const advisorCapture = method.lastIndexOf('await this.captureCompletedMultiAgentRuns(captureInputs,');
		assert.ok(terminalPersist > 0 && terminalRefresh > terminalPersist && leadRun > terminalRefresh && advisorCapture > leadRun);
		assert.match(method, /Qarinah rejects a read if its ledger changes mid-read/u);
		assert.ok(method.indexOf('await this.withQarinahCapture(async () => {') < leadRun);
		assert.ok(method.lastIndexOf('this.activeMultiAgentRun = undefined;') > advisorCapture);
		assert.doesNotMatch(method, /await captureCompletedFikeyaRun\(/u);
		assert.match(source, /await captureCompletedFikeyaRuns\(inputs\)/u);
		assert.match(source, /this\.state\.conversation\.some\(message => message\.id === originatingMessageId\)/u);
	});

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

	test('keeps first-run model connection focused and moves custom provider fields behind Advanced', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		const modalStart = source.indexOf('<dialog class="provider-modal"');
		const modalEnd = source.indexOf('</dialog>', modalStart);
		const modal = source.slice(modalStart, modalEnd);
		assert.ok(modalStart > 0 && modalEnd > modalStart);
		assert.match(source, /1\. Open and prepare your project/u);
		assert.match(source, /2\. Connect one coding model/u);
		assert.match(modal, /Connect a model/u);
		assert.match(modal, /data-provider-advanced/u);
		assert.ok(modal.indexOf('data-provider-advanced') < modal.indexOf('name="profileLabel"'));
		assert.ok(modal.indexOf('data-provider-advanced') < modal.indexOf('name="baseUrl"'));
		assert.match(source, /profileLabel = providerLabelField\?\.value\?\.trim\(\) \|\| selected\?\.dataset\.label \|\| ''/u);
		assert.match(source, /providerAdvanced\.open = !selected\.dataset\.baseUrl/u);
		assert.match(source, /is ready\. Test the connection now\?/u);
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
		assert.match(source, /CodeFiles/u);
		assert.match(source, /application\/vnd\.code\.uri-list/u);
		assert.match(source, /this\.projectPanelRequired = true/u);
		assert.match(source, /if \(this\.projectPanelRequired && !this\.disposed && !this\.panel\)/u);
		assert.doesNotMatch(source, /data-layout-switch/u);
	});

	test('keeps temporary full access explicit and immediately revocable', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /class="full-access-indicator" data-command="fikeya\.dangerousLocalMode\.disable"/u);
		assert.match(source, /Full Access · \{0\} min/u);
		assert.match(source, /process-local and is never restored after restart/u);
	});

	test('initializes Fikeya and retries Qarinah before accepting any coding request', async () => {
		const source = await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		assert.match(source, /private workspaceInitialization: Thenable<boolean> \| undefined/u);
		assert.match(source, /private qarinahWorkspaceInitialized = false/u);
		assert.match(source, /this\.state\.workspaceInitialized && this\.qarinahWorkspaceInitialized/u);
		assert.match(source, /this\.qarinahWorkspaceInitialized = memoryInitialization\.ok/u);
		assert.match(source, /Run Fikeya: Initialize Workspace to retry/u);
		assert.match(source, /if \(this\.workspaceInitialization\) \{\s*return this\.workspaceInitialization;/u);
		for (const method of ['runAgent', 'runMultiAgent', 'proposePlan', 'startProject']) {
			const methodStart = source.indexOf(`private async ${method}`);
			assert.notStrictEqual(methodStart, -1, `${method} must exist`);
			const nextMethod = source.indexOf('\n\tprivate ', methodStart + 1);
			const methodSource = source.slice(methodStart, nextMethod === -1 ? source.length : nextMethod);
			const initializationIndex = methodSource.indexOf('ensureWorkspaceInitialized');
			const acceptanceIndex = methodSource.indexOf('onAccepted?.()');
			assert.ok(initializationIndex >= 0, `${method} must initialize the workspace`);
			assert.ok(acceptanceIndex > initializationIndex, `${method} must initialize before accepting the composer request`);
		}
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
