import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compareReceipts, parseJsonl, quantile, runCostUsd, validateReceipt } from '../compare.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures');

async function loadFixture(name, arm) {
	const text = await readFile(join(fixtureRoot, name), 'utf8');
	return parseJsonl(text, arm, name);
}

function clone(value) {
	return structuredClone(value);
}

describe('Fikeya efficiency comparison', () => {
	it('computes deterministic aggregate metrics for matched synthetic receipts', async () => {
		const baseline = await loadFixture('synthetic-baseline.jsonl', 'baseline');
		const fikeya = await loadFixture('synthetic-fikeya.jsonl', 'fikeya');
		const report = compareReceipts(baseline, fikeya);

		assert.equal(report.status, 'matched');
		assert.equal(report.pairCount, 2);
		assert.equal(report.baseline.verifiedSolveRate, 0.5);
		assert.equal(report.fikeya.verifiedSolveRate, 0.5);
		assert.equal(report.baseline.totalCostUsd, 0.01436);
		assert.equal(report.fikeya.totalCostUsd, 0.01436);
		assert.equal(report.baseline.costPerVerifiedTaskUsd, 0.01436);
		assert.equal(report.fikeya.costPerVerifiedTaskUsd, 0.01436);
		assert.equal(report.baseline.billedTokens.totalBilled, 4300);
		assert.equal(report.fikeya.billedTokens.totalBilled, 4300);
		assert.deepEqual(report.baseline.latencyMs, { p50: 20000, p95: 29000 });
		assert.deepEqual(report.fikeya.latencyMs, { p50: 20000, p95: 24500 });
		assert.equal(report.delta.totalCostUsd, 0);
		assert.equal(report.delta.billedTokens, 0);
	});

	it('uses output tokens as the billed total while treating reasoning as a subset', async () => {
		const [receipt] = await loadFixture('synthetic-baseline.jsonl', 'baseline');
		assert.equal(runCostUsd(receipt), 0.00534);
	});

	it('rejects a comparison with a different model', async () => {
		const baseline = await loadFixture('synthetic-baseline.jsonl', 'baseline');
		const fikeya = clone(await loadFixture('synthetic-fikeya.jsonl', 'fikeya'));
		fikeya[0].model.name = 'different-model';
		assert.throws(() => compareReceipts(baseline, fikeya), /model\.name differs/u);
	});

	it('rejects incomplete receipts', async () => {
		const [receipt] = clone(await loadFixture('synthetic-baseline.jsonl', 'baseline'));
		delete receipt.usage.outputTokens;
		assert.throws(() => validateReceipt(receipt, 'baseline'), /usage\.outputTokens/u);
	});

	it('rejects unpaired task attempts', async () => {
		const baseline = await loadFixture('synthetic-baseline.jsonl', 'baseline');
		const fikeya = await loadFixture('synthetic-fikeya.jsonl', 'fikeya');
		assert.throws(() => compareReceipts(baseline, fikeya.slice(0, 1)), /unmatched receipt sets/u);
	});

	it('rejects duplicate pair keys', async () => {
		const baseline = await loadFixture('synthetic-baseline.jsonl', 'baseline');
		const fikeya = await loadFixture('synthetic-fikeya.jsonl', 'fikeya');
		assert.throws(() => compareReceipts([...baseline, clone(baseline[0])], fikeya), /duplicate receipt pair/u);
	});

	it('rejects a verified outcome that disagrees with its tests', async () => {
		const [receipt] = clone(await loadFixture('synthetic-baseline.jsonl', 'baseline'));
		receipt.outcome.verified = false;
		assert.throws(() => validateReceipt(receipt, 'baseline'), /outcome\.verified/u);
	});

	it('uses deterministic linear interpolation for quantiles', () => {
		assert.equal(quantile([30, 10], 0.5), 20);
		assert.equal(quantile([30, 10], 0.95), 29);
	});
});
