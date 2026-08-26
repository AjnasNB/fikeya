/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import type { FikeyaPlanSpecification } from './runtime';
import { agentComposerConstraints, FikeyaAgentMemoryMode, isAgentComposerNumberValid } from './agentComposer';

export type FikeyaWebviewMessage =
	| { readonly type: 'openCommand'; readonly command: FikeyaCommand }
	| { readonly type: 'refreshProviders' }
	| { readonly type: 'testProvider'; readonly providerName: string }
	| { readonly type: 'removeProvider'; readonly providerName: string }
	| { readonly type: 'runAgent'; readonly providerName: string; readonly prompt: string; readonly maxOutputTokens: number; readonly contextMaxCharacters: number; readonly memoryMode: FikeyaAgentMemoryMode; readonly allowNetwork: true }
	| { readonly type: 'proposePlan'; readonly providerName: string; readonly prompt: string; readonly maxOutputTokens: number; readonly contextMaxCharacters: number; readonly memoryMode: FikeyaAgentMemoryMode; readonly allowNetwork: true }
	| { readonly type: 'cancelAgent' }
	| { readonly type: 'createPlan'; readonly specification: FikeyaPlanSpecification }
	| { readonly type: 'newPlan' }
	| { readonly type: 'restorePlan' }
	| { readonly type: 'refreshPlan' }
	| { readonly type: 'selectSurface'; readonly surface: 'chat' | 'plan' | 'context' | 'usage' }
	| { readonly type: 'planAction'; readonly action: 'review' | 'approve-all' | 'approve-step' | 'run' | 'resume' | 'cancel'; readonly stepId?: string }
	| { readonly type: 'clearConversation' }
	| { readonly type: 'restoreConversation' }
	| { readonly type: 'copyText'; readonly text: string }
	| { readonly type: 'openFile'; readonly path: string }
	| { readonly type: 'openExternal'; readonly url: string }
	| { readonly type: 'reviewDiff'; readonly content: string }
	| { readonly type: 'refreshReceipts' }
	| { readonly type: 'refreshStatistics' }
	| { readonly type: 'refreshMemory' };

export type FikeyaCommand =
	| 'fikeya.configureProvider'
	| 'fikeya.initializeWorkspace'
	| 'fikeya.runDoctor'
	| 'fikeya.mode.editor'
	| 'fikeya.mode.agent'
	| 'fikeya.mode.terminal'
	| 'fikeya.mode.review'
	| 'fikeya.mode.research'
	| 'fikeya.mode.lab'
	| 'fikeya.view.usage'
	| 'fikeya.view.setup';

const allowedCommands: readonly FikeyaCommand[] = [
	'fikeya.configureProvider',
	'fikeya.initializeWorkspace',
	'fikeya.runDoctor',
	'fikeya.mode.editor',
	'fikeya.mode.agent',
	'fikeya.mode.terminal',
	'fikeya.mode.review',
	'fikeya.mode.research',
	'fikeya.mode.lab',
	'fikeya.view.usage',
	'fikeya.view.setup'
];

const maximumPromptBytes = 262_144;
const maximumPlanSpecificationBytes = 1_048_576;
const providerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const supportedPlanTools = new Set(['process.run', 'workspace.list_files', 'workspace.read_file', 'workspace.replace_text', 'workspace.search_text', 'workspace.write_file']);

/** Parses one untrusted webview message into the small command surface the extension accepts. */
export function parseWebviewMessage(value: unknown): FikeyaWebviewMessage | undefined {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return undefined;
	}

	switch (value.type) {
		case 'openCommand': {
			if (typeof value.command === 'string' && allowedCommands.includes(value.command as FikeyaCommand)) {
				return { type: value.type, command: value.command as FikeyaCommand };
			}
			return undefined;
		}
		case 'refreshProviders':
		case 'cancelAgent':
		case 'newPlan':
		case 'restorePlan':
		case 'refreshPlan':
		case 'clearConversation':
		case 'restoreConversation':
		case 'refreshReceipts':
		case 'refreshStatistics':
		case 'refreshMemory':
			return { type: value.type };
		case 'copyText':
			return typeof value.text === 'string' && Buffer.byteLength(value.text, 'utf8') <= maximumPromptBytes
				? { type: value.type, text: value.text }
				: undefined;
		case 'reviewDiff':
			return typeof value.content === 'string' && value.content.trim().length > 0 && Buffer.byteLength(value.content, 'utf8') <= maximumPromptBytes
				? { type: value.type, content: value.content }
				: undefined;
		case 'openFile':
			return typeof value.path === 'string' && isProjectRelativeVerificationPath(value.path) && value.path.length <= 4096
				? { type: value.type, path: value.path }
				: undefined;
		case 'openExternal': {
			if (typeof value.url !== 'string' || value.url.length > 4096) {
				return undefined;
			}
			try {
				const url = new URL(value.url);
				return url.protocol === 'https:' ? { type: value.type, url: url.toString() } : undefined;
			} catch {
				return undefined;
			}
		}
		case 'testProvider':
		case 'removeProvider': {
			if (isProviderName(value.providerName)) {
				return { type: value.type, providerName: value.providerName };
			}
			return undefined;
		}
		case 'runAgent':
		case 'proposePlan': {
			if (!isProviderName(value.providerName)
				|| typeof value.prompt !== 'string'
				|| value.prompt.trim().length === 0
				|| Buffer.byteLength(value.prompt, 'utf8') > maximumPromptBytes
				|| value.allowNetwork !== true
				|| typeof value.maxOutputTokens !== 'number'
				|| !isAgentComposerNumberValid(value.maxOutputTokens, agentComposerConstraints.maxOutputTokens)
				|| typeof value.contextMaxCharacters !== 'number'
				|| !isAgentComposerNumberValid(value.contextMaxCharacters, agentComposerConstraints.contextMaxCharacters)
				|| (value.memoryMode !== 'auto' && value.memoryMode !== 'off' && value.memoryMode !== 'required')) {
				return undefined;
			}
			return {
				type: value.type,
				providerName: value.providerName,
				prompt: value.prompt,
				maxOutputTokens: value.maxOutputTokens,
				contextMaxCharacters: value.contextMaxCharacters,
				memoryMode: value.memoryMode,
				allowNetwork: true
			};
		}
		case 'createPlan': {
			const specification = parsePlanSpecification(value.specification);
			return specification ? { type: value.type, specification } : undefined;
		}
		case 'selectSurface':
			return value.surface === 'chat' || value.surface === 'plan' || value.surface === 'context' || value.surface === 'usage'
				? { type: value.type, surface: value.surface }
				: undefined;
		case 'planAction': {
			if (value.action === 'approve-step') {
				return isProviderName(value.stepId)
					? { type: value.type, action: value.action, stepId: value.stepId }
					: undefined;
			}
			if (value.action === 'review' || value.action === 'approve-all' || value.action === 'run' || value.action === 'resume' || value.action === 'cancel') {
				return value.stepId === undefined ? { type: value.type, action: value.action } : undefined;
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

function parsePlanSpecification(value: unknown): FikeyaPlanSpecification | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ['steps', 'title'], ['schemaVersion'])
		|| (value.schemaVersion !== undefined && value.schemaVersion !== 1)
		|| typeof value.title !== 'string' || value.title.trim().length === 0 || Buffer.byteLength(value.title, 'utf8') > 4_096
		|| !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 64) {
		return undefined;
	}
	const identifiers = new Set<string>();
	const callIdentifiers = new Set<string>();
	const normalizedSteps: Record<string, unknown>[] = [];
	for (const candidate of value.steps) {
		if (!isRecord(candidate) || !hasExactKeys(candidate, ['stepId', 'title', 'toolCall'], ['dependsOn', 'verify'])
			|| !isProviderName(candidate.stepId)
			|| identifiers.has(candidate.stepId)
			|| typeof candidate.title !== 'string' || candidate.title.trim().length === 0 || Buffer.byteLength(candidate.title, 'utf8') > 4_096
			|| (candidate.dependsOn !== undefined && (!Array.isArray(candidate.dependsOn)
				|| new Set(candidate.dependsOn).size !== candidate.dependsOn.length
				|| candidate.dependsOn.some(dependency => !isProviderName(dependency) || !identifiers.has(dependency))))
			|| !isRecord(candidate.toolCall)
			|| !hasExactKeys(candidate.toolCall, ['arguments', 'callId', 'name'])
			|| !isProviderName(candidate.toolCall.callId)
			|| callIdentifiers.has(candidate.toolCall.callId)
			|| typeof candidate.toolCall.name !== 'string' || !supportedPlanTools.has(candidate.toolCall.name)
			|| !isRecord(candidate.toolCall.arguments)
			|| !hasBoundedFiniteJsonEncoding(candidate.toolCall.arguments, 65_536)) {
			return undefined;
		}
		const verificationSpec = parsePlanVerificationSpecification(candidate.verify);
		if (!verificationSpec) {
			return undefined;
		}
		identifiers.add(candidate.stepId);
		callIdentifiers.add(candidate.toolCall.callId);
		normalizedSteps.push({
			dependsOn: candidate.dependsOn ?? [],
			order: normalizedSteps.length + 1,
			stepId: candidate.stepId,
			title: candidate.title.trim(),
			toolCall: candidate.toolCall,
			toolCallSha256: `sha256:${'0'.repeat(64)}`,
			verificationSpec
		});
	}
	if (!hasBoundedFiniteJsonEncoding({ steps: normalizedSteps, title: value.title.trim() }, maximumPlanSpecificationBytes)) {
		return undefined;
	}
	return value as unknown as FikeyaPlanSpecification;
}

function parsePlanVerificationSpecification(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) {
		return { expectedExitCode: null, expectedOutputSha256: null, expectedStatus: 'ok', files: [] };
	}
	if (!isRecord(value) || !hasExactKeys(value, [], ['expectedExitCode', 'expectedOutputSha256', 'expectedStatus', 'files'])) {
		return undefined;
	}
	const expectedStatus = value.expectedStatus ?? 'ok';
	const expectedExitCode = value.expectedExitCode ?? null;
	const expectedOutputSha256 = value.expectedOutputSha256 ?? null;
	const files = value.files ?? [];
	if (!['ok', 'denied', 'error'].includes(expectedStatus as string)
		|| (expectedExitCode !== null && (typeof expectedExitCode !== 'number' || !Number.isSafeInteger(expectedExitCode) || expectedExitCode < -65_535 || expectedExitCode > 2_147_483_647))
		|| (expectedOutputSha256 !== null && (typeof expectedOutputSha256 !== 'string' || !sha256Pattern.test(expectedOutputSha256)))
		|| !Array.isArray(files) || files.length > 64) {
		return undefined;
	}
	const paths = new Set<string>();
	const normalizedFiles: Record<string, string>[] = [];
	for (const candidate of files) {
		if (!isRecord(candidate) || !hasExactKeys(candidate, ['path', 'sha256'])
			|| typeof candidate.path !== 'string' || !isProjectRelativeVerificationPath(candidate.path)
			|| paths.has(candidate.path)
			|| typeof candidate.sha256 !== 'string' || !sha256Pattern.test(candidate.sha256)) {
			return undefined;
		}
		paths.add(candidate.path);
		normalizedFiles.push({ path: candidate.path, sha256: candidate.sha256 });
	}
	return { expectedExitCode, expectedOutputSha256, expectedStatus, files: normalizedFiles };
}

function isProjectRelativeVerificationPath(value: string): boolean {
	if (!value || value === '.' || value.includes('\\') || value.startsWith('/') || /[:?#\u0000-\u001f]/.test(value)) {
		return false;
	}
	const parts = value.split('/');
	return !parts.some(part => part.length === 0 || part === '.' || part === '..' || part.toLowerCase() === '.fikeya');
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

function hasBoundedFiniteJsonEncoding(value: unknown, maximumBytes: number): boolean {
	const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		visited += 1;
		if (visited > 32_768 || current.depth > 64) {
			return false;
		}
		if (current.value === null || typeof current.value === 'string' || typeof current.value === 'boolean') {
			continue;
		}
		if (typeof current.value === 'number') {
			if (!Number.isFinite(current.value)) {
				return false;
			}
			continue;
		}
		if (Array.isArray(current.value)) {
			for (const item of current.value) {
				pending.push({ value: item, depth: current.depth + 1 });
			}
			continue;
		}
		if (!isRecord(current.value)) {
			return false;
		}
		for (const item of Object.values(current.value)) {
			pending.push({ value: item, depth: current.depth + 1 });
		}
	}
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes;
	} catch {
		return false;
	}
}

function isProviderName(value: unknown): value is string {
	return typeof value === 'string' && providerNamePattern.test(value);
}

/** Escapes text before it is interpolated into a webview HTML document. */
export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
