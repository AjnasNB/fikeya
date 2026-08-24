/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { parseMemoryInitializationSidecarResponse, parseMemorySidecarResponse, parseMemorySnapshot, resolveQarinahSidecarPath } from '../memory';

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const hashC = `sha256:${'c'.repeat(64)}`;

function memoryView(): Record<string, unknown> {
	return {
		schemaVersion: 'qarinah.developer-memory-view.v1',
		generatedAt: '2026-08-24T10:00:00.000Z',
		manifestHash: hashA,
		workspace: {
			name: 'fikeya',
			eventCount: 42,
			ledgerHeadHash: hashB
		},
		graph: {
			manifestHash: hashC,
			nodes: [
				{
					id: 'memory:decision',
					type: 'memory',
					kind: 'decision',
					label: 'Keep prompts on stdin',
					path: null,
					status: 'current',
					conflicted: false,
					importance: 0.9,
					incoming: 0,
					outgoing: 1,
					sourceEventId: 'evt_example',
					evidenceHash: hashA,
					contentHash: null,
					terms: ['stdin', 'prompt']
				},
				{
					id: 'file:runtime',
					type: 'file',
					kind: 'source',
					label: 'runtime.ts',
					path: 'extensions/fikeya-desktop/src/runtime.ts',
					status: 'current',
					conflicted: false,
					importance: 0.7,
					incoming: 1,
					outgoing: 0,
					sourceEventId: null,
					evidenceHash: null,
					contentHash: hashB,
					terms: ['runtime']
				}
			],
			edges: [{ source: 'memory:decision', target: 'file:runtime', type: 'affects', weight: 0.8 }]
		}
	};
}

describe('Fikeya Qarinah memory bridge', () => {
	test('prefers the compact extension-owned Qarinah view adapter', () => {
		const extensionPath = path.resolve(__dirname, '..', '..');
		assert.strictEqual(resolveQarinahSidecarPath(extensionPath), path.join(extensionPath, 'sidecar', 'qarinah-memory-view.mjs'));
	});

	test('accepts a bounded cited graph projection', () => {
		const parsed = parseMemorySnapshot(memoryView());
		assert.strictEqual(parsed?.workspaceName, 'fikeya');
		assert.strictEqual(parsed?.nodes.length, 2);
		assert.strictEqual(parsed?.edges[0].type, 'affects');
		assert.strictEqual(parsed?.nodes[0].evidenceHash, hashA);
	});

	test('accepts only the expected JSON-RPC response identity', () => {
		const line = JSON.stringify({ jsonrpc: '2.0', id: 'fikeya-memory-view', result: memoryView() });
		assert.strictEqual(parseMemorySidecarResponse(line)?.eventCount, 42);
		assert.strictEqual(parseMemorySidecarResponse(JSON.stringify({ jsonrpc: '2.0', id: 'other', result: memoryView() })), undefined);
	});

	test('accepts a bounded Qarinah initialization receipt', () => {
		const line = JSON.stringify({
			jsonrpc: '2.0',
			id: 'fikeya-memory-init',
			result: {
				schemaVersion: 'qarinah.workspace-initialization.v1',
				workspaceId: `ws_${'a'.repeat(32)}`,
				capture: 'metadata'
			}
		});
		assert.deepStrictEqual(parseMemoryInitializationSidecarResponse(line), {
			workspaceId: `ws_${'a'.repeat(32)}`,
			capture: 'metadata'
		});
		assert.strictEqual(parseMemoryInitializationSidecarResponse(line.replace('metadata', 'all')), undefined);
	});

	test('rejects edges that reference nodes outside the bounded projection', () => {
		const value = memoryView();
		const graph = value.graph as { edges: unknown[] };
		graph.edges = [{ source: 'memory:decision', target: 'file:missing', type: 'affects', weight: 1 }];
		assert.strictEqual(parseMemorySnapshot(value), undefined);
	});

	test('rejects malformed provenance hashes and oversized node sets', () => {
		const malformed = memoryView();
		(malformed.graph as { manifestHash: string }).manifestHash = 'not-a-hash';
		assert.strictEqual(parseMemorySnapshot(malformed), undefined);

		const oversized = memoryView();
		const graph = oversized.graph as { nodes: unknown[] };
		graph.nodes = Array.from({ length: 201 }, () => graph.nodes[0]);
		assert.strictEqual(parseMemorySnapshot(oversized), undefined);
	});
});
