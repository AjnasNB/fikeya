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
	| { readonly type: 'switchLayout'; readonly layout: FikeyaLayout };

export type FikeyaCommand =
	| 'fikeya.configureProvider'
	| 'fikeya.initializeWorkspace'
	| 'fikeya.runDoctor';

const allowedCommands: readonly FikeyaCommand[] = [
	'fikeya.configureProvider',
	'fikeya.initializeWorkspace',
	'fikeya.runDoctor'
];

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
		default:
			return undefined;
	}
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
