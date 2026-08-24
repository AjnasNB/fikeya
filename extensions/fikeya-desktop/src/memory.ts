/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const maximumSidecarOutputBytes = 512 * 1024;
const sidecarTimeoutMilliseconds = 30_000;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
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

/** Reads one bounded, verified derived view from the pinned Qarinah sidecar. */
export function loadQarinahMemory(extensionPath: string, workspacePath: string): Promise<FikeyaMemoryResult> {
	const sidecarPath = resolveQarinahSidecarPath(extensionPath);
	if (!sidecarPath) {
		return Promise.resolve({ ok: false, failure: 'sidecar-not-found' });
	}

	return new Promise(resolve => {
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
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const finish = (result: FikeyaMemoryResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			child.kill();
			resolve(result);
		};

		const capture = (chunk: Buffer, retain: boolean): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maximumSidecarOutputBytes) {
				finish({ ok: false, failure: 'output-limit' });
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
			const snapshot = parseMemorySidecarResponse(output.slice(0, lineEnd));
			finish(snapshot ? { ok: true, snapshot, failure: 'none' } : { ok: false, failure: 'invalid-response' });
		};

		if (!child.stdin || !child.stdout || !child.stderr) {
			finish({ ok: false, failure: 'process-error' });
			return;
		}
		child.stdout.on('data', chunk => capture(chunk as Buffer, true));
		child.stderr.on('data', chunk => capture(chunk as Buffer, false));
		child.on('error', () => finish({ ok: false, failure: 'process-error' }));
		child.on('close', () => {
			if (!settled) {
				finish({ ok: false, failure: 'process-error' });
			}
		});

		const request = JSON.stringify({
			jsonrpc: '2.0',
			id: 'fikeya-memory-view',
			method: 'memory.inspect',
			params: { includeWorktrees: true, limit: 50, query: 'project decisions tools outcomes conflicts changes' }
		});
		child.stdin.write(`${request}\n`, 'utf8');
		timeout = setTimeout(() => finish({ ok: false, failure: 'timeout' }), sidecarTimeoutMilliseconds);
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
