/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fikeya contributors. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sidecarPath = fileURLToPath(new URL('../src/sidecar.mjs', import.meta.url));

test('reports the exact packaged sidecar and pinned Qarinah identity', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-sidecar-version-'));
	try {
		const request = {
			id: 'fikeya-memory-version',
			jsonrpc: '2.0',
			method: 'runtime.version',
			params: {}
		};
		const completed = spawnSync(process.execPath, [sidecarPath, '--root', root], {
			cwd: root,
			encoding: 'utf8',
			input: `${JSON.stringify(request)}\n`,
			timeout: 15_000,
			windowsHide: true
		});
		assert.equal(completed.status, 0, completed.stderr);
		assert.deepEqual(JSON.parse(completed.stdout.trim()), {
			id: 'fikeya-memory-version',
			jsonrpc: '2.0',
			result: {
				name: '@fikeya/qarinah-sidecar',
				protocol: 'fikeya.qarinah-sidecar.v1',
				qarinahVersion: '0.4.0',
				version: '0.1.0'
			}
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
