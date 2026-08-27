/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export type FikeyaAgentMemoryMode = 'auto' | 'off' | 'required';
export type FikeyaAgentMode = 'agent' | 'research';

export interface FikeyaAgentRequest {
	readonly providerName: string;
	readonly prompt: string;
	readonly maxOutputTokens: number;
	readonly contextMaxCharacters: number;
	readonly memoryMode: FikeyaAgentMemoryMode;
	readonly mode: FikeyaAgentMode;
	readonly allowNetwork: true;
}

interface FikeyaAgentNumberConstraint {
	readonly minimum: number;
	readonly maximum: number;
	readonly step: number;
}

export const agentComposerDefaults = {
	contextMaxCharacters: 12_000,
	maxOutputTokens: 1_024,
	memoryMode: 'auto'
} as const;

export const agentComposerConstraints = {
	contextMaxCharacters: { minimum: 512, maximum: 64_000, step: 1 },
	maxOutputTokens: { minimum: 1, maximum: 32_768, step: 1 }
} as const satisfies Record<'contextMaxCharacters' | 'maxOutputTokens', FikeyaAgentNumberConstraint>;

/** Returns whether an integer satisfies the same native number-input contract rendered by Chat. */
export function isAgentComposerNumberValid(value: number, constraint: FikeyaAgentNumberConstraint): boolean {
	return Number.isSafeInteger(value)
		&& value >= constraint.minimum
		&& value <= constraint.maximum
		&& (value - constraint.minimum) % constraint.step === 0;
}

/** Routes one validated Chat request to the selected provider invocation boundary. */
export async function invokeAgentRunRequest(
	request: FikeyaAgentRequest,
	invoke: (
		providerName: string,
		prompt: string,
		maxOutputTokens: number,
		contextMaxCharacters: number,
		memoryMode: FikeyaAgentMemoryMode,
		mode: FikeyaAgentMode
	) => Promise<void>
): Promise<void> {
	await invoke(request.providerName, request.prompt, request.maxOutputTokens, request.contextMaxCharacters, request.memoryMode, request.mode);
}

/** Keeps the visible conversation human-readable while giving Research mode a real bounded contract. */
export function buildAgentProviderPrompt(mode: FikeyaAgentMode, prompt: string): string {
	if (mode !== 'research') {
		return prompt;
	}
	return [
		'Fikeya Research mode.',
		'Investigate the question before proposing changes. Distinguish project evidence from inference, cite relevant project paths, and state what remains unverified.',
		'Do not modify files or run mutating tools unless the user explicitly asks for an implementation and approves the exact tool call.',
		'',
		'Question:',
		prompt
	].join('\n');
}
