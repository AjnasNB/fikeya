/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildTeamLeadPrompt } from '../teamLead';

describe('Fikeya team lead handoff', () => {
	test('joins parallel specialist results into one bounded verification-first lead task', () => {
		const prompt = buildTeamLeadPrompt('Fix the failing parser.', [
			{ name: 'Security', role: 'reviewer', output: 'Validate the input before parsing.' },
			{ name: 'Tests', role: 'researcher', output: 'The malformed-input case is missing.' }
		]);
		assert.match(prompt, /Original task:\nFix the failing parser\./u);
		assert.match(prompt, /## Security \(reviewer\)/u);
		assert.match(prompt, /## Tests \(researcher\)/u);
		assert.match(prompt, /Verify important claims yourself/u);
		assert.ok(Buffer.byteLength(prompt, 'utf8') <= 250_000);
	});

	test('bounds large Unicode specialist results without splitting the lead contract', () => {
		const prompt = buildTeamLeadPrompt('Inspect the repository.', [
			{ name: 'Research', role: 'researcher', output: '🧠'.repeat(100_000) }
		]);
		assert.ok(Buffer.byteLength(prompt, 'utf8') <= 250_000);
		assert.match(prompt, /Lead responsibility:/u);
		assert.doesNotMatch(prompt, /�/u);
	});
});
