/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export const fikeyaModes = ['editor', 'agent', 'terminal', 'review'] as const;
export const fikeyaLayouts = ['studio', 'agentFocus'] as const;

export type FikeyaMode = typeof fikeyaModes[number];
export type FikeyaLayout = typeof fikeyaLayouts[number];

export type FikeyaWebviewMessage =
	| { readonly type: 'openCommand'; readonly command: FikeyaCommand }
	| { readonly type: 'selectMode'; readonly mode: FikeyaMode }
	| { readonly type: 'switchLayout'; readonly layout: FikeyaLayout }
	| { readonly type: 'refreshProviders' }
	| { readonly type: 'testProvider'; readonly providerName: string }
	| { readonly type: 'removeProvider'; readonly providerName: string }
	| { readonly type: 'runAgent'; readonly providerName: string; readonly prompt: string; readonly maxOutputTokens: number; readonly contextMaxCharacters: number; readonly memoryMode: 'auto' | 'off' | 'required'; readonly allowNetwork: true }
	| { readonly type: 'cancelAgent' }
	| { readonly type: 'refreshReceipts' }
	| { readonly type: 'refreshMemory' };

export type FikeyaCommand =
	| 'fikeya.configureProvider'
	| 'fikeya.initializeWorkspace'
	| 'fikeya.runDoctor';

const allowedCommands: readonly FikeyaCommand[] = [
	'fikeya.configureProvider',
	'fikeya.initializeWorkspace',
	'fikeya.runDoctor'
];

const maximumPromptBytes = 262_144;
const providerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

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
		case 'selectMode': {
			if (typeof value.mode === 'string' && fikeyaModes.includes(value.mode as FikeyaMode)) {
				return { type: value.type, mode: value.mode as FikeyaMode };
			}
			return undefined;
		}
		case 'switchLayout': {
			if (typeof value.layout === 'string' && fikeyaLayouts.includes(value.layout as FikeyaLayout)) {
				return { type: value.type, layout: value.layout as FikeyaLayout };
			}
			return undefined;
		}
		case 'refreshProviders':
		case 'cancelAgent':
		case 'refreshReceipts':
		case 'refreshMemory':
			return { type: value.type };
		case 'testProvider':
		case 'removeProvider': {
			if (isProviderName(value.providerName)) {
				return { type: value.type, providerName: value.providerName };
			}
			return undefined;
		}
		case 'runAgent': {
			if (!isProviderName(value.providerName)
				|| typeof value.prompt !== 'string'
				|| value.prompt.trim().length === 0
				|| Buffer.byteLength(value.prompt, 'utf8') > maximumPromptBytes
				|| value.allowNetwork !== true
				|| typeof value.maxOutputTokens !== 'number'
				|| !Number.isSafeInteger(value.maxOutputTokens)
				|| value.maxOutputTokens < 1
				|| value.maxOutputTokens > 32_768
				|| typeof value.contextMaxCharacters !== 'number'
				|| !Number.isSafeInteger(value.contextMaxCharacters)
				|| value.contextMaxCharacters < 512
				|| value.contextMaxCharacters > 64_000
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
		default:
			return undefined;
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
