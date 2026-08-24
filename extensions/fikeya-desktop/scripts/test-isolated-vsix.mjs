/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDirectory, '..');
const sourceManifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
const target = process.env.FIKEYA_VSIX_TARGET ?? currentVsixTarget();
const artifactPath = path.resolve(process.argv[2] ?? path.join(extensionRoot, 'artifacts', `fikeya-desktop-${sourceManifest.version}-${target}.vsix`));
const isolatedRoot = path.join(extensionRoot, '.runtime-build', `isolated-profile-${process.pid}-${Date.now()}`);
const extractedRoot = path.join(isolatedRoot, 'extensions', 'fikeya-desktop');
const workspaceRoot = path.join(isolatedRoot, 'workspace');
const profileRoot = path.join(isolatedRoot, 'profile');
await Promise.all([mkdir(extractedRoot, { recursive: true }), mkdir(workspaceRoot, { recursive: true }), mkdir(profileRoot, { recursive: true })]);
await extractExtension(artifactPath, extractedRoot);

const require = createRequire(import.meta.url);
const runtime = require(path.join(extractedRoot, 'out', 'runtime.js'));
const memory = require(path.join(extractedRoot, 'out', 'memory.js'));
const invocation = runtime.resolveFikeyaCli(extractedRoot, process.platform);
assert.equal(invocation.source, 'bundled', 'Isolated VSIX must resolve its extension-owned Fikeya Runtime.');
assert.ok(path.isAbsolute(invocation.executable));
assert.ok(invocation.executable.startsWith(path.join(extractedRoot, 'runtime')));

const isolatedEnvironment = {
	...process.env,
	PATH: '',
	FIKEYA_HOME: profileRoot
};
const initialized = await runtime.runFikeyaRuntime('init', workspaceRoot, undefined, isolatedEnvironment);
assert.equal(initialized.ok, true, `Bundled Fikeya init failed: ${initialized.failure}`);
assert.equal(initialized.report?.initialized, true);
assert.match(initialized.report?.workspaceId ?? '', /^ws_[0-9a-f]{32}$/);

const doctor = await runtime.runFikeyaRuntime('doctor', workspaceRoot, undefined, isolatedEnvironment);
assert.equal(doctor.ok, true, `Bundled Fikeya doctor failed: ${doctor.failure}`);
assert.equal(doctor.report?.status, 'ready');
assert.equal(doctor.report?.initialized, true);

const memoryInitialization = await memory.initializeQarinahMemory(extractedRoot, workspaceRoot);
assert.equal(memoryInitialization.ok, true, `Bundled Qarinah initialization failed: ${memoryInitialization.failure}`);
assert.match(memoryInitialization.initialization?.workspaceId ?? '', /^ws_[0-9a-f]{32}$/);
assert.equal(memoryInitialization.initialization?.capture, 'metadata');

const graph = await memory.loadQarinahMemory(extractedRoot, workspaceRoot);
assert.equal(graph.ok, true, `Bundled Qarinah graph load failed: ${graph.failure}`);
assert.equal(graph.snapshot?.eventCount, 0);
assert.equal(graph.snapshot?.nodes.length, 0);
assert.equal(graph.snapshot?.edges.length, 0);
assert.match(graph.snapshot?.graphManifestHash ?? '', /^sha256:[0-9a-f]{64}$/);
assert.match(graph.snapshot?.viewManifestHash ?? '', /^sha256:[0-9a-f]{64}$/);

const report = {
	schemaVersion: 'fikeya.desktop-isolated-vsix-test.v1',
	artifactPath,
	artifactSha256: `sha256:${createHash('sha256').update(await readFile(artifactPath)).digest('hex')}`,
	target,
	runtimeSource: invocation.source,
	globalPathEntries: 0,
	workspaceId: initialized.report.workspaceId,
	qarinahWorkspaceId: memoryInitialization.initialization.workspaceId,
	graphEventCount: graph.snapshot.eventCount,
	graphNodeCount: graph.snapshot.nodes.length,
	graphEdgeCount: graph.snapshot.edges.length,
	graphManifestHash: graph.snapshot.graphManifestHash
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function extractExtension(vsixPath, destination) {
	return new Promise((resolve, reject) => {
		yauzl.open(vsixPath, { lazyEntries: true }, (openError, archive) => {
			if (openError || !archive) {
				reject(openError ?? new Error('Unable to open VSIX archive.'));
				return;
			}
			archive.on('error', reject);
			archive.on('end', resolve);
			archive.on('entry', entry => {
				if (!entry.fileName.startsWith('extension/') || entry.fileName.endsWith('/')) {
					archive.readEntry();
					return;
				}
				const relative = entry.fileName.slice('extension/'.length);
				const targetPath = path.resolve(destination, ...relative.split('/'));
				if (!targetPath.startsWith(`${path.resolve(destination)}${path.sep}`) || entry.uncompressedSize > 16 * 1024 * 1024) {
					reject(new Error(`Unsafe VSIX entry: ${entry.fileName}`));
					archive.close();
					return;
				}
				archive.openReadStream(entry, (streamError, stream) => {
					if (streamError || !stream) {
						reject(streamError ?? new Error(`Unable to extract ${entry.fileName}.`));
						return;
					}
					const chunks = [];
					stream.on('data', chunk => chunks.push(chunk));
					stream.on('error', reject);
					stream.on('end', async () => {
						try {
							await mkdir(path.dirname(targetPath), { recursive: true });
							await writeFile(targetPath, Buffer.concat(chunks), { mode: relative === 'runtime/fikeya-runtime' ? 0o755 : 0o644 });
							archive.readEntry();
						} catch (error) {
							reject(error);
							archive.close();
						}
					});
				});
			});
			archive.readEntry();
		});
	});
}

function currentVsixTarget() {
	const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
	if (process.platform === 'win32') return `win32-${architecture}`;
	if (process.platform === 'darwin') return `darwin-${architecture}`;
	if (process.platform === 'linux') return `linux-${architecture}`;
	throw new Error(`Unsupported VSIX platform: ${process.platform}/${process.arch}`);
}
