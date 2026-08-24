/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
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
const packagedEnvironment = runtime.buildFikeyaRuntimeEnvironment(extractedRoot, process.execPath, isolatedEnvironment);
const initialized = await runtime.runFikeyaRuntime('init', workspaceRoot, invocation, packagedEnvironment);
assert.equal(initialized.ok, true, `Bundled Fikeya init failed: ${initialized.failure}`);
assert.equal(initialized.report?.initialized, true);
assert.match(initialized.report?.workspaceId ?? '', /^ws_[0-9a-f]{32}$/);

const doctor = await runtime.runFikeyaRuntime('doctor', workspaceRoot, invocation, packagedEnvironment);
assert.equal(doctor.ok, true, `Bundled Fikeya doctor failed: ${doctor.failure}`);
assert.equal(doctor.report?.status, 'ready');
assert.equal(doctor.report?.initialized, true);

const memoryInitialization = await memory.initializeQarinahMemory(extractedRoot, workspaceRoot);
assert.equal(memoryInitialization.ok, true, `Bundled Qarinah initialization failed: ${memoryInitialization.failure}`);
assert.match(memoryInitialization.initialization?.workspaceId ?? '', /^ws_[0-9a-f]{32}$/);
assert.equal(memoryInitialization.initialization?.capture, 'metadata');

const recorded = await memory.recordQarinahMemory(
	extractedRoot,
	workspaceRoot,
	'decision',
	'Packaged integration evidence'
);
assert.equal(recorded.ok, true, `Bundled Qarinah record failed: ${recorded.failure}`);
assert.match(recorded.record?.eventId ?? '', /^evt_[0-9a-f-]{36}$/);
assert.match(recorded.record?.eventHash ?? '', /^sha256:[0-9a-f]{64}$/);

const graph = await memory.loadQarinahMemory(extractedRoot, workspaceRoot);
assert.equal(graph.ok, true, `Bundled Qarinah graph load failed: ${graph.failure}`);
assert.equal(graph.snapshot?.eventCount, 1);
assert.ok((graph.snapshot?.nodes.length ?? 0) >= 1);
assert.match(graph.snapshot?.graphManifestHash ?? '', /^sha256:[0-9a-f]{64}$/);
assert.match(graph.snapshot?.viewManifestHash ?? '', /^sha256:[0-9a-f]{64}$/);

// Prove the complete packaged path, not just each component in isolation:
// Desktop bridge -> bundled Python runtime -> bundled Qarinah sidecar -> bounded provider call.
const providerRequests = [];
const providerServer = createServer((request, response) => {
	const chunks = [];
	request.on('data', chunk => chunks.push(chunk));
	request.on('end', () => {
		providerRequests.push({
			method: request.method,
			url: request.url,
			body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
		});
		const body = JSON.stringify({
			choices: [{ message: { content: 'Packaged runtime and Qarinah context are connected.' } }],
			usage: { prompt_tokens: 64, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } }
		});
		response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
		response.end(body);
	});
});
await new Promise((resolve, reject) => {
	providerServer.once('error', reject);
	providerServer.listen(0, '127.0.0.1', resolve);
});
let packagedTurn;
try {
	const address = providerServer.address();
	assert.ok(address && typeof address === 'object');
	process.env.FIKEYA_HOME = profileRoot;
	const configured = await runtime.configureFikeyaProvider({
		name: 'isolated-local',
		kind: 'openai-compatible',
		model: 'isolated-fixture',
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		credentialType: 'none'
	}, workspaceRoot, undefined, invocation, packagedEnvironment);
	assert.equal(configured.ok, true, `Bundled provider configuration failed: ${configured.failure}`);

	packagedTurn = await runtime.startFikeyaAgentRun(
		'isolated-local',
		'Explain the captured decision metadata from bounded project evidence.',
		128,
		4_096,
		'required',
		workspaceRoot,
		invocation,
		packagedEnvironment
	).result;
} finally {
	await new Promise(resolve => providerServer.close(resolve));
}
assert.equal(packagedTurn.ok, true, `Bundled context-backed agent turn failed: ${packagedTurn.failure}`);
assert.equal(packagedTurn.value?.output, 'Packaged runtime and Qarinah context are connected.');
assert.equal(packagedTurn.value?.memory.status, 'used');
assert.notEqual(packagedTurn.value?.memory.coverage, 'none');
assert.ok((packagedTurn.value?.memory.evidenceCount ?? 0) >= 1);
assert.match(packagedTurn.value?.memory.receiptId ?? '', /^ctx_[0-9a-f]{32}$/);
assert.match(packagedTurn.value?.memory.responseSha256 ?? '', /^sha256:[0-9a-f]{64}$/);
assert.equal(providerRequests.length, 1);
assert.equal(providerRequests[0].method, 'POST');
assert.equal(providerRequests[0].url, '/v1/chat/completions');
assert.match(providerRequests[0].body.messages[0].content, /fikeya\.project-context-envelope\.v1/);
assert.match(providerRequests[0].body.messages[0].content, /qarinah\\?\.context-pack\\?\.v2/);

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
	graphManifestHash: graph.snapshot.graphManifestHash,
	contextBackedAgentTurn: packagedTurn.value.memory.status,
	contextReceiptId: packagedTurn.value.memory.receiptId,
	providerRequestCount: providerRequests.length
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
				const entryLimit = relative === 'runtime/fikeya-runtime' || relative === 'runtime/fikeya-runtime.exe'
					? 64 * 1024 * 1024
					: 16 * 1024 * 1024;
				if (!targetPath.startsWith(`${path.resolve(destination)}${path.sep}`) || entry.uncompressedSize > entryLimit) {
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
