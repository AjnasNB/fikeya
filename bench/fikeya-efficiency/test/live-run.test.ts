import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalDecision, environmentMatches, grade, summarize } from '../live-run.ts';

test('evaluation rejects a changed installation even at the same package version', () => {
	const expected = { packages: { core: { version: '0.1.0b8', sourceSha256: 'before' } } };
	assert(environmentMatches(expected, structuredClone(expected)));
	assert(!environmentMatches(expected, { packages: { core: { version: '0.1.0b8', sourceSha256: 'after' } } }));
});

test('grader requires the exact independent answer', () => {
	assert(grade('{"answer":4317}', 4317));
	assert(grade('```json\n{"answer":false}\n```', false));
	assert(!grade('{"answer":"4317"}', 4317));
	assert(!grade('Looks correct', 4317));
	assert(!grade('{"answer":4317,"extra":true}', 4317));
});
test('harness approves only reads of the authored fixture', () => {
	assert.equal(approvalDecision({toolName: 'workspace.list_files', arguments: {path: '.'}}), 'allow_once');
	assert.equal(approvalDecision({toolName: 'workspace.list_files', arguments: {path: '..'}}), 'deny_once');
	assert.equal(approvalDecision({toolName: 'workspace.read_file', arguments: {path: 'config.json'}}), 'allow_once');
	for (const message of [
		{toolName: 'workspace.write_file', arguments: {path: 'config.json'}},
		{toolName: 'workspace.read_file', arguments: {path: '../config.json'}},
		{toolName: 'process.run', arguments: {command: 'python'}},
		{toolName: 'browser.navigate', arguments: {url: 'https://example.com'}}
	]) assert.equal(approvalDecision(message), 'deny_once');
});
test('failed attempts remain in totals and missing usage is never zero', () => {
	const records = [
		{arm: 'full-context', verified: true, durationMs: 100, usage: {measurement: 'provider-reported', inputTokens: 4, cachedInputTokens: 0, outputTokens: 2}},
		{arm: 'full-context', verified: false, durationMs: 80, usage: null}
	];
	const total = summarize(records)['full-context'];
	assert.equal(total.attempts, 2);
	assert.equal(total.verified, 1);
	assert.equal(total.inputTokens, null);
	assert.equal(total.costUsd, null);
	assert.equal(total.totalDurationMs, 180);
});
