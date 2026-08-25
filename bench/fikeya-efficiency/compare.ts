#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const RECEIPT_SCHEMA_VERSION = '1.0.0';

export const MATCHED_FIELD_PATHS = Object.freeze([
	'task.suite',
	'task.suiteVersion',
	'task.taskId',
	'task.trial',
	'task.promptSha256',
	'task.startingStateSha256',
	'task.graderSha256',
	'model.provider',
	'model.name',
	'model.apiVersion',
	'model.reasoningEffort',
	'model.temperature',
	'model.maxOutputTokens',
	'conditions.toolContractSha256',
	'conditions.networkAllowlistSha256',
	'environment.imageDigest',
	'environment.os',
	'environment.architecture',
	'environment.networkPolicy',
	'limits.wallClockMs',
	'limits.maxTurns',
	'limits.maxToolCalls',
	'limits.maxRetries',
	'pricing.currency',
	'pricing.snapshotDate',
	'pricing.uncachedInputPerMillion',
	'pricing.cachedInputPerMillion',
	'pricing.outputPerMillion'
]);

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-fA-F0-9]{64}$/;

function fail(message) {
	throw new Error(message);
}

function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueAt(record, path) {
	return path.split('.').reduce((value, segment) => value?.[segment], record);
}

function requireObject(record, path) {
	const value = valueAt(record, path);
	if (!isObject(value)) {
		fail(`${path} must be an object`);
	}
	return value;
}

function requireString(record, path) {
	const value = valueAt(record, path);
	if (typeof value !== 'string' || value.length === 0) {
		fail(`${path} must be a non-empty string`);
	}
	return value;
}

function requireNumber(record, path, { integer = false, minimum = 0, exclusive = false } = {}) {
	const value = valueAt(record, path);
	const belowMinimum = exclusive ? value <= minimum : value < minimum;
	if (typeof value !== 'number' || !Number.isFinite(value) || belowMinimum || (integer && !Number.isInteger(value))) {
		const qualifier = integer ? 'integer' : 'finite number';
		const comparison = exclusive ? 'greater than' : 'at least';
		fail(`${path} must be a ${qualifier} ${comparison} ${minimum}`);
	}
	return value;
}

function requireBoolean(record, path) {
	const value = valueAt(record, path);
	if (typeof value !== 'boolean') {
		fail(`${path} must be a boolean`);
	}
	return value;
}

function requireSha256(record, path) {
	const value = requireString(record, path);
	if (!SHA256_PATTERN.test(value)) {
		fail(`${path} must be a 64-character SHA-256 hex digest`);
	}
	return value;
}

function requireEnum(record, path, allowed) {
	const value = valueAt(record, path);
	if (!allowed.includes(value)) {
		fail(`${path} must be one of: ${allowed.join(', ')}`);
	}
	return value;
}

export function validateReceipt(record, expectedArm) {
	if (!isObject(record)) {
		fail('receipt must be a JSON object');
	}

	if (record.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
		fail(`schemaVersion must equal ${RECEIPT_SCHEMA_VERSION}`);
	}

	requireEnum(record, 'arm', ['baseline', 'fikeya']);
	if (expectedArm && record.arm !== expectedArm) {
		fail(`arm must equal ${expectedArm} for this input, received ${record.arm}`);
	}
	requireString(record, 'runId');

	for (const path of ['task', 'model', 'agent', 'conditions', 'environment', 'limits', 'pricing', 'outcome', 'usage', 'timing']) {
		requireObject(record, path);
	}

	for (const path of ['task.suite', 'task.suiteVersion', 'task.taskId']) {
		requireString(record, path);
	}
	requireNumber(record, 'task.trial', { integer: true, minimum: 1 });
	for (const path of ['task.promptSha256', 'task.startingStateSha256', 'task.graderSha256', 'agent.configSha256', 'conditions.toolContractSha256', 'conditions.networkAllowlistSha256']) {
		requireSha256(record, path);
	}

	for (const path of ['model.provider', 'model.name', 'model.apiVersion', 'model.reasoningEffort', 'agent.name', 'agent.version', 'environment.os', 'environment.architecture']) {
		requireString(record, path);
	}
	requireNumber(record, 'model.temperature');
	requireNumber(record, 'model.maxOutputTokens', { integer: true, minimum: 1 });

	const imageDigest = requireString(record, 'environment.imageDigest');
	if (!IMAGE_DIGEST_PATTERN.test(imageDigest)) {
		fail('environment.imageDigest must be a sha256:<64 hex characters> digest');
	}
	requireEnum(record, 'environment.networkPolicy', ['disabled', 'allowlist', 'unrestricted']);

	for (const path of ['limits.wallClockMs', 'limits.maxTurns', 'limits.maxToolCalls']) {
		requireNumber(record, path, { integer: true, minimum: 1 });
	}
	requireNumber(record, 'limits.maxRetries', { integer: true });

	if (record.pricing.currency !== 'USD') {
		fail('pricing.currency must equal USD');
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(requireString(record, 'pricing.snapshotDate'))) {
		fail('pricing.snapshotDate must use YYYY-MM-DD');
	}
	for (const path of ['pricing.uncachedInputPerMillion', 'pricing.cachedInputPerMillion', 'pricing.outputPerMillion']) {
		requireNumber(record, path);
	}

	const verified = requireBoolean(record, 'outcome.verified');
	const testsPassed = requireNumber(record, 'outcome.testsPassed', { integer: true });
	const testsTotal = requireNumber(record, 'outcome.testsTotal', { integer: true, minimum: 1 });
	if (testsPassed > testsTotal) {
		fail('outcome.testsPassed cannot exceed outcome.testsTotal');
	}
	if (verified !== (testsPassed === testsTotal)) {
		fail('outcome.verified must equal whether every recorded test passed');
	}

	for (const path of ['usage.uncachedInputTokens', 'usage.cachedInputTokens', 'usage.outputTokens', 'usage.reasoningTokens']) {
		requireNumber(record, path, { integer: true });
	}
	if (record.usage.reasoningTokens > record.usage.outputTokens) {
		fail('usage.reasoningTokens must be a subset of usage.outputTokens');
	}
	requireNumber(record, 'usage.toolFeesUsd');
	requireNumber(record, 'timing.durationMs', { minimum: 0, exclusive: true });

	return record;
}

export function parseJsonl(text, expectedArm, source = '<memory>') {
	const records = [];
	for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
		const line = rawLine.trim();
		if (line.length === 0) {
			continue;
		}
		let record;
		try {
			record = JSON.parse(line);
		} catch (error) {
			fail(`${source}:${index + 1} is not valid JSON: ${error.message}`);
		}
		try {
			validateReceipt(record, expectedArm);
		} catch (error) {
			fail(`${source}:${index + 1}: ${error.message}`);
		}
		records.push(record);
	}
	if (records.length === 0) {
		fail(`${source} contains no receipts`);
	}
	return records;
}

function pairKey(record) {
	return `${record.task.suite}@${record.task.suiteVersion}/${record.task.taskId}#${record.task.trial}`;
}

function indexByPair(records, arm) {
	const index = new Map();
	for (const record of records) {
		validateReceipt(record, arm);
		const key = pairKey(record);
		if (index.has(key)) {
			fail(`${arm} contains duplicate receipt pair ${key}`);
		}
		index.set(key, record);
	}
	if (index.size === 0) {
		fail(`${arm} contains no receipts`);
	}
	return index;
}

function stableValue(value) {
	return JSON.stringify(value);
}

function assertMatchedPair(key, baseline, fikeya) {
	for (const path of MATCHED_FIELD_PATHS) {
		const baselineValue = valueAt(baseline, path);
		const fikeyaValue = valueAt(fikeya, path);
		if (stableValue(baselineValue) !== stableValue(fikeyaValue)) {
			fail(`unmatched comparison at ${key}: ${path} differs (${stableValue(baselineValue)} vs ${stableValue(fikeyaValue)})`);
		}
	}
}

function round(value) {
	return Number(value.toFixed(12));
}

export function runCostUsd(record) {
	validateReceipt(record);
	return round(
		(record.usage.uncachedInputTokens * record.pricing.uncachedInputPerMillion / 1_000_000) +
		(record.usage.cachedInputTokens * record.pricing.cachedInputPerMillion / 1_000_000) +
		(record.usage.outputTokens * record.pricing.outputPerMillion / 1_000_000) +
		record.usage.toolFeesUsd
	);
}

export function quantile(values, probability) {
	if (!Array.isArray(values) || values.length === 0) {
		fail('quantile requires at least one value');
	}
	if (typeof probability !== 'number' || probability < 0 || probability > 1) {
		fail('quantile probability must be between 0 and 1');
	}
	const sorted = [...values].sort((left, right) => left - right);
	const position = (sorted.length - 1) * probability;
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	if (lowerIndex === upperIndex) {
		return sorted[lowerIndex];
	}
	const weight = position - lowerIndex;
	return round(sorted[lowerIndex] + ((sorted[upperIndex] - sorted[lowerIndex]) * weight));
}

function aggregate(records) {
	const verifiedTaskCount = records.filter(record => record.outcome.verified).length;
	const totalCostUsd = round(records.reduce((total, record) => total + runCostUsd(record), 0));
	const tokenTotals = records.reduce((totals, record) => {
		totals.uncachedInput += record.usage.uncachedInputTokens;
		totals.cachedInput += record.usage.cachedInputTokens;
		totals.output += record.usage.outputTokens;
		totals.reasoningSubsetOfOutput += record.usage.reasoningTokens;
		return totals;
	}, { uncachedInput: 0, cachedInput: 0, output: 0, reasoningSubsetOfOutput: 0 });
	tokenTotals.totalBilled = tokenTotals.uncachedInput + tokenTotals.cachedInput + tokenTotals.output;

	return {
		runCount: records.length,
		verifiedTaskCount,
		verifiedSolveRate: round(verifiedTaskCount / records.length),
		totalCostUsd,
		costPerVerifiedTaskUsd: verifiedTaskCount === 0 ? null : round(totalCostUsd / verifiedTaskCount),
		billedTokens: tokenTotals,
		latencyMs: {
			p50: quantile(records.map(record => record.timing.durationMs), 0.5),
			p95: quantile(records.map(record => record.timing.durationMs), 0.95)
		}
	};
}

function nullableDifference(fikeya, baseline) {
	return fikeya === null || baseline === null ? null : round(fikeya - baseline);
}

export function compareReceipts(baselineRecords, fikeyaRecords) {
	const baselineByPair = indexByPair(baselineRecords, 'baseline');
	const fikeyaByPair = indexByPair(fikeyaRecords, 'fikeya');
	const baselineKeys = [...baselineByPair.keys()].sort();
	const fikeyaKeys = [...fikeyaByPair.keys()].sort();
	if (stableValue(baselineKeys) !== stableValue(fikeyaKeys)) {
		const missingFromFikeya = baselineKeys.filter(key => !fikeyaByPair.has(key));
		const missingFromBaseline = fikeyaKeys.filter(key => !baselineByPair.has(key));
		fail(`unmatched receipt sets: missing from fikeya [${missingFromFikeya.join(', ')}]; missing from baseline [${missingFromBaseline.join(', ')}]`);
	}

	for (const key of baselineKeys) {
		assertMatchedPair(key, baselineByPair.get(key), fikeyaByPair.get(key));
	}

	const baseline = aggregate(baselineRecords);
	const fikeya = aggregate(fikeyaRecords);
	return {
		reportVersion: '1.0.0',
		status: 'matched',
		pairCount: baselineKeys.length,
		matchedFields: [...MATCHED_FIELD_PATHS],
		baseline,
		fikeya,
		delta: {
			verifiedSolveRate: nullableDifference(fikeya.verifiedSolveRate, baseline.verifiedSolveRate),
			totalCostUsd: nullableDifference(fikeya.totalCostUsd, baseline.totalCostUsd),
			costPerVerifiedTaskUsd: nullableDifference(fikeya.costPerVerifiedTaskUsd, baseline.costPerVerifiedTaskUsd),
			billedTokens: nullableDifference(fikeya.billedTokens.totalBilled, baseline.billedTokens.totalBilled),
			latencyP50Ms: nullableDifference(fikeya.latencyMs.p50, baseline.latencyMs.p50),
			latencyP95Ms: nullableDifference(fikeya.latencyMs.p95, baseline.latencyMs.p95)
		}
	};
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--baseline' || argument === '--fikeya') {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) {
				fail(`${argument} requires a file path`);
			}
			options[argument.slice(2)] = value;
			index += 1;
		} else if (argument === '--help' || argument === '-h') {
			options.help = true;
		} else {
			fail(`unknown argument: ${argument}`);
		}
	}
	return options;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		console.log('Usage: node compare.mjs --baseline <baseline.jsonl> --fikeya <fikeya.jsonl>');
		return;
	}
	if (!options.baseline || !options.fikeya) {
		fail('both --baseline and --fikeya are required');
	}
	const [baselineText, fikeyaText] = await Promise.all([
		readFile(options.baseline, 'utf8'),
		readFile(options.fikeya, 'utf8')
	]);
	const report = compareReceipts(
		parseJsonl(baselineText, 'baseline', options.baseline),
		parseJsonl(fikeyaText, 'fikeya', options.fikeya)
	);
	console.log(JSON.stringify(report, null, 2));
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
	main().catch(error => {
		console.error(`benchmark comparison rejected: ${error.message}`);
		process.exitCode = 1;
	});
}
