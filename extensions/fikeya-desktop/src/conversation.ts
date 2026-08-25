/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export type FikeyaConversationRole = 'user' | 'assistant' | 'notice';

export interface FikeyaConversationMessage {
	readonly id: string;
	readonly role: FikeyaConversationRole;
	readonly content: string;
	readonly createdAt: string;
	readonly providerName?: string;
	readonly tone?: 'normal' | 'error';
}

const maximumMessages = 48;
const maximumMessageCharacters = 240_000;
const maximumConversationCharacters = 960_000;

/**
 * Keeps the live chat useful without turning the extension host into an unbounded transcript
 * store. Conversation content remains process-local; durable project evidence belongs to
 * Qarinah and content-free execution metadata belongs to Fikeya Runtime.
 */
export function appendConversationMessage(
	messages: readonly FikeyaConversationMessage[],
	message: FikeyaConversationMessage
): readonly FikeyaConversationMessage[] {
	const boundedMessage = {
		...message,
		content: boundMessageContent(message.content)
	};
	const retained = [...messages.slice(-(maximumMessages - 1)), boundedMessage];
	let totalCharacters = retained.reduce((total, item) => total + item.content.length, 0);
	while (retained.length > 1 && totalCharacters > maximumConversationCharacters) {
		const removed = retained.shift();
		totalCharacters -= removed?.content.length ?? 0;
	}
	return retained;
}

function boundMessageContent(content: string): string {
	if (content.length <= maximumMessageCharacters) {
		return content;
	}
	return `${content.slice(0, maximumMessageCharacters)}\n\n[Conversation preview truncated. The execution receipt remains available.]`;
}
