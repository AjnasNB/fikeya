/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { buildMemoryDashboard } from 'fikeya-qarinah-dashboard';
import { compileContext } from 'fikeya-qarinah-compiler';
import { appendEvent } from 'fikeya-qarinah-store';
import { initializeWorkspace } from 'fikeya-qarinah-workspace';

const maximumInputBytes = 1024 * 1024;
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
	if (Buffer.byteLength(line, 'utf8') > maximumInputBytes) {
		writeError(null, -32600, 'Protocol message exceeds the one-megabyte limit.');
		return;
	}
	try {
		request = JSON.parse(line);
	} catch {
		writeError(null, -32700, 'Invalid JSON.');
		return;
	}
	if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.id !== 'string'
		|| !['memory.initialize', 'memory.inspect', 'memory.prepare', 'memory.record'].includes(request.method) || !isRecord(request.params)) {
		writeError(isRecord(request) && typeof request.id === 'string' ? request.id : null, -32600, 'Invalid request.');
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

function boundedString(value, name, maximumLength) {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.includes('\0')) {
		throw new TypeError(`${name} must be a non-empty string of at most ${maximumLength} characters.`);
	}
	return value;
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
