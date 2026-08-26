/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderSafeMarkdown } from '../markdown';

const labels = { copy: 'Copy', reviewDiff: 'Review diff' };

describe('safe chat Markdown', () => {
	test('renders paragraphs, lists, inline code, and fenced code', () => {
		const html = renderSafeMarkdown('**Result** with `npm test`.\n\n- one\n- two\n\n```ts\nconst ok = true;\n```', labels);
		assert.match(html, /<strong>Result<\/strong>/);
		assert.match(html, /<code>npm test<\/code>/);
		assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
		assert.match(html, /data-code-language="ts"/);
	});

	test('escapes raw HTML and does not emit unsafe links', () => {
		const html = renderSafeMarkdown('<script>alert(1)</script> [bad](javascript:alert(1)) [file](src/index.ts)', labels);
		assert.strictEqual(html.includes('<script'), false);
		assert.strictEqual(html.includes('<SCRIPT'), false);
		assert.doesNotMatch(html, /javascript:/);
		assert.match(html, /data-open-file="src\/index\.ts"/);
	});

	test('marks a diff as reviewable without treating its content as HTML', () => {
		const html = renderSafeMarkdown('```diff\n-<script>\n+safe\n```', labels);
		assert.match(html, /data-review-diff/);
		assert.match(html, /-&lt;script&gt;/);
	});
});
