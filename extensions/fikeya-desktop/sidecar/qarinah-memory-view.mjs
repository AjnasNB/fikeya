/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { buildMemoryDashboard } from 'qarinah';

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
		|| request.method !== 'memory.inspect' || !isRecord(request.params)) {
		writeError(isRecord(request) && typeof request.id === 'string' ? request.id : null, -32600, 'Invalid request.');
		return;
	}

	try {
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
