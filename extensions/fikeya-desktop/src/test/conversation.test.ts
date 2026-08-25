/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appendConversationMessage, FikeyaConversationMessage } from '../conversation';

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
});
