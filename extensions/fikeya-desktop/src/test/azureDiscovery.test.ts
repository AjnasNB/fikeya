/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAzureOpenAIDeployments, parseAzureOpenAIResources, parseAzureSubscriptions } from '../azureDiscovery';

describe('Azure discovery response validation', () => {
	test('accepts bounded subscription, account, and deployment records', () => {
		assert.deepStrictEqual(parseAzureSubscriptions([{ id: 'sub-1', name: 'Development' }]), [{ id: 'sub-1', name: 'Development' }]);
		assert.deepStrictEqual(parseAzureOpenAIResources([{ name: 'fikeya-ai', resourceGroup: 'fikeya-rg', endpoint: 'https://fikeya.openai.azure.com/' }]), [{ name: 'fikeya-ai', resourceGroup: 'fikeya-rg', endpoint: 'https://fikeya.openai.azure.com' }]);
		assert.deepStrictEqual(parseAzureOpenAIDeployments([{ name: 'coding', model: 'gpt-5.4-mini', version: '2026-01-01' }]), [{ name: 'coding', model: 'gpt-5.4-mini', version: '2026-01-01' }]);
	});

	test('fails closed for mixed, insecure, or oversized responses', () => {
		assert.deepStrictEqual(parseAzureSubscriptions([{ id: 'sub-1', name: 'Good' }, { id: '', name: 'Bad' }]), []);
		assert.deepStrictEqual(parseAzureOpenAIResources([{ name: 'fikeya-ai', resourceGroup: 'rg', endpoint: 'http://example.com' }]), []);
		assert.deepStrictEqual(parseAzureOpenAIDeployments(new Array(1_001).fill({ name: 'coding', model: 'model' })), []);
	});
});
