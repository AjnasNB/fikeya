/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fikeya contributors. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import process from 'node:process';
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { MemoryPort, MethodNotFoundError, safeError } from './memory-port.mjs';

const maxLineBytes = 1024 * 1024;
const protocol = 'fikeya.qarinah-sidecar.v1';
const packageMetadata = readPackageMetadata();
const root = readRoot(process.argv.slice(2));
const port = new MemoryPort(root);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

lines.on('line', line => {
	void handleLine(line);
});

lines.on('close', () => {
	process.exitCode = 0;
});

async function handleLine(line) {
	if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
		writeError(null, -32600, 'Protocol message exceeds the one-megabyte limit.');
		return;
	}

	let message;
	try {
		message = JSON.parse(line);
	} catch {
		writeError(null, -32700, 'Invalid JSON.');
		return;
	}

	if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
		writeError(isRecord(message) && typeof message.id === 'string' ? message.id : null, -32600, 'Invalid request.');
		return;
	}

	if (message.method === '$/cancelRequest') {
		if (isRecord(message.params) && typeof message.params.id === 'string') {
			port.cancel(message.params.id);
		}
		return;
	}

	if (typeof message.id !== 'string') {
		return;
	}

	try {
		const result = message.method === 'runtime.version'
			? runtimeVersion(message.params ?? {})
			: await port.dispatch(message.method, message.params ?? {}, message.id);
		write({ jsonrpc: '2.0', id: message.id, result });
	} catch (error) {
		const code = error instanceof MethodNotFoundError ? -32601 : error instanceof TypeError ? -32602 : -32000;
		writeError(message.id, code, safeError(error).message);
	}
}

function runtimeVersion(params) {
	if (!isRecord(params) || Object.keys(params).length !== 0) {
		throw new TypeError('runtime.version parameters must be an empty object.');
	}
	return {
		name: packageMetadata.name,
		protocol,
		qarinahVersion: packageMetadata.qarinahVersion,
		version: packageMetadata.version
	};
}

function readPackageMetadata() {
	const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	if (!isRecord(value)
		|| value.name !== '@fikeya/qarinah-sidecar'
		|| !isExactVersion(value.version)
		|| !isRecord(value.dependencies)
		|| !isExactVersion(value.dependencies.qarinah)) {
		throw new TypeError('Fikeya Qarinah sidecar package metadata is invalid.');
	}
	return {
		name: value.name,
		qarinahVersion: value.dependencies.qarinah,
		version: value.version
	};
}

function isExactVersion(value) {
	return typeof value === 'string'
		&& Buffer.byteLength(value, 'utf8') <= 128
		&& /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function writeError(id, code, message) {
	write({ jsonrpc: '2.0', id, error: { code, message } });
}

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function readRoot(argv) {
	const index = argv.indexOf('--root');
	if (index === -1 || typeof argv[index + 1] !== 'string') {
		process.stderr.write('Fikeya Qarinah sidecar requires --root <workspace>.\n');
		process.exit(2);
	}
	return argv[index + 1];
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

