/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fikeya contributors. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryPort, normalizeLifecycleEvent, safeError, toQarinahEventId } from '../src/memory-port.mjs';

test('binds the memory port to one absolute workspace root', () => {
	const port = new MemoryPort('.');
	assert.equal(port.root, path.resolve('.'));
});

test('maps Fikeya lifecycle data to a supported Qarinah event', () => {
	const event = normalizeLifecycleEvent({
		id: 'evt-1',
		type: 'tool.completed',
		occurredAt: '2026-08-24T00:00:00.000Z',
		sessionId: 'session-1',
		turnId: 'turn-1',
		payload: { title: 'Tests passed', exitCode: 0 }
	});

	assert.deepEqual({
		eventId: event.eventId,
		kind: event.kind,
		title: event.title,
		adapter: event.provenance.adapter,
		rootIsUnchanged: os.platform() !== ''
	}, {
		eventId: toQarinahEventId('evt-1'),
		kind: 'tool.completed',
		title: 'Tests passed',
		adapter: 'fikeya',
		rootIsUnchanged: true
	});
});

test('derives stable Qarinah event identifiers without losing the source id', () => {
	const first = toQarinahEventId('run-1:turn-2:tool-3');
	const second = toQarinahEventId('run-1:turn-2:tool-3');
	assert.match(first, /^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(first, second);
});

test('rejects unsupported lifecycle events', () => {
	assert.throws(() => normalizeLifecycleEvent({
		id: 'evt-1',
		type: 'shell.run.unbounded',
		occurredAt: '2026-08-24T00:00:00.000Z',
		sessionId: 'session-1',
		payload: {}
	}), /Unsupported lifecycle event/);
});

test('redacts provider-shaped credentials from errors', () => {
	assert.deepEqual(safeError(new Error('failed sk-example-secret and nvapi-example_secret')), {
		name: 'Error',
		message: 'failed [redacted] and [redacted]'
	});
});

test('records and retrieves cited project memory through Qarinah', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-qarinah-'));
	try {
		const port = new MemoryPort(root);
		const initialized = await port.dispatch('memory.initialize', { capture: 'content' }, 'initialize');
		await port.dispatch('memory.approve', {
			capture: 'content',
			policyHash: initialized.policy.policyHash
		}, 'approve');

		const recorded = await port.dispatch('memory.record', {
			event: {
				id: 'decision-root-bound-stdio',
				type: 'decision.recorded',
				occurredAt: '2026-08-24T00:00:00.000Z',
				sessionId: 'session-1',
				payload: {
					title: 'Use root-bound stdio',
					body: 'Use authenticated stdio instead of a network listener for the memory sidecar.'
				}
			}
		}, 'record');

		const context = await port.dispatch('memory.prepare', {
			query: 'Why use root-bound stdio?',
			maxTokens: 2_000
		}, 'prepare');

		assert.match(recorded.hash, /^sha256:[0-9a-f]{64}$/);
		assert.equal(context.items.length, 1);
		assert.match(context.manifestHash, /^sha256:[0-9a-f]{64}$/);
		assert.equal(context.items[0].title, 'Use root-bound stdio');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('scans a workspace and returns bounded symbol intelligence', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-symbols-'));
	try {
		await writeFile(path.join(root, 'math.ts'), [
			'export function add(left: number, right: number): number {',
			'\treturn left + right;',
			'}',
			''
		].join('\n'), 'utf8');
		const port = new MemoryPort(root);
		const initialized = await port.dispatch('memory.initialize', { capture: 'content' }, 'initialize-symbols');
		await port.dispatch('memory.approve', {
			capture: 'content',
			policyHash: initialized.policy.policyHash
		}, 'approve-symbols');

		const scan = await port.dispatch('memory.scan', { maxFiles: 10 }, 'scan');
		const symbols = await port.dispatch('memory.symbols', { query: 'add', limit: 5 }, 'symbols');
		const summary = await port.dispatch('memory.symbolGraph.summary', {}, 'graph-summary');

		assert.equal(scan.fileCount, 1);
		assert.ok(symbols.resultCount >= 1);
		assert.ok(symbols.results.some(result => result.symbol.name === 'add'));
		assert.ok(summary.symbolCount >= 1);
		assert.equal(summary.fileCount, 1);
		assert.match(summary.manifestHash, /^sha256:[0-9a-f]{64}$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects symbol and scan requests above hard resource limits', async () => {
	const port = new MemoryPort('.');
	await assert.rejects(() => port.dispatch('memory.scan', { maxFiles: 50_001 }, 'oversized-scan'), /maximum of 50000/);
	await assert.rejects(() => port.dispatch('memory.symbols', { query: 'x'.repeat(4_097) }, 'oversized-query'), /4096-character limit/);
	await assert.rejects(() => port.dispatch('memory.symbols', { kinds: ['executable'] }, 'invalid-kind'), /unsupported symbol kind/);
});
