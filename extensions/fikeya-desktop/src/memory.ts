/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const maximumSidecarOutputBytes = 512 * 1024;
const maximumSidecarInputBytes = 1024 * 1024;
const maximumSidecarBatchInputBytes = 16 * maximumSidecarInputBytes;
const sidecarTimeoutMilliseconds = 30_000;
const captureBatchTimeoutMilliseconds = 120_000;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const nodeTypes = new Set(['worktree', 'memory', 'file', 'concept', 'directory', 'reference']);

export interface FikeyaMemoryNode {
	readonly id: string;
	readonly type: 'worktree' | 'memory' | 'file' | 'concept' | 'directory' | 'reference';
	readonly kind: string;
	readonly label: string;
	readonly path: string | null;
	readonly status: string;
	readonly conflicted: boolean;
	readonly importance: number;
	readonly incoming: number;
	readonly outgoing: number;
	readonly sourceEventId: string | null;
	readonly evidenceHash: string | null;
	readonly contentHash: string | null;
	readonly terms: readonly string[];
}

export interface FikeyaMemoryEdge {
	readonly source: string;
	readonly target: string;
	readonly type: string;
	readonly weight: number;
}

export interface FikeyaMemorySnapshot {
	readonly generatedAt: string;
	readonly workspaceName: string;
	readonly eventCount: number;
	readonly ledgerHeadHash: string | null;
	readonly graphManifestHash: string;
	readonly viewManifestHash: string;
	readonly nodes: readonly FikeyaMemoryNode[];
	readonly edges: readonly FikeyaMemoryEdge[];
}

export type FikeyaMemoryFailure = 'none' | 'sidecar-not-found' | 'timeout' | 'output-limit' | 'process-error' | 'invalid-response';

export interface FikeyaMemoryResult {
	readonly ok: boolean;
	readonly snapshot?: FikeyaMemorySnapshot;
	readonly failure: FikeyaMemoryFailure;
}

export interface FikeyaMemoryInitialization {
	readonly workspaceId: string;
	readonly capture: 'metadata' | 'content';
}

export interface FikeyaMemoryInitializationResult {
	readonly ok: boolean;
	readonly initialization?: FikeyaMemoryInitialization;
	readonly failure: FikeyaMemoryFailure;
}

export interface FikeyaMemoryRecord {
	readonly eventId: string;
	readonly eventHash: string;
	readonly kind: 'prompt.submitted' | 'source' | 'artifact' | 'decision' | 'summary' | 'tool.completed' | 'turn.completed';
}

export interface FikeyaMemoryRecordResult {
	readonly ok: boolean;
	readonly record?: FikeyaMemoryRecord;
	readonly failure: FikeyaMemoryFailure;
}

export interface FikeyaMemoryRunCaptureRequest {
	readonly sessionId: string;
	readonly providerAttemptId: string | null;
	readonly providerAttemptMeasurement: 'exact' | 'legacy-minimum' | 'unavailable';
	readonly callId: string | null;
	readonly prompt: string;
	readonly promptSha256: string;
	readonly promptBytes: number;
	readonly promptTruncated: boolean;
	readonly provider: {
		readonly name: string;
		readonly kind: string;
		readonly model: string;
	};
	readonly usage: {
		readonly measurement: 'provider-reported' | 'unavailable';
		readonly inputTokens: number | null;
		readonly outputTokens: number | null;
		readonly cachedInputTokens: number | null;
	};
	readonly memory: {
		readonly status: 'off' | 'unavailable' | 'used';
		readonly coverage: string | null;
		readonly evidenceCount: number | null;
		readonly receiptId: string | null;
		readonly responseSha256: string | null;
	};
	readonly providerReceipts: readonly {
		readonly apiMode: string;
		readonly callId: string;
		readonly createdAt: string;
		readonly durationMs: number;
		readonly requestBytes: number;
		readonly requestSha256: string;
		readonly responseBytes: number;
		readonly responseSha256: string;
		readonly statusCode: number;
	}[];
	readonly providerCallCount: number;
	readonly providerReceiptCount: number;
	readonly providerReceiptsTruncated: boolean;
	readonly outcome: {
		readonly status: 'completed' | 'cancelled' | 'failed';
		readonly terminalFailure: {
			readonly kind: 'connectivity' | 'quota' | 'authentication' | 'provider' | 'agent_no_progress' | 'runtime';
			readonly retryable: boolean;
			readonly statusCode: number | null;
		} | null;
		readonly changedFilesScope: 'regular-project-files-v1' | 'legacy-unspecified';
		readonly steps: number;
		readonly planSha256: string;
		readonly summarySha256: string;
		readonly toolOutcomeCount: number;
		readonly toolOutcomesTruncated: boolean;
		readonly toolOutcomes: readonly {
			readonly callId: string;
			readonly name: string;
			readonly status: 'ok' | 'error';
			readonly outputSha256: string;
			readonly durationMs: number | null;
			readonly exitCode: number | null;
			readonly test: boolean;
		}[];
		readonly changedFileCount: number;
		readonly changedFilesTruncated: boolean;
		readonly changedFiles: readonly {
			readonly path: string;
			readonly operation: 'add' | 'edit' | 'delete';
			readonly beforeExists: boolean;
			readonly afterExists: boolean;
			readonly beforeSha256: string | null;
			readonly afterSha256: string | null;
			readonly beforeBytes: number | null;
			readonly afterBytes: number | null;
			readonly linesAdded: number | null;
			readonly linesDeleted: number | null;
			readonly lineDeltaStatus: 'exact' | 'binary' | 'too-large' | 'unavailable';
		}[];
	};
}

export interface FikeyaMemoryRunCaptureReceipt {
	readonly capture: 'metadata' | 'content';
	readonly sessionId: string;
	readonly outcomeStatus: 'completed' | 'cancelled' | 'failed';
	readonly providerAttemptId: string | null;
	readonly providerAttemptMeasurement: 'exact' | 'legacy-minimum' | 'unavailable';
	readonly providerCallCount: number;
	readonly providerReceiptCount: number;
	readonly providerReceiptsCaptured: number;
	readonly providerReceiptsTruncated: boolean;
	readonly eventCount: number;
	readonly capturedTurnHash: string;
	readonly ledgerHeadHash: string;
	readonly graphManifestHash: string;
	readonly events: readonly FikeyaMemoryRecord[];
}

export interface FikeyaMemoryRunCaptureResult {
	readonly ok: boolean;
	readonly receipt?: FikeyaMemoryRunCaptureReceipt;
	readonly failure: FikeyaMemoryFailure;
}

interface FikeyaMemoryRunCaptureBatchReceipt {
	readonly results: readonly FikeyaMemoryRunCaptureResult[];
}

/** Initializes the pinned local Qarinah workspace without widening its capture policy. */
export function initializeQarinahMemory(extensionPath: string, workspacePath: string): Promise<FikeyaMemoryInitializationResult> {
	return invokeQarinahSidecar<FikeyaMemoryInitialization, FikeyaMemoryInitializationResult>(
		extensionPath,
		workspacePath,
		{
			jsonrpc: '2.0',
			id: 'fikeya-memory-init',
			method: 'memory.initialize',
			params: {}
		},
		parseMemoryInitializationSidecarResponse,
		initialization => ({ ok: true, initialization, failure: 'none' }),
		failure => ({ ok: false, failure })
	);
}

/** Records one bounded event through Qarinah's configured capture policy. */
export function recordQarinahMemory(
	extensionPath: string,
	workspacePath: string,
	kind: FikeyaMemoryRecord['kind'],
	title: string
): Promise<FikeyaMemoryRecordResult> {
	return invokeQarinahSidecar<FikeyaMemoryRecord, FikeyaMemoryRecordResult>(
		extensionPath,
		workspacePath,
		{
			jsonrpc: '2.0',
			id: 'fikeya-memory-record',
			method: 'memory.record',
			params: { kind, title }
		},
		parseMemoryRecordSidecarResponse,
		record => ({ ok: true, record, failure: 'none' }),
		failure => ({ ok: false, failure })
	);
}

/**
 * Records one completed Fikeya turn only when the workspace already has a valid Qarinah opt-in.
 * Prompt content is passed over stdin to the local sidecar, where the pinned Qarinah redactor and
 * the workspace capture policy determine what may be retained.
 */
export function captureQarinahRun(
	extensionPath: string,
	workspacePath: string,
	request: FikeyaMemoryRunCaptureRequest
): Promise<FikeyaMemoryRunCaptureResult> {
	return invokeQarinahSidecar<FikeyaMemoryRunCaptureReceipt, FikeyaMemoryRunCaptureResult>(
		extensionPath,
		workspacePath,
		{
			jsonrpc: '2.0',
			id: 'fikeya-memory-capture-run',
			method: 'memory.captureRun',
			params: request
		},
		line => parseMemoryRunCaptureSidecarResponse(line, request),
		receipt => ({ ok: true, receipt, failure: 'none' }),
		failure => ({ ok: false, failure })
	);
}

/**
 * Records up to sixteen terminal turns in one bounded sidecar process. Qarinah appends every
 * turn serially and derives the shared graph projection once after the final append.
 */
export function captureQarinahRuns(
	extensionPath: string,
	workspacePath: string,
	requests: readonly FikeyaMemoryRunCaptureRequest[]
): Promise<readonly FikeyaMemoryRunCaptureResult[]> {
	if (requests.length === 0) {
		return Promise.resolve([]);
	}
	if (requests.length > 16) {
		return Promise.resolve(requests.map(() => ({ ok: false, failure: 'output-limit' })));
	}
	return invokeQarinahSidecar<FikeyaMemoryRunCaptureBatchReceipt, readonly FikeyaMemoryRunCaptureResult[]>(
		extensionPath,
		workspacePath,
		{
			jsonrpc: '2.0',
			id: 'fikeya-memory-capture-runs',
			method: 'memory.captureRuns',
			params: { runs: requests }
		},
		line => parseMemoryRunCaptureBatchSidecarResponse(line, requests),
		batch => batch.results,
		failure => requests.map(() => ({ ok: false, failure })),
		captureBatchTimeoutMilliseconds,
		maximumSidecarBatchInputBytes
	);
}

/** Reads one bounded, verified derived view from the pinned Qarinah sidecar. */
export function loadQarinahMemory(extensionPath: string, workspacePath: string): Promise<FikeyaMemoryResult> {
	return invokeQarinahSidecar<FikeyaMemorySnapshot, FikeyaMemoryResult>(
		extensionPath,
		workspacePath,
		{
			jsonrpc: '2.0',
			id: 'fikeya-memory-view',
			method: 'memory.inspect',
			params: { includeWorktrees: true, limit: 50, query: 'project decisions tools outcomes conflicts changes' }
		},
		parseMemorySidecarResponse,
		snapshot => ({ ok: true, snapshot, failure: 'none' }),
		failure => ({ ok: false, failure })
	);
}

function invokeQarinahSidecar<T, TResult>(
	extensionPath: string,
	workspacePath: string,
	request: Readonly<Record<string, unknown>>,
	parseLine: (line: string) => T | undefined,
	success: (value: T) => TResult,
	failure: (failure: Exclude<FikeyaMemoryFailure, 'none'>) => TResult,
	timeoutMilliseconds = sidecarTimeoutMilliseconds,
	maximumInputBytes = maximumSidecarInputBytes
): Promise<TResult> {
	const sidecarPath = resolveQarinahSidecarPath(extensionPath);
	if (!sidecarPath) {
		return Promise.resolve(failure('sidecar-not-found'));
	}

	return new Promise(resolve => {
		const serializedRequest = JSON.stringify(request);
		if (Buffer.byteLength(serializedRequest, 'utf8') > maximumInputBytes) {
			resolve(failure('output-limit'));
			return;
		}
		const executableName = path.basename(process.execPath).toLowerCase();
		const env = executableName.startsWith('node') ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
		const child = spawn(process.execPath, [sidecarPath, '--root', workspacePath], {
			cwd: workspacePath,
			env,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});
		let output = '';
		let outputBytes = 0;
		let selected = false;
		let selectedResult: TResult | undefined;
		let closed = false;
		let timeout: NodeJS.Timeout | undefined;
		let forceKillTimeout: NodeJS.Timeout | undefined;

		const select = (result: TResult, terminate: boolean): void => {
			if (selected) {
				return;
			}
			selected = true;
			selectedResult = result;
			if (timeout) {
				clearTimeout(timeout);
			}
			if (terminate && !closed) {
				child.kill();
				forceKillTimeout = setTimeout(() => {
					if (!closed) {
						child.kill('SIGKILL');
					}
				}, 2_000);
			} else if (!closed) {
				// A complete one-shot response should be followed by natural process exit. Bound that
				// grace period so a malformed or compromised sidecar cannot hold the workspace queue.
				forceKillTimeout = setTimeout(() => {
					if (!closed) {
						child.kill();
						forceKillTimeout = setTimeout(() => {
							if (!closed) {
								child.kill('SIGKILL');
							}
						}, 2_000);
					}
				}, 2_000);
			}
		};

		const capture = (chunk: Buffer, retain: boolean): void => {
			if (selected) {
				return;
			}
			outputBytes += chunk.byteLength;
			if (outputBytes > maximumSidecarOutputBytes) {
				select(failure('output-limit'), true);
				return;
			}
			if (!retain) {
				return;
			}
			output += chunk.toString('utf8');
			const lineEnd = output.indexOf('\n');
			if (lineEnd === -1) {
				return;
			}
			const value = parseLine(output.slice(0, lineEnd));
			select(value ? success(value) : failure('invalid-response'), false);
		};
		child.on('error', () => select(failure('process-error'), true));
		child.on('close', () => {
			closed = true;
			if (forceKillTimeout) {
				clearTimeout(forceKillTimeout);
			}
			if (!selected) {
				selected = true;
				selectedResult = failure('process-error');
			}
			resolve(selectedResult as TResult);
		});

		if (!child.stdin || !child.stdout || !child.stderr) {
			select(failure('process-error'), true);
			return;
		}
		child.stdout.on('data', chunk => capture(chunk as Buffer, true));
		child.stderr.on('data', chunk => capture(chunk as Buffer, false));
		// This listener must remain installed after settlement because an early child exit can emit
		// EOF/EPIPE asynchronously while a bounded request is still being flushed.
		child.stdin.on('error', () => select(failure('process-error'), true));

		timeout = setTimeout(() => select(failure('timeout'), true), timeoutMilliseconds);
		child.stdin.end(`${serializedRequest}\n`, 'utf8');
	});
}

export function resolveQarinahSidecarPath(extensionPath: string): string | undefined {
	const candidates = [
		path.resolve(extensionPath, 'sidecar', 'qarinah-memory-view.mjs'),
		path.resolve(extensionPath, 'sidecar', 'qarinah-sidecar.mjs'),
		path.resolve(extensionPath, '..', '..', 'integrations', 'qarinah-sidecar', 'src', 'sidecar.mjs')
	];
	return candidates.find(candidate => existsSync(candidate));
}

export function parseMemorySidecarResponse(line: string): FikeyaMemorySnapshot | undefined {
	if (Buffer.byteLength(line, 'utf8') > maximumSidecarOutputBytes) {
		return undefined;
	}
	try {
		const message = asRecord(JSON.parse(line));
		if (!message || message.jsonrpc !== '2.0' || message.id !== 'fikeya-memory-view' || message.error !== undefined) {
			return undefined;
		}
		return parseMemorySnapshot(message.result);
	} catch {
		return undefined;
	}
}

export function parseMemoryInitializationSidecarResponse(line: string): FikeyaMemoryInitialization | undefined {
	if (Buffer.byteLength(line, 'utf8') > maximumSidecarOutputBytes) {
		return undefined;
	}
	try {
		const message = asRecord(JSON.parse(line));
		const result = asRecord(message?.result);
		const workspaceId = strictString(result?.workspaceId, 200);
		const capture = result?.capture;
		if (!message || message.jsonrpc !== '2.0' || message.id !== 'fikeya-memory-init' || message.error !== undefined
			|| !result || result.schemaVersion !== 'qarinah.workspace-initialization.v1'
			|| !workspaceId || !/^ws_[0-9a-f]{32}$/.test(workspaceId)
			|| (capture !== 'metadata' && capture !== 'content')) {
			return undefined;
		}
		return { workspaceId, capture };
	} catch {
		return undefined;
	}
}

export function parseMemoryRecordSidecarResponse(line: string): FikeyaMemoryRecord | undefined {
	if (Buffer.byteLength(line, 'utf8') > maximumSidecarOutputBytes) {
		return undefined;
	}
	try {
		const message = asRecord(JSON.parse(line));
		const result = asRecord(message?.result);
		const eventId = strictString(result?.eventId, 128);
		const eventHash = strictString(result?.eventHash, 71);
		const kind = strictString(result?.kind, 80);
		if (!message || message.jsonrpc !== '2.0' || message.id !== 'fikeya-memory-record' || message.error !== undefined
			|| !result || result.schemaVersion !== 'qarinah.memory-record.v1'
			|| !eventId || !/^evt_[0-9a-f-]{36}$/.test(eventId)
			|| !eventHash || !sha256Pattern.test(eventHash)
			|| !kind || !['prompt.submitted', 'source', 'artifact', 'decision', 'summary', 'tool.completed', 'turn.completed'].includes(kind)) {
			return undefined;
		}
		return { eventId, eventHash, kind: kind as FikeyaMemoryRecord['kind'] };
	} catch {
		return undefined;
	}
}

export function parseMemoryRunCaptureSidecarResponse(
	line: string,
	expectedRequest?: FikeyaMemoryRunCaptureRequest
): FikeyaMemoryRunCaptureReceipt | undefined {
	if (Buffer.byteLength(line, 'utf8') > maximumSidecarOutputBytes) {
		return undefined;
	}
	try {
		const message = asRecord(JSON.parse(line));
		if (!message || message.jsonrpc !== '2.0' || message.id !== 'fikeya-memory-capture-run' || message.error !== undefined) {
			return undefined;
		}
		const receipt = parseMemoryRunCaptureReceipt(message.result);
		return receipt && (!expectedRequest || captureReceiptMatchesRequest(receipt, expectedRequest))
			? receipt
			: undefined;
	} catch {
		return undefined;
	}
}

export function parseMemoryRunCaptureBatchSidecarResponse(
	line: string,
	expectedRequests?: readonly FikeyaMemoryRunCaptureRequest[]
): FikeyaMemoryRunCaptureBatchReceipt | undefined {
	if (Buffer.byteLength(line, 'utf8') > maximumSidecarOutputBytes) {
		return undefined;
	}
	try {
		const message = asRecord(JSON.parse(line));
		const result = asRecord(message?.result);
		if (!message || message.jsonrpc !== '2.0' || message.id !== 'fikeya-memory-capture-runs'
			|| message.error !== undefined || !result
			|| result.schemaVersion !== 'qarinah.fikeya-run-capture-batch.v1'
			|| !Array.isArray(result.results) || result.results.length < 1 || result.results.length > 16
			|| (expectedRequests !== undefined && result.results.length !== expectedRequests.length)) {
			return undefined;
		}
		const results: FikeyaMemoryRunCaptureResult[] = [];
		let sharedProjection: string | undefined;
		for (const [index, candidate] of result.results.entries()) {
			const item = asRecord(candidate);
			if (!item || typeof item.ok !== 'boolean') {
				return undefined;
			}
			if (!item.ok) {
				if (Object.keys(item).length !== 1) {
					return undefined;
				}
				results.push({ ok: false, failure: 'invalid-response' });
				continue;
			}
			if (Object.keys(item).sort().join(',') !== 'ok,receipt') {
				return undefined;
			}
			const receipt = parseMemoryRunCaptureReceipt(item.receipt);
			const expected = expectedRequests?.[index];
			if (!receipt || (expected && !captureReceiptMatchesRequest(receipt, expected))) {
				return undefined;
			}
			const projection = `${receipt.eventCount}:${receipt.ledgerHeadHash}:${receipt.graphManifestHash}`;
			if (sharedProjection !== undefined && sharedProjection !== projection) {
				return undefined;
			}
			sharedProjection = projection;
			results.push({ ok: true, receipt, failure: 'none' });
		}
		return { results };
	} catch {
		return undefined;
	}
}

function captureReceiptMatchesRequest(
	receipt: FikeyaMemoryRunCaptureReceipt,
	request: FikeyaMemoryRunCaptureRequest
): boolean {
	return receipt.sessionId === request.sessionId
		&& receipt.outcomeStatus === request.outcome.status
		&& receipt.providerAttemptId === request.providerAttemptId
		&& receipt.providerAttemptMeasurement === request.providerAttemptMeasurement
		&& receipt.providerCallCount === request.providerCallCount
		&& receipt.providerReceiptCount === request.providerReceiptCount
		&& receipt.providerReceiptsCaptured === request.providerReceipts.length
		&& receipt.providerReceiptsTruncated === request.providerReceiptsTruncated;
}

function parseMemoryRunCaptureReceipt(value: unknown): FikeyaMemoryRunCaptureReceipt | undefined {
	const result = asRecord(value);
	const capture = result?.capture;
	const sessionId = strictString(result?.sessionId, 128);
	const outcomeStatus = result?.outcomeStatus;
	const capturedTurnHash = strictString(result?.capturedTurnHash, 71);
	const ledgerHeadHash = strictString(result?.ledgerHeadHash, 71);
	const graphManifestHash = strictString(result?.graphManifestHash, 71);
	const providerAttemptId = result?.providerAttemptId === null
		? null
		: strictString(result?.providerAttemptId, 128);
	const providerAttemptMeasurement = result?.providerAttemptMeasurement;
	if (!result || result.schemaVersion !== 'qarinah.fikeya-run-capture.v1'
		|| (capture !== 'metadata' && capture !== 'content')
		|| !sessionId || !identifierPattern.test(sessionId)
		|| (outcomeStatus !== 'completed' && outcomeStatus !== 'cancelled' && outcomeStatus !== 'failed')
		|| (providerAttemptId !== null && (!providerAttemptId || !identifierPattern.test(providerAttemptId)))
		|| (providerAttemptMeasurement !== 'exact' && providerAttemptMeasurement !== 'legacy-minimum'
			&& providerAttemptMeasurement !== 'unavailable')
		|| !isInteger(result.providerCallCount, 0, 128)
		|| !isInteger(result.providerReceiptCount, 0, 128)
		|| !isInteger(result.providerReceiptsCaptured, 0, 16)
		|| result.providerReceiptCount > result.providerCallCount
		|| result.providerReceiptsCaptured > result.providerReceiptCount
		|| typeof result.providerReceiptsTruncated !== 'boolean'
		|| result.providerReceiptsTruncated !== (result.providerReceiptsCaptured !== result.providerReceiptCount)
		|| (providerAttemptId === null) !== (result.providerCallCount === 0)
		|| (providerAttemptMeasurement === 'unavailable' && providerAttemptId !== null)
		|| (providerAttemptMeasurement === 'legacy-minimum'
			&& (providerAttemptId === null || result.providerCallCount !== result.providerReceiptCount))
		|| (outcomeStatus === 'completed' && result.providerReceiptCount === 0)
		|| !isInteger(result.eventCount, 1, 100_000_000)
		|| !capturedTurnHash || !sha256Pattern.test(capturedTurnHash)
		|| !ledgerHeadHash || !sha256Pattern.test(ledgerHeadHash)
		|| !graphManifestHash || !sha256Pattern.test(graphManifestHash)
		|| !Array.isArray(result.events) || result.events.length < 3 || result.events.length > 16) {
		return undefined;
	}
	const events: FikeyaMemoryRecord[] = [];
	for (const candidate of result.events) {
		const event = parseMemoryRecord(candidate);
		if (!event) {
			return undefined;
		}
		events.push(event);
	}
	const expectedKind = outcomeStatus === 'completed' ? 'turn.completed' : 'summary';
	if (events.at(-1)?.eventHash !== capturedTurnHash || events.at(-1)?.kind !== expectedKind) {
		return undefined;
	}
	return {
		capture,
		sessionId,
		outcomeStatus,
		providerAttemptId,
		providerAttemptMeasurement,
		providerCallCount: result.providerCallCount,
		providerReceiptCount: result.providerReceiptCount,
		providerReceiptsCaptured: result.providerReceiptsCaptured,
		providerReceiptsTruncated: result.providerReceiptsTruncated,
		eventCount: result.eventCount,
		capturedTurnHash,
		ledgerHeadHash,
		graphManifestHash,
		events
	};
}

function parseMemoryRecord(value: unknown): FikeyaMemoryRecord | undefined {
	const record = asRecord(value);
	const eventId = strictString(record?.eventId, 128);
	const eventHash = strictString(record?.eventHash, 71);
	const kind = strictString(record?.kind, 80);
	if (!record || !eventId || !/^evt_[0-9a-f-]{36}$/.test(eventId)
		|| !eventHash || !sha256Pattern.test(eventHash)
		|| !kind || !['prompt.submitted', 'source', 'artifact', 'decision', 'summary', 'tool.completed', 'turn.completed'].includes(kind)) {
		return undefined;
	}
	return { eventId, eventHash, kind: kind as FikeyaMemoryRecord['kind'] };
}

export function parseMemorySnapshot(value: unknown): FikeyaMemorySnapshot | undefined {
	const record = asRecord(value);
	const workspace = asRecord(record?.workspace);
	const graph = asRecord(record?.graph);
	const generatedAt = strictString(record?.generatedAt, 80);
	const workspaceName = strictString(workspace?.name, 240);
	const graphManifestHash = strictString(graph?.manifestHash, 71);
	const viewManifestHash = strictString(record?.manifestHash, 71);
	const ledgerHeadHashValue = workspace?.ledgerHeadHash;
	const ledgerHeadHash = ledgerHeadHashValue === null ? null : strictString(ledgerHeadHashValue, 71);
	if (!record || record.schemaVersion !== 'qarinah.developer-memory-view.v1' || !workspace || !graph
		|| !generatedAt || !workspaceName || !isInteger(workspace.eventCount, 0, 100_000_000)
		|| !graphManifestHash || !sha256Pattern.test(graphManifestHash)
		|| !viewManifestHash || !sha256Pattern.test(viewManifestHash)
		|| (ledgerHeadHash !== null && (!ledgerHeadHash || !sha256Pattern.test(ledgerHeadHash)))
		|| !Array.isArray(graph.nodes) || graph.nodes.length > 200
		|| !Array.isArray(graph.edges) || graph.edges.length > 500) {
		return undefined;
	}

	const nodes: FikeyaMemoryNode[] = [];
	for (const candidate of graph.nodes) {
		const node = parseMemoryNode(candidate);
		if (!node) {
			return undefined;
		}
		nodes.push(node);
	}
	const nodeIds = new Set(nodes.map(node => node.id));
	if (nodeIds.size !== nodes.length) {
		return undefined;
	}
	const edges: FikeyaMemoryEdge[] = [];
	for (const candidate of graph.edges) {
		const edge = parseMemoryEdge(candidate, nodeIds);
		if (!edge) {
			return undefined;
		}
		edges.push(edge);
	}
	return {
		generatedAt,
		workspaceName,
		eventCount: workspace.eventCount,
		ledgerHeadHash,
		graphManifestHash,
		viewManifestHash,
		nodes,
		edges
	};
}

function parseMemoryNode(value: unknown): FikeyaMemoryNode | undefined {
	const record = asRecord(value);
	const id = strictString(record?.id, 512);
	const type = strictString(record?.type, 24);
	const kind = strictString(record?.kind, 80);
	const label = strictString(record?.label, 240);
	const pathValue = record?.path;
	const nodePath = pathValue === null || pathValue === undefined ? null : strictString(pathValue, 2048);
	const status = strictString(record?.status, 80);
	const sourceEventIdValue = record?.sourceEventId;
	const sourceEventId = sourceEventIdValue === null || sourceEventIdValue === undefined ? null : strictString(sourceEventIdValue, 128);
	const evidenceHash = optionalHash(record?.evidenceHash);
	const contentHash = optionalHash(record?.contentHash);
	if (!record || !id || !type || !nodeTypes.has(type) || !kind || !label || nodePath === undefined || !status
		|| typeof record.conflicted !== 'boolean' || !isNumber(record.importance, 0, 1_000)
		|| !isInteger(record.incoming, 0, 1_000_000) || !isInteger(record.outgoing, 0, 1_000_000)
		|| sourceEventId === undefined || evidenceHash === undefined || contentHash === undefined
		|| !Array.isArray(record.terms) || record.terms.length > 12) {
		return undefined;
	}
	const terms = record.terms.map(term => strictString(term, 80));
	if (terms.some(term => term === undefined)) {
		return undefined;
	}
	return {
		id,
		type: type as FikeyaMemoryNode['type'],
		kind,
		label,
		path: nodePath,
		status,
		conflicted: record.conflicted,
		importance: record.importance,
		incoming: record.incoming,
		outgoing: record.outgoing,
		sourceEventId,
		evidenceHash,
		contentHash,
		terms: terms as string[]
	};
}

function parseMemoryEdge(value: unknown, nodeIds: ReadonlySet<string>): FikeyaMemoryEdge | undefined {
	const record = asRecord(value);
	const source = strictString(record?.source, 512);
	const target = strictString(record?.target, 512);
	const type = strictString(record?.type, 80);
	if (!record || !source || !target || !nodeIds.has(source) || !nodeIds.has(target) || !type || !isNumber(record.weight, 0, 1_000)) {
		return undefined;
	}
	return { source, target, type, weight: record.weight };
}

function optionalHash(value: unknown): string | null | undefined {
	if (value === null || value === undefined) {
		return null;
	}
	const hash = strictString(value, 71);
	return hash && sha256Pattern.test(hash) ? hash : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strictString(value: unknown, maximumLength: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumLength ? value : undefined;
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isNumber(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
