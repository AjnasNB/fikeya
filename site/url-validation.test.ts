import assert from 'node:assert/strict';
import test from 'node:test';

import { hasExactSecureHref } from './url-validation.ts';

const trusted = 'https://qarinah.io/docs/benchmarks/';

test('accepts an exact quoted HTTPS href', () => {
	assert.equal(hasExactSecureHref(`<a href="${trusted}">Method</a>`, trusted), true);
	assert.equal(hasExactSecureHref(`<a href='${trusted}'>Method</a>`, trusted), true);
});

test('rejects a trusted URL embedded in an attacker-controlled URL', () => {
	for (const malicious of [
		`https://evil.example/?next=${trusted}`,
		`https://evil.example/${trusted}`,
		'https://qarinah.io.evil.example/docs/benchmarks/',
		'https://qarinah.io/docs/benchmarks/.evil',
		`${trusted}?redirect=https://evil.example/`,
		`${trusted}#https://evil.example/`
	]) {
		assert.equal(
			hasExactSecureHref(`<a href="${malicious}">Method</a>`, trusted),
			false,
			malicious
		);
	}
});

test('ignores matching text outside href attributes and rejects credentials', () => {
	assert.equal(hasExactSecureHref(`<p>${trusted}</p>`, trusted), false);
	assert.equal(
		hasExactSecureHref('<a href="https://user:pass@qarinah.io/docs/benchmarks/">Method</a>', trusted),
		false
	);
});

test('requires a valid secure expected URL', () => {
	assert.equal(hasExactSecureHref('<a href="http://example.test/">x</a>', 'http://example.test/'), false);
	assert.equal(hasExactSecureHref('<a href="https://example.test/">x</a>', 'not a URL'), false);
});
