/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	FikeyaAgentProfile,
	FikeyaAgentProfileState,
	FikeyaAgentProfileStore,
	parseFikeyaAgentProfiles
} from '../agentProfiles';

function profile(id: string, providerName = 'openrouter-primary'): FikeyaAgentProfile {
	return {
		schemaVersion: 1,
		id,
		displayName: `Agent ${id}`,
		providerName,
		role: 'reviewer',
		instruction: 'Review independently and cite exact evidence.',
		maxOutputTokens: 2_048,
		contextMaxCharacters: 12_000,
		memoryMode: 'auto'
	};
}

class MemoryState implements FikeyaAgentProfileState {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

describe('Fikeya agent profiles', () => {
	test('persists bounded profiles without provider credentials', async () => {
		const store = new FikeyaAgentProfileStore(new MemoryState());
		await store.upsert(profile('reviewer'));
		await store.upsert(profile('planner', 'azure-primary'));
		await store.upsert({ ...profile('reviewer'), displayName: 'Security reviewer' });

		assert.deepStrictEqual(store.load(), [
			{ ...profile('reviewer'), displayName: 'Security reviewer' },
			profile('planner', 'azure-primary')
		]);
		assert.deepStrictEqual(await store.remove('reviewer'), [profile('planner', 'azure-primary')]);
	});

	test('rejects duplicate, oversized, and credential-bearing profile shapes', () => {
		assert.deepStrictEqual(parseFikeyaAgentProfiles([profile('same'), profile('same')]), []);
		assert.deepStrictEqual(parseFikeyaAgentProfiles([{ ...profile('large'), instruction: 'x'.repeat(8_193) }]), []);
		assert.deepStrictEqual(parseFikeyaAgentProfiles([{ ...profile('secret'), apiKey: 'must-not-be-stored' }]), []);
	});
});
