/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import type { FikeyaUiNotification } from '@fikeya/protocol';
import type { FikeyaPlanSpecification } from './runtime';
import { agentComposerConstraints, FikeyaAgentMemoryMode, FikeyaAgentMode, isAgentComposerNumberValid } from './agentComposer';
import { FikeyaTextFileInput, parseTextFileInputs } from './fileInputs';
import { FikeyaImageInput, parseImageInputs } from './imageInputs';

export const fikeyaComposerModes = ['ask', 'plan', 'build', 'review', 'research'] as const;
export type FikeyaComposerMode = typeof fikeyaComposerModes[number];
export type FikeyaAgentComposerMode = Exclude<FikeyaComposerMode, 'plan'>;

/** Maps the validated composer intent onto the narrower mode contract the current runtime accepts. */
export function runtimeModeForComposerMode(mode: FikeyaAgentComposerMode): FikeyaAgentMode {
	return mode === 'research' ? 'research' : 'agent';
}

export type FikeyaWebviewMessage =
	| { readonly type: 'openCommand'; readonly command: FikeyaCommand }
	| { readonly type: 'refreshProviders' }
	| { readonly type: 'webviewReady' }
	| { readonly type: 'pickMentionFiles'; readonly source: 'workspace' | 'computer' }
	| { readonly type: 'attachDroppedResources'; readonly resourceUris: readonly string[] }
	| { readonly type: 'setComposerAttachmentState'; readonly hasAttachments: boolean }
	| { readonly type: 'configureProviderProfile'; readonly providerId: string; readonly profileLabel: string; readonly baseUrl: string; readonly model: string; readonly secret?: string }
	| { readonly type: 'testProvider'; readonly providerName: string }
	| { readonly type: 'removeProvider'; readonly providerName: string }
	| { readonly type: 'runAgent'; readonly requestId?: string; readonly providerName: string; readonly prompt: string; readonly maxOutputTokens: number; readonly contextMaxCharacters: number; readonly memoryMode: FikeyaAgentMemoryMode; readonly composerMode: FikeyaAgentComposerMode; readonly mode: FikeyaAgentMode; readonly images: readonly FikeyaImageInput[]; readonly files: readonly FikeyaTextFileInput[]; readonly allowNetwork: true }
	| { readonly type: 'runMultiAgent'; readonly requestId?: string; readonly selectedAgentIds: readonly string[]; readonly leadProviderName: string; readonly prompt: string; readonly composerMode: FikeyaAgentComposerMode; readonly maxConcurrency: number; readonly maxOutputTokens: number; readonly contextMaxCharacters: number; readonly memoryMode: FikeyaAgentMemoryMode; readonly allowNetwork: true }
	| { readonly type: 'proposePlan'; readonly requestId?: string; readonly providerName: string; readonly prompt: string; readonly maxOutputTokens: number; readonly contextMaxCharacters: number; readonly memoryMode: FikeyaAgentMemoryMode; readonly composerMode: 'plan'; readonly images: readonly FikeyaImageInput[]; readonly files: readonly FikeyaTextFileInput[]; readonly allowNetwork: true }
	| { readonly type: 'startProject'; readonly requestId?: string; readonly providerName: string; readonly goal: string; readonly allowNetwork: true }
	| { readonly type: 'projectAction'; readonly action: 'refresh' | 'resume' | 'cancel'; readonly goal?: string; readonly providerName?: string }
	| { readonly type: 'cancelAgent' }
	| { readonly type: 'createPlan'; readonly specification: FikeyaPlanSpecification }
	| { readonly type: 'newPlan' }
	| { readonly type: 'restorePlan' }
	| { readonly type: 'refreshPlan' }
	| { readonly type: 'selectSurface'; readonly surface: 'chat' | 'plan' | 'context' | 'usage' }
	| { readonly type: 'planAction'; readonly action: 'review' | 'approve-all' | 'approve-step' | 'run' | 'resume' | 'cancel'; readonly stepId?: string }
	| { readonly type: 'clearConversation' }
	| { readonly type: 'restoreConversation' }
	| { readonly type: 'copyConversationMessage'; readonly messageId: string }
	| { readonly type: 'copyText'; readonly text: string }
	| { readonly type: 'openFile'; readonly path: string }
	| { readonly type: 'openExternal'; readonly url: string }
	| { readonly type: 'reviewDiff'; readonly content: string }
	| { readonly type: 'refreshReceipts' }
	| { readonly type: 'refreshStatistics' }
	| { readonly type: 'refreshMemory' };

export type FikeyaCommand =
	| 'fikeya.configureProvider'
	| 'fikeya.configureAgents'
	| 'fikeya.initializeWorkspace'
	| 'fikeya.runDoctor'
	| 'fikeya.mode.editor'
	| 'fikeya.mode.agent'
	| 'fikeya.mode.terminal'
	| 'fikeya.mode.review'
	| 'fikeya.mode.research'
	| 'fikeya.mode.lab'
	| 'fikeya.view.usage'
	| 'fikeya.view.setup'
	| 'fikeya.layout.project'
	| 'fikeya.layout.editor'
	| 'workbench.action.files.openFolder';

const allowedCommands: readonly FikeyaCommand[] = [
	'fikeya.configureProvider',
	'fikeya.configureAgents',
	'fikeya.initializeWorkspace',
	'fikeya.runDoctor',
	'fikeya.mode.editor',
	'fikeya.mode.agent',
	'fikeya.mode.terminal',
	'fikeya.mode.review',
	'fikeya.mode.research',
	'fikeya.mode.lab',
	'fikeya.view.usage',
	'fikeya.view.setup',
	'fikeya.layout.project',
	'fikeya.layout.editor',
	'workbench.action.files.openFolder'
];

const maximumPromptBytes = 262_144;
const maximumPlanSpecificationBytes = 1_048_576;
const maximumDroppedResourceCount = 32;
const maximumResourceUriLength = 4_096;
const providerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const requestIdPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const conversationMessageIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const supportedPlanTools = new Set([
	'browser.assert_text',
	'browser.click',
	'browser.close',
	'browser.navigate',
	'browser.screenshot',
	'browser.scroll',
	'browser.snapshot',
	'browser.type',
	'browser.wait',
	'process.run',
	'workspace.list_files',
	'workspace.read_file',
	'workspace.replace_text',
	'workspace.search_text',
	'workspace.write_file'
]);

/** Parses one untrusted webview message into the small command surface the extension accepts. */
export function parseWebviewMessage(value: unknown): FikeyaWebviewMessage | undefined {
	value = unwrapUiNotification(value);
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
		case 'webviewReady':
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
		case 'pickMentionFiles':
			return value.source === 'workspace' || value.source === 'computer'
				? { type: value.type, source: value.source }
				: undefined;
		case 'attachDroppedResources':
			return Array.isArray(value.resourceUris)
				&& value.resourceUris.length > 0
				&& value.resourceUris.length <= maximumDroppedResourceCount
				&& value.resourceUris.every(resourceUri => typeof resourceUri === 'string'
					&& resourceUri.length > 0
					&& resourceUri.length <= maximumResourceUriLength)
				? { type: value.type, resourceUris: value.resourceUris as string[] }
				: undefined;
		case 'configureProviderProfile': {
			if (!isProviderName(value.providerId)
				|| typeof value.profileLabel !== 'string'
				|| value.profileLabel.trim().length < 1
				|| value.profileLabel.trim().length > 80
				|| value.profileLabel.trim() !== value.profileLabel
				|| typeof value.baseUrl !== 'string'
				|| value.baseUrl.length > 4_096
				|| value.baseUrl.trim() !== value.baseUrl
				|| typeof value.model !== 'string'
				|| value.model.trim().length < 1
				|| value.model.trim().length > 160
				|| value.model.trim() !== value.model
				|| (value.secret !== undefined && (typeof value.secret !== 'string' || value.secret.length < 1 || value.secret.length > 16_384 || value.secret.trim() !== value.secret))) {
				return undefined;
			}
			return {
				type: value.type,
				providerId: value.providerId,
				profileLabel: value.profileLabel,
				baseUrl: value.baseUrl,
				model: value.model,
				...(value.secret === undefined ? {} : { secret: value.secret })
			};
		}
		case 'setComposerAttachmentState':
			return typeof value.hasAttachments === 'boolean'
				? { type: value.type, hasAttachments: value.hasAttachments }
				: undefined;
		case 'copyConversationMessage':
			return typeof value.messageId === 'string' && conversationMessageIdPattern.test(value.messageId)
				? { type: value.type, messageId: value.messageId }
				: undefined;
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
			const images = parseImageInputs(value.images);
			const files = parseTextFileInputs(value.files);
			if ((value.requestId !== undefined && !parseRequestId(value.requestId))
				|| !isProviderName(value.providerName)
				|| typeof value.prompt !== 'string'
				|| value.prompt.trim().length === 0
				|| Buffer.byteLength(value.prompt, 'utf8') > maximumPromptBytes
				|| value.allowNetwork !== true
				|| typeof value.maxOutputTokens !== 'number'
				|| !isAgentComposerNumberValid(value.maxOutputTokens, agentComposerConstraints.maxOutputTokens)
				|| typeof value.contextMaxCharacters !== 'number'
				|| !isAgentComposerNumberValid(value.contextMaxCharacters, agentComposerConstraints.contextMaxCharacters)
				|| (value.memoryMode !== 'auto' && value.memoryMode !== 'off' && value.memoryMode !== 'required')
				|| images === undefined
				|| files === undefined
				// Runtime mode is derived below so untrusted UI code cannot select a different execution contract.
				|| value.mode !== undefined) {
				return undefined;
			}
			const request = {
				...(parseRequestId(value.requestId) ? { requestId: value.requestId as string } : {}),
				providerName: value.providerName,
				prompt: value.prompt,
				maxOutputTokens: value.maxOutputTokens,
				contextMaxCharacters: value.contextMaxCharacters,
				memoryMode: value.memoryMode as FikeyaAgentMemoryMode,
				images,
				files,
				allowNetwork: true as const
			};
			if (value.type === 'runAgent') {
				if (!isFikeyaAgentComposerMode(value.composerMode)) {
					return undefined;
				}
				return {
					type: 'runAgent',
					...request,
					composerMode: value.composerMode,
					mode: runtimeModeForComposerMode(value.composerMode)
				};
			}
			return value.composerMode === 'plan'
				? { type: 'proposePlan', ...request, composerMode: 'plan' }
				: undefined;
		}
		case 'runMultiAgent': {
			if ((value.requestId !== undefined && !parseRequestId(value.requestId))
				|| !isProviderName(value.leadProviderName)
				|| typeof value.prompt !== 'string'
				|| value.prompt.trim().length === 0
				|| Buffer.byteLength(value.prompt, 'utf8') > maximumPromptBytes
				|| value.allowNetwork !== true
				|| typeof value.maxConcurrency !== 'number'
				|| !Number.isSafeInteger(value.maxConcurrency)
				|| value.maxConcurrency < 1
				|| value.maxConcurrency > 8
				|| typeof value.maxOutputTokens !== 'number'
				|| !isAgentComposerNumberValid(value.maxOutputTokens, agentComposerConstraints.maxOutputTokens)
				|| typeof value.contextMaxCharacters !== 'number'
				|| !isAgentComposerNumberValid(value.contextMaxCharacters, agentComposerConstraints.contextMaxCharacters)
				|| (value.memoryMode !== 'auto' && value.memoryMode !== 'off' && value.memoryMode !== 'required')
				|| !isFikeyaAgentComposerMode(value.composerMode)
				|| !Array.isArray(value.selectedAgentIds)
				|| value.selectedAgentIds.length < 1
				|| value.selectedAgentIds.length > 16
				|| new Set(value.selectedAgentIds).size !== value.selectedAgentIds.length
				|| value.selectedAgentIds.some(agentId => !isProviderName(agentId))) {
				return undefined;
			}
			return {
				type: value.type,
				...(parseRequestId(value.requestId) ? { requestId: value.requestId as string } : {}),
				selectedAgentIds: value.selectedAgentIds as string[],
				leadProviderName: value.leadProviderName,
				prompt: value.prompt,
				composerMode: value.composerMode,
				maxConcurrency: value.maxConcurrency,
				maxOutputTokens: value.maxOutputTokens,
				contextMaxCharacters: value.contextMaxCharacters,
				memoryMode: value.memoryMode as FikeyaAgentMemoryMode,
				allowNetwork: true
			};
		}
		case 'startProject':
			return (value.requestId === undefined || parseRequestId(value.requestId) !== undefined)
				&& isProviderName(value.providerName)
				&& typeof value.goal === 'string'
				&& value.goal.trim().length > 0
				&& Buffer.byteLength(value.goal.trim(), 'utf8') <= 65_536
				&& value.allowNetwork === true
				? { type: value.type, ...(parseRequestId(value.requestId) ? { requestId: value.requestId as string } : {}), providerName: value.providerName, goal: value.goal.trim(), allowNetwork: true }
				: undefined;
		case 'projectAction': {
			if (value.action === 'refresh' || value.action === 'cancel') {
				return value.goal === undefined && value.providerName === undefined ? { type: value.type, action: value.action } : undefined;
			}
			if (value.action === 'resume') {
				if (!isProviderName(value.providerName)) {
					return undefined;
				}
				return value.goal === undefined
					? { type: value.type, action: value.action, providerName: value.providerName }
					: typeof value.goal === 'string' && value.goal.trim().length > 0 && Buffer.byteLength(value.goal.trim(), 'utf8') <= 65_536
						? { type: value.type, action: value.action, goal: value.goal.trim(), providerName: value.providerName }
						: undefined;
			}
			return undefined;
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

function parseRequestId(value: unknown): value is string {
	return typeof value === 'string' && requestIdPattern.test(value);
}

function isFikeyaAgentComposerMode(value: unknown): value is FikeyaAgentComposerMode {
	return value === 'ask' || value === 'build' || value === 'review' || value === 'research';
}

function unwrapUiNotification(value: unknown): unknown {
	if (!isRecord(value) || !('jsonrpc' in value || 'method' in value || 'params' in value)) {
		return value;
	}
	const envelope = value as Partial<FikeyaUiNotification>;
	if (envelope.jsonrpc !== '2.0'
		|| typeof envelope.method !== 'string'
		|| !envelope.method.startsWith('ui.')
		|| !isRecord(envelope.params)
		|| typeof envelope.params.type !== 'string') {
		return undefined;
	}
	const action = envelope.method.slice(3);
	if (envelope.params.type !== action) {
		return undefined;
	}
	return envelope.params;
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
