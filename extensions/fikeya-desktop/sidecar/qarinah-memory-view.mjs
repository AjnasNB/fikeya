/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
// These relative imports keep the sidecar executable in a source checkout. The VSIX
// packager follows the same files and bundles them into a self-contained sidecar.
import { buildMemoryDashboard } from '../node_modules/qarinah/src/dashboard.js';
import { compileContext } from '../node_modules/qarinah/src/compiler.js';
import { redactText } from '../node_modules/qarinah/src/redact.js';
import { appendEvent } from '../node_modules/qarinah/src/store.js';
import { initializeWorkspace, loadWorkspace } from '../node_modules/qarinah/src/workspace.js';

const maximumInputBytes = 1024 * 1024;
const maximumBatchInputBytes = 16 * maximumInputBytes;
const root = readRoot(process.argv.slice(2));
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
let handled = false;

lines.on('line', line => {
	if (handled) {
		return;
	}
	handled = true;
	void handleLine(line).finally(() => lines.close());
});

async function handleLine(line) {
	let request;
	const inputBytes = Buffer.byteLength(line, 'utf8');
	if (inputBytes > maximumBatchInputBytes) {
		writeError(null, -32600, 'Protocol message exceeds the bounded batch limit.');
		return;
	}
	try {
		request = JSON.parse(line);
	} catch {
		writeError(null, -32700, 'Invalid JSON.');
		return;
	}
	if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.id !== 'string'
		|| !['memory.initialize', 'memory.inspect', 'memory.prepare', 'memory.record', 'memory.captureRun', 'memory.captureRuns'].includes(request.method) || !isRecord(request.params)) {
		writeError(isRecord(request) && typeof request.id === 'string' ? request.id : null, -32600, 'Invalid request.');
		return;
	}
	if (request.method !== 'memory.captureRuns' && inputBytes > maximumInputBytes) {
		writeError(request.id, -32600, 'Protocol message exceeds the one-megabyte limit.');
		return;
	}

	try {
		if (request.method === 'memory.initialize') {
			const workspace = await initializeWorkspace(root, { ifNeeded: true });
			write({
				jsonrpc: '2.0',
				id: request.id,
				result: {
					schemaVersion: 'qarinah.workspace-initialization.v1',
					workspaceId: workspace.config.workspaceId,
					capture: workspace.config.capture
				}
			});
			return;
		}
		if (request.method === 'memory.prepare') {
			const query = boundedString(request.params.query, 'query', 4_096);
			const maximumCharacters = boundedInteger(request.params.maxChars, 'maxChars', 512, 64_000);
			const limit = boundedInteger(request.params.limit, 'limit', 1, 100);
			const minimumCoverage = boundedEnum(request.params.minimumCoverage, 'minimumCoverage', ['any', 'partial', 'direct']);
			const compiled = await compileContext(query, {
				cwd: root,
				maxChars: maximumCharacters,
				limit,
				minimumCoverage,
				minimumEvidence: 'any',
				includeEvidenceSufficiency: true,
				rebuild: true,
				updateCheckpoint: true
			});
			write({ jsonrpc: '2.0', id: request.id, result: compiled });
			return;
		}
		if (request.method === 'memory.record') {
			const kind = boundedEnum(request.params.kind, 'kind', ['artifact', 'decision', 'summary', 'tool.completed', 'turn.completed']);
			const title = boundedString(request.params.title, 'title', 512);
			await initializeWorkspace(root, { ifNeeded: true });
			const event = await appendEvent({
				kind,
				actor: { type: 'system', id: 'fikeya.desktop' },
				title,
				body: '',
				data: { source: 'fikeya.desktop' },
				confidence: 'verified',
				relations: [],
				provenance: { adapter: 'fikeya.desktop' },
				retention: { class: 'project', expiresAt: null }
			}, { cwd: root });
			write({
				jsonrpc: '2.0',
				id: request.id,
				result: {
					schemaVersion: 'qarinah.memory-record.v1',
					eventId: event.eventId,
					eventHash: event.hash,
					kind: event.kind
				}
			});
			return;
		}
		if (request.method === 'memory.captureRun') {
			const result = await captureRun(request.params);
			write({ jsonrpc: '2.0', id: request.id, result });
			return;
		}
		if (request.method === 'memory.captureRuns') {
			const result = await captureRuns(request.params);
			write({ jsonrpc: '2.0', id: request.id, result });
			return;
		}
		const dashboard = await buildMemoryDashboard({ cwd: root });
		const compactView = {
			schemaVersion: 'qarinah.developer-memory-view.v1',
			generatedAt: dashboard.generatedAt,
			workspace: {
				name: dashboard.workspace.name,
				eventCount: dashboard.workspace.eventCount,
				ledgerHeadHash: dashboard.workspace.ledgerHeadHash
			},
			graph: dashboard.linkedGraph
		};
		const manifestHash = `sha256:${createHash('sha256').update(JSON.stringify(compactView)).digest('hex')}`;
		write({ jsonrpc: '2.0', id: request.id, result: { ...compactView, manifestHash } });
	} catch {
		// The provider error is deliberately hidden from the webview boundary.
		writeError(request.id, -32000, 'Qarinah memory is unavailable for this workspace.');
	}
}

function readRoot(argv) {
	const index = argv.indexOf('--root');
	if (index === -1 || typeof argv[index + 1] !== 'string' || argv[index + 1].trim().length === 0) {
		process.stderr.write('Fikeya Qarinah memory view requires --root <workspace>.\n');
		process.exit(2);
	}
	return path.resolve(argv[index + 1]);
}

function writeError(id, code, message) {
	write({ jsonrpc: '2.0', id, error: { code, message } });
}

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function captureRuns(params) {
	if (Object.keys(params).length !== 1 || !Array.isArray(params.runs)
		|| params.runs.length < 1 || params.runs.length > 16
		|| params.runs.some(candidate => !isRecord(candidate))) {
		throw new TypeError('runs must contain between one and sixteen capture requests.');
	}
	const workspace = await loadWorkspace(root);
	const results = [];
	for (const run of params.runs) {
		try {
			const singleRequestBytes = Buffer.byteLength(JSON.stringify({
				jsonrpc: '2.0', id: 'fikeya-memory-capture-run', method: 'memory.captureRun', params: run
			}), 'utf8');
			if (singleRequestBytes > maximumInputBytes) {
				throw new TypeError('A capture request exceeds the one-megabyte per-run limit.');
			}
			results.push({ ok: true, receipt: await captureRun(run, { workspace, deferDashboard: true }) });
		} catch {
			// Keep item failures content-free. Any deterministic events appended before an I/O error
			// remain safe to retry and are honestly reported by the desktop as potentially partial.
			results.push({ ok: false });
		}
	}
	const dashboard = results.some(result => result.ok)
		? await buildMemoryDashboard({ cwd: root })
		: null;
	return {
		schemaVersion: 'qarinah.fikeya-run-capture-batch.v1',
		results: results.map(result => result.ok
			? { ok: true, receipt: finalizeCaptureReceipt(result.receipt, dashboard) }
			: result)
	};
}

async function captureRun(params, options = {}) {
	// loadWorkspace enforces an existing enabled workspace and its machine-local consent. Automatic
	// desktop capture never initializes, approves, or widens a Qarinah policy.
	const workspace = options.workspace ?? await loadWorkspace(root);
	const sessionId = boundedString(params.sessionId, 'sessionId', 256);
	const providerAttemptId = params.providerAttemptId === null
		? null
		: boundedString(params.providerAttemptId, 'providerAttemptId', 128);
	const providerAttemptMeasurement = boundedEnum(
		params.providerAttemptMeasurement,
		'providerAttemptMeasurement',
		['exact', 'legacy-minimum', 'unavailable']
	);
	const callId = params.callId === null ? null : boundedString(params.callId, 'callId', 256);
	const prompt = boundedUtf8String(params.prompt, 'prompt', 16_000);
	const promptSha256 = requiredHash(params.promptSha256, 'promptSha256');
	const promptBytes = boundedInteger(params.promptBytes, 'promptBytes', 1, 262_144);
	const promptTruncated = requiredBoolean(params.promptTruncated, 'promptTruncated');
	const capturedPromptBytes = Buffer.byteLength(prompt, 'utf8');
	const capturedPromptSha256 = `sha256:${createHash('sha256').update(prompt, 'utf8').digest('hex')}`;
	if ((!promptTruncated && (promptBytes !== capturedPromptBytes || promptSha256 !== capturedPromptSha256))
		|| (promptTruncated && promptBytes <= capturedPromptBytes)) {
		throw new TypeError('prompt provenance is inconsistent.');
	}
	const provider = requiredRecord(params.provider, 'provider');
	const providerName = boundedString(provider.name, 'provider.name', 128);
	const providerKind = boundedString(provider.kind, 'provider.kind', 80);
	const model = boundedString(provider.model, 'provider.model', 256);
	const usage = normalizeUsage(params.usage);
	const memory = normalizeMemory(params.memory);
	const providerReceipts = normalizeProviderReceipts(params.providerReceipts);
	const providerCallCount = boundedInteger(params.providerCallCount, 'providerCallCount', 0, 128);
	const providerReceiptCount = boundedInteger(params.providerReceiptCount, 'providerReceiptCount', 0, 128);
	const providerReceiptsTruncated = requiredBoolean(params.providerReceiptsTruncated, 'providerReceiptsTruncated');
	if ((providerAttemptId === null) !== (providerCallCount === 0)) {
		throw new TypeError('providerAttemptId must be null exactly when no provider call was attempted.');
	}
	if ((providerAttemptMeasurement === 'unavailable' && providerAttemptId !== null)
		|| (providerAttemptMeasurement === 'legacy-minimum'
			&& (providerAttemptId === null || providerCallCount !== providerReceiptCount))) {
		throw new TypeError('provider attempt measurement is inconsistent with its bounded counts.');
	}
	if ((callId === null) !== (providerReceiptCount === 0)) {
		throw new TypeError('callId must be null exactly when no provider receipt completed.');
	}
	if (providerReceiptCount > providerCallCount || providerReceipts.length > providerReceiptCount
		|| providerReceiptsTruncated !== (providerReceipts.length !== providerReceiptCount)) {
		throw new TypeError('provider receipt counts are inconsistent.');
	}
	const outcome = normalizeOutcome(params.outcome);
	if (outcome.status === 'failed' && providerAttemptMeasurement === 'exact' && outcome.terminalFailure === null) {
		throw new TypeError('An exact failed run requires its terminal failure classification.');
	}
	if (outcome.status === 'completed' && providerReceiptCount === 0) {
		throw new TypeError('A completed run requires a completed provider receipt.');
	}
	if (providerAttemptMeasurement === 'exact' && providerCallCount === 0
		&& (outcome.status !== 'cancelled' || outcome.steps !== 0 || outcome.toolOutcomeCount !== 0
			|| outcome.changedFileCount !== 0 || usage.measurement !== 'unavailable')) {
		throw new TypeError('An exact zero-attempt run must be a pre-provider cancellation without execution evidence.');
	}
	const capture = workspace.config.capture;
	const retention = { class: workspace.config.retentionClass, expiresAt: null };
	const redactedPrompt = redactText(prompt);
	const retainedPrompt = boundedExcerpt(redactedPrompt, 16_000);
	const records = [];
	const eventCorrelationKey = providerAttemptId === null
		? `${sessionId}:no-provider-call`
		: `${sessionId}:${providerAttemptId}`;
	const providerSourceId = providerAttemptId ?? eventCorrelationKey;

	const append = async (eventKey, eventInput) => {
		const event = await appendEvent({
			...eventInput,
			eventId: deterministicEventId(`${eventCorrelationKey}:${eventKey}`),
			retention
		}, { cwd: root, capture, idempotent: true });
		const record = { eventId: event.eventId, eventHash: event.hash, kind: event.kind };
		records.push(record);
		return event;
	};

	const promptEvent = await append('prompt', {
		kind: 'prompt.submitted',
		actor: { type: 'human', id: 'fikeya.desktop.user' },
		sessionId,
		title: 'Fikeya user prompt submitted',
		body: retainedPrompt.text,
		data: {
			source: 'fikeya.desktop',
			promptSha256,
			promptBytes,
			capturedPromptSha256,
			capturedPromptBytes,
			retainedCharacters: retainedPrompt.text.length,
			truncated: promptTruncated || retainedPrompt.truncated
		},
		confidence: 'extracted',
		relations: [],
		provenance: { adapter: 'fikeya.desktop', sourceId: `${sessionId}:prompt` }
	});

	const providerEvent = await append('provider', {
		kind: 'source',
		actor: { type: 'system', id: 'fikeya.desktop' },
		sessionId,
		title: 'Fikeya provider and model selected',
		body: '',
		data: {
			source: 'fikeya.desktop',
			providerAttemptId,
			providerAttemptMeasurement,
			callId,
			providerCallOccurred: providerAttemptMeasurement === 'unavailable' ? null : providerAttemptId !== null,
			providerReceiptCompleted: callId !== null,
			provider: { name: providerName, kind: providerKind, model },
			providerCallCount,
			providerReceiptCount,
			providerReceiptsCaptured: providerReceipts.length,
			providerReceiptsTruncated,
			providerAttemptsWithoutReceipt: providerAttemptMeasurement === 'exact'
				? providerCallCount - providerReceiptCount
				: null,
			providerReceiptDetailsMissing: providerReceipts.length < providerReceiptCount
		},
		confidence: 'extracted',
		relations: [{ type: 'references', target: promptEvent.eventId }],
		provenance: { adapter: 'fikeya.desktop', sourceId: providerSourceId }
	});

	let contextEvent;
	if (memory.status !== 'off') {
		contextEvent = await append('context', {
			kind: 'tool.completed',
			actor: { type: 'tool', id: 'qarinah.context' },
			sessionId,
			title: 'Qarinah context preparation completed',
			body: '',
			data: {
				source: 'fikeya.desktop',
				toolName: 'qarinah.context.prepare',
				status: memory.status,
				coverage: memory.coverage,
				evidenceCount: memory.evidenceCount,
				receiptId: memory.receiptId,
				responseSha256: memory.responseSha256
			},
			confidence: 'verified',
			relations: [{ type: 'derived_from', target: promptEvent.eventId }],
			provenance: { adapter: 'fikeya.desktop', sourceId: memory.receiptId ?? `${sessionId}:context` }
		});
	}

	const toolEvents = [];
	for (const [index, tool] of outcome.toolOutcomes.entries()) {
		const toolEvent = await append(`tool:${index}:${tool.callId}`, {
			kind: 'tool.completed',
			actor: { type: 'tool', id: `fikeya.runtime.${tool.name}` },
			sessionId,
			title: tool.test ? 'Fikeya test command completed' : 'Fikeya tool completed',
			body: '',
			data: {
				source: 'fikeya.desktop',
				...tool
			},
			confidence: 'verified',
			relations: [{ type: 'derived_from', target: providerEvent.eventId }],
			provenance: { adapter: 'fikeya.desktop', sourceId: tool.callId }
		});
		toolEvents.push(toolEvent);
	}

	const turnRelations = [
		{ type: 'derived_from', target: promptEvent.eventId },
		{ type: 'derived_from', target: providerEvent.eventId },
		...(contextEvent ? [{ type: 'derived_from', target: contextEvent.eventId }] : []),
		...toolEvents.map(event => ({ type: 'derived_from', target: event.eventId }))
	];
	const turnCompleted = outcome.status === 'completed';
	const turnEvent = await append('turn', {
		kind: turnCompleted ? 'turn.completed' : 'summary',
		actor: { type: 'agent', id: 'fikeya.runtime' },
		sessionId,
		title: turnCompleted
			? 'Fikeya agent turn completed'
			: outcome.status === 'cancelled'
				? 'Fikeya agent turn cancelled with partial evidence'
				: 'Fikeya agent turn failed with partial evidence',
		body: '',
		data: {
			source: 'fikeya.desktop',
			providerAttemptId,
			providerAttemptMeasurement,
			callId,
			providerCallOccurred: providerAttemptMeasurement === 'unavailable' ? null : providerAttemptId !== null,
			providerReceiptCompleted: callId !== null,
			status: outcome.status,
			provider: { name: providerName, kind: providerKind, model },
			promptSha256,
			usage,
			memory,
			providerCallCount,
			providerReceiptCount,
			providerReceiptsCaptured: providerReceipts.length,
			providerReceiptsTruncated,
			providerReceipts,
			outcome
		},
		confidence: 'verified',
		relations: turnRelations,
		provenance: { adapter: 'fikeya.desktop', sourceId: providerSourceId }
	});

	const captureReceipt = {
		schemaVersion: 'qarinah.fikeya-run-capture.v1',
		capture,
		sessionId,
		outcomeStatus: outcome.status,
		providerAttemptId,
		providerAttemptMeasurement,
		providerCallCount,
		providerReceiptCount,
		providerReceiptsCaptured: providerReceipts.length,
		providerReceiptsTruncated,
		capturedTurnHash: turnEvent.hash,
		events: records
	};
	if (options.deferDashboard) {
		return captureReceipt;
	}
	// The graph is derived from the verified ledger. A batch shares the one projection produced
	// after its final append; capturedTurnHash still identifies each turn independently.
	const dashboard = await buildMemoryDashboard({ cwd: root });
	return finalizeCaptureReceipt(captureReceipt, dashboard);
}

function finalizeCaptureReceipt(capture, dashboard) {
	return {
		...capture,
		eventCount: dashboard.workspace.eventCount,
		ledgerHeadHash: dashboard.workspace.ledgerHeadHash,
		graphManifestHash: dashboard.linkedGraph.manifestHash
	};
}

function boundedString(value, name, maximumLength) {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.includes('\0')) {
		throw new TypeError(`${name} must be a non-empty string of at most ${maximumLength} characters.`);
	}
	return value;
}

function boundedUtf8String(value, name, maximumBytes) {
	if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) {
		throw new TypeError(`${name} must be a non-empty UTF-8 string of at most ${maximumBytes} bytes.`);
	}
	return value;
}

function boundedExcerpt(value, maximumCharacters) {
	if (value.length <= maximumCharacters) {
		return { text: value, truncated: false };
	}
	const separator = '\n...[bounded by Fikeya capture]...\n';
	const headLength = Math.floor((maximumCharacters - separator.length) * 0.75);
	const tailLength = maximumCharacters - separator.length - headLength;
	return { text: `${value.slice(0, headLength)}${separator}${value.slice(-tailLength)}`, truncated: true };
}

function deterministicEventId(value) {
	const digest = createHash('sha256').update(`fikeya-desktop:${value}`, 'utf8').digest('hex').slice(0, 32).split('');
	digest[12] = '4';
	digest[16] = ['8', '9', 'a', 'b'][Number.parseInt(digest[16], 16) % 4];
	const hex = digest.join('');
	return `evt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requiredRecord(value, name) {
	if (!isRecord(value)) {
		throw new TypeError(`${name} must be an object.`);
	}
	return value;
}

function normalizeUsage(value) {
	const usage = requiredRecord(value, 'usage');
	const measurement = boundedEnum(usage.measurement, 'usage.measurement', ['provider-reported', 'unavailable']);
	const inputTokens = nullableInteger(usage.inputTokens, 'usage.inputTokens', 0, 10_000_000_000);
	const outputTokens = nullableInteger(usage.outputTokens, 'usage.outputTokens', 0, 10_000_000_000);
	const cachedInputTokens = nullableInteger(usage.cachedInputTokens, 'usage.cachedInputTokens', 0, 10_000_000_000);
	if (measurement === 'provider-reported' && (inputTokens === null || outputTokens === null || cachedInputTokens === null)) {
		throw new TypeError('Provider-reported usage requires complete token counts.');
	}
	if (measurement === 'unavailable' && (inputTokens !== null || outputTokens !== null || cachedInputTokens !== null)) {
		throw new TypeError('Unavailable usage cannot include token counts.');
	}
	return { measurement, inputTokens, outputTokens, cachedInputTokens };
}

function normalizeMemory(value) {
	const memory = requiredRecord(value, 'memory');
	const status = boundedEnum(memory.status, 'memory.status', ['off', 'unavailable', 'used']);
	const coverage = nullableString(memory.coverage, 'memory.coverage', 80);
	const evidenceCount = nullableInteger(memory.evidenceCount, 'memory.evidenceCount', 0, 1_000_000);
	const receiptId = nullableString(memory.receiptId, 'memory.receiptId', 128);
	const responseSha256 = nullableHash(memory.responseSha256, 'memory.responseSha256');
	if (status === 'used' && (!receiptId || !responseSha256 || evidenceCount === null)) {
		throw new TypeError('Used memory requires its receipt id, response hash, and evidence count.');
	}
	if (status !== 'used' && (coverage !== null || evidenceCount !== null || receiptId !== null || responseSha256 !== null)) {
		throw new TypeError('Unused memory cannot include a context receipt.');
	}
	return { status, coverage, evidenceCount, receiptId, responseSha256 };
}

function normalizeProviderReceipts(value) {
	if (!Array.isArray(value) || value.length > 16) {
		throw new TypeError('providerReceipts must contain at most 16 receipts.');
	}
	const receipts = value.map((candidate, index) => {
		const name = `providerReceipts[${index}]`;
		const receipt = requiredRecord(candidate, name);
		return {
			apiMode: boundedString(receipt.apiMode, `${name}.apiMode`, 80),
			callId: boundedString(receipt.callId, `${name}.callId`, 256),
			createdAt: boundedString(receipt.createdAt, `${name}.createdAt`, 80),
			durationMs: boundedInteger(receipt.durationMs, `${name}.durationMs`, 0, 86_400_000),
			requestBytes: boundedInteger(receipt.requestBytes, `${name}.requestBytes`, 0, 16_777_216),
			requestSha256: requiredHash(receipt.requestSha256, `${name}.requestSha256`),
			responseBytes: boundedInteger(receipt.responseBytes, `${name}.responseBytes`, 0, 16_777_216),
			responseSha256: requiredHash(receipt.responseSha256, `${name}.responseSha256`),
			statusCode: boundedInteger(receipt.statusCode, `${name}.statusCode`, 100, 599)
		};
	});
	if (new Set(receipts.map(receipt => receipt.callId)).size !== receipts.length) {
		throw new TypeError('providerReceipts must have unique callId values.');
	}
	return receipts;
}

function normalizeOutcome(value) {
	const outcome = requiredRecord(value, 'outcome');
	const status = boundedEnum(outcome.status, 'outcome.status', ['completed', 'cancelled', 'failed']);
	const terminalFailure = normalizeTerminalFailure(outcome.terminalFailure);
	if (status !== 'failed' && terminalFailure !== null) {
		throw new TypeError('Only a failed outcome may include a terminal failure classification.');
	}
	const toolOutcomeCount = boundedInteger(outcome.toolOutcomeCount, 'outcome.toolOutcomeCount', 0, 1_000);
	const changedFileCount = boundedInteger(outcome.changedFileCount, 'outcome.changedFileCount', 0, 1_000);
	if (!Array.isArray(outcome.toolOutcomes) || outcome.toolOutcomes.length > 12
		|| !Array.isArray(outcome.changedFiles) || outcome.changedFiles.length > 32
		|| typeof outcome.toolOutcomesTruncated !== 'boolean' || typeof outcome.changedFilesTruncated !== 'boolean'
		|| outcome.toolOutcomes.length > toolOutcomeCount || outcome.changedFiles.length > changedFileCount
		|| outcome.toolOutcomesTruncated !== (outcome.toolOutcomes.length !== toolOutcomeCount)
		|| (!outcome.changedFilesTruncated && outcome.changedFiles.length !== changedFileCount)) {
		throw new TypeError('outcome has inconsistent bounded collections.');
	}
	const toolOutcomes = outcome.toolOutcomes.map((candidate, index) => normalizeToolOutcome(candidate, index));
	const changedFiles = outcome.changedFiles.map((candidate, index) => normalizeChangedFile(candidate, index));
	if (new Set(toolOutcomes.map(tool => tool.callId)).size !== toolOutcomes.length
		|| new Set(changedFiles.map(file => file.path)).size !== changedFiles.length) {
		throw new TypeError('outcome bounded collections require unique tool call ids and changed-file paths.');
	}
	return {
		status,
		terminalFailure,
		changedFilesScope: boundedEnum(outcome.changedFilesScope, 'outcome.changedFilesScope', ['regular-project-files-v1', 'legacy-unspecified']),
		steps: boundedInteger(outcome.steps, 'outcome.steps', 0, 1_000),
		planSha256: requiredHash(outcome.planSha256, 'outcome.planSha256'),
		summarySha256: requiredHash(outcome.summarySha256, 'outcome.summarySha256'),
		toolOutcomeCount,
		toolOutcomesTruncated: outcome.toolOutcomesTruncated,
		toolOutcomes,
		changedFileCount,
		changedFilesTruncated: outcome.changedFilesTruncated,
		changedFiles
	};
}

function normalizeToolOutcome(value, index) {
	const name = `outcome.toolOutcomes[${index}]`;
	const tool = requiredRecord(value, name);
	return {
		callId: boundedString(tool.callId, `${name}.callId`, 256),
		name: boundedString(tool.name, `${name}.name`, 128),
		status: boundedEnum(tool.status, `${name}.status`, ['ok', 'error']),
		outputSha256: requiredHash(tool.outputSha256, `${name}.outputSha256`),
		durationMs: nullableInteger(tool.durationMs, `${name}.durationMs`, 0, 86_400_000),
		exitCode: nullableInteger(tool.exitCode, `${name}.exitCode`, -65_535, 2_147_483_647),
		test: requiredBoolean(tool.test, `${name}.test`)
	};
}

function normalizeChangedFile(value, index) {
	const name = `outcome.changedFiles[${index}]`;
	const file = requiredRecord(value, name);
	const filePath = boundedString(file.path, `${name}.path`, 4_096);
	if (filePath.includes('\\') || filePath.startsWith('/') || filePath.split('/').includes('..')) {
		throw new TypeError(`${name}.path must be a workspace-relative POSIX path.`);
	}
	const beforeSha256 = nullableHash(file.beforeSha256, `${name}.beforeSha256`);
	const afterSha256 = nullableHash(file.afterSha256, `${name}.afterSha256`);
	const beforeBytes = optionalNullableInteger(file, 'beforeBytes', name, 0, Number.MAX_SAFE_INTEGER);
	const afterBytes = optionalNullableInteger(file, 'afterBytes', name, 0, Number.MAX_SAFE_INTEGER);
	const linesAdded = optionalNullableInteger(file, 'linesAdded', name, 0, 1_000_000_000);
	const linesDeleted = optionalNullableInteger(file, 'linesDeleted', name, 0, 1_000_000_000);
	const beforeIdentityPresent = beforeSha256 !== null || beforeBytes !== null;
	const afterIdentityPresent = afterSha256 !== null || afterBytes !== null;
	const beforeExists = file.beforeExists === undefined
		? beforeIdentityPresent
		: requiredBoolean(file.beforeExists, `${name}.beforeExists`);
	const afterExists = file.afterExists === undefined
		? afterIdentityPresent
		: requiredBoolean(file.afterExists, `${name}.afterExists`);
	if ((!beforeExists && beforeIdentityPresent) || (!afterExists && afterIdentityPresent)
		|| (!beforeExists && !afterExists)) {
		throw new TypeError(`${name} must describe a created, updated, or deleted file.`);
	}
	const inferredOperation = !beforeExists ? 'add' : !afterExists ? 'delete' : 'edit';
	const operation = file.operation === undefined
		? inferredOperation
		: boundedEnum(file.operation, `${name}.operation`, ['add', 'edit', 'delete']);
	if (operation !== inferredOperation) {
		throw new TypeError(`${name}.operation does not match its before and after identities.`);
	}
	const lineDeltaStatus = file.lineDeltaStatus === undefined
		? 'unavailable'
		: boundedEnum(file.lineDeltaStatus, `${name}.lineDeltaStatus`, ['exact', 'binary', 'too-large', 'unavailable']);
	if ((lineDeltaStatus === 'exact' && (linesAdded === null || linesDeleted === null))
		|| (lineDeltaStatus !== 'exact' && (linesAdded !== null || linesDeleted !== null))
		|| (operation === 'add' && linesDeleted !== null && linesDeleted !== 0)
		|| (operation === 'delete' && linesAdded !== null && linesAdded !== 0)
		|| (operation === 'edit' && !beforeIdentityPresent && !afterIdentityPresent)
		|| (operation === 'edit' && beforeSha256 !== null && beforeSha256 === afterSha256)) {
		throw new TypeError(`${name} has inconsistent line-delta metadata.`);
	}
	return {
		path: filePath,
		operation,
		beforeExists,
		afterExists,
		beforeSha256,
		afterSha256,
		beforeBytes,
		afterBytes,
		linesAdded,
		linesDeleted,
		lineDeltaStatus
	};
}

function normalizeTerminalFailure(value) {
	if (value === null) {
		return null;
	}
	const failure = requiredRecord(value, 'outcome.terminalFailure');
	if (Object.keys(failure).sort().join(',') !== 'kind,retryable,statusCode') {
		throw new TypeError('outcome.terminalFailure has unsupported fields.');
	}
	const retryable = requiredBoolean(failure.retryable, 'outcome.terminalFailure.retryable');
	const statusCode = failure.statusCode === null
		? null
		: boundedInteger(failure.statusCode, 'outcome.terminalFailure.statusCode', 100, 599);
	const kind = boundedEnum(failure.kind, 'outcome.terminalFailure.kind', [
		'connectivity', 'quota', 'authentication', 'provider', 'agent_no_progress', 'runtime'
	]);
	const valid = kind === 'connectivity'
		? statusCode === null && retryable
		: kind === 'quota'
			? statusCode === 429 && retryable
			: kind === 'authentication'
				? (statusCode === 401 || statusCode === 403) && !retryable
				: kind === 'provider'
					? statusCode !== 401 && statusCode !== 403 && statusCode !== 429
						&& retryable === (statusCode === null
							? false
							: statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode >= 500)
					: statusCode === null && !retryable;
	if (!valid) {
		throw new TypeError('outcome.terminalFailure has contradictory semantics.');
	}
	return { kind, retryable, statusCode };
}

function requiredBoolean(value, name) {
	if (typeof value !== 'boolean') {
		throw new TypeError(`${name} must be a boolean.`);
	}
	return value;
}

function nullableString(value, name, maximumLength) {
	return value === null ? null : boundedString(value, name, maximumLength);
}

function nullableInteger(value, name, minimum, maximum) {
	return value === null ? null : boundedInteger(value, name, minimum, maximum);
}

function optionalNullableInteger(record, key, parentName, minimum, maximum) {
	return record[key] === undefined
		? null
		: nullableInteger(record[key], `${parentName}.${key}`, minimum, maximum);
}

function requiredHash(value, name) {
	const hash = boundedString(value, name, 71);
	if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
		throw new TypeError(`${name} must be a SHA-256 reference.`);
	}
	return hash;
}

function nullableHash(value, name) {
	return value === null ? null : requiredHash(value, name);
}

function boundedInteger(value, name, minimum, maximum) {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value;
}

function boundedEnum(value, name, values) {
	if (!values.includes(value)) {
		throw new TypeError(`${name} must be one of: ${values.join(', ')}.`);
	}
	return value;
}
