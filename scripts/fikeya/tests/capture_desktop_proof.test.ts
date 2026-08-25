/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, stat, writeFile }: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const test: typeof import('node:test') = require('node:test');
const {
	buildCaptureProviderArguments,
	captureProviderDecisions,
	captureProviderModel,
	captureHelp,
	createProofWorkspace,
	parseCaptureArguments,
	publishStableEvidence,
	readEvidenceSummary,
	startDeterministicProvider
} = require('../capture-desktop-proof.ts');

test('capture arguments default to a compiled real-app run', () => {
	const options = parseCaptureArguments([]);
	assert.equal(options.compile, true);
	assert.equal(options.checkOnly, false);
	assert.ok(path.isAbsolute(options.outputDirectory));
});

test('capture arguments support check, output, and skip-compile', () => {
	const options = parseCaptureArguments(['--check', '--skip-compile', '--output', 'proof-output']);
	assert.equal(options.compile, false);
	assert.equal(options.checkOnly, true);
	assert.equal(options.outputDirectory, path.resolve('proof-output'));
	assert.throws(() => parseCaptureArguments(['--output']), /requires a directory/u);
	assert.throws(() => parseCaptureArguments(['--unknown']), /Unknown argument/u);
	assert.match(captureHelp(), /actual Plan UI/u);
});

test('proof workspace is disposable and contains executable project evidence', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-capture-test-'));
	const workspace = await createProofWorkspace(root);
	assert.match(await readFile(path.join(workspace, 'README.md'), 'utf8'), /durable reviewable plan/u);
	assert.match(await readFile(path.join(workspace, 'src', 'calculator.js'), 'utf8'), /return left \+ right/u);
	await stat(path.join(workspace, 'test', 'calculator.test.js'));
});

test('capture provider configuration is credential-free and loopback-only', () => {
	const args = buildCaptureProviderArguments('http://127.0.0.1:43123/v1');
	assert.deepEqual(args.slice(0, 3), ['provider', 'configure', 'fikeya-desktop-proof']);
	assert.ok(args.includes('openai-compatible'));
	assert.ok(args.includes('none'));
	assert.ok(args.includes('chat-completions'));
	assert.ok(!args.includes('--secret-stdin'));
	assert.throws(() => buildCaptureProviderArguments('https://example.com/v1'), /loopback endpoint/u);
});

test('deterministic loopback provider returns strict Chat decisions and measured usage', async () => {
	const provider = await startDeterministicProvider();
	try {
		for (const decision of captureProviderDecisions) {
			const response = await fetch(`${provider.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: captureProviderModel, messages: [] })
			});
			assert.equal(response.status, 200);
			const payload = await response.json() as {
				readonly choices: readonly { readonly message: { readonly content: string } }[];
				readonly usage: { readonly prompt_tokens: number; readonly completion_tokens: number; readonly prompt_tokens_details: { readonly cached_tokens: number } };
			};
			assert.deepEqual(JSON.parse(payload.choices[0].message.content), decision);
			assert.deepEqual(payload.usage, {
				completion_tokens: 5,
				prompt_tokens: 20,
				prompt_tokens_details: { cached_tokens: 4 }
			});
		}
		assert.equal(provider.requestCount(), 3);
	} finally {
		await provider.close();
	}
});

test('Electron Chat proof submits a natively valid bounded context budget', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	const match = /contextBudget\.value = '(\d+)'/u.exec(scenario);
	assert.ok(match, 'capture scenario must set an explicit context budget');
	const value = Number(match[1]);
	assert.equal((value - 512) % 256, 0, 'context budget must satisfy min=512 and step=256');
	assert.match(scenario, /if \(!form\.checkValidity\(\)\) return false;/u);
});

test('evidence summary rejects non-passing and incomplete runs', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-evidence-test-'));
	await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
		scenarioId: 'fikeya-chat-plan-proof',
		outcome: 'failed',
		steps: [],
		artifacts: { report: 'report.html', videos: [] }
	}), 'utf8');
	await assert.rejects(() => readEvidenceSummary(root), /Unexpected evidence manifest/u);
});

test('evidence summary rejects artifacts outside the evidence run', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-evidence-boundary-'));
	const stepIds = ['successful-chat', 'draft-plan', 'reviewed-plan', 'awaiting-approval'];
	await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
		scenarioId: 'fikeya-chat-plan-proof',
		outcome: 'passed',
		artifacts: { report: '../report.html', videos: [] },
		steps: stepIds.map(id => ({ id, captures: [{ status: 'passed', screenshot: `${id}.png` }] }))
	}), 'utf8');
	await assert.rejects(() => readEvidenceSummary(root), /escapes the evidence run/u);
});

test('stable evidence copies only passed real-run screenshots and hashes them', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-evidence-copy-'));
	const run = path.join(root, 'run');
	const output = path.join(root, 'published');
	await mkdir(run, { recursive: true });
	const stepIds = ['successful-chat', 'draft-plan', 'reviewed-plan', 'awaiting-approval'];
	for (const stepId of stepIds) {
		await writeFile(path.join(run, `${stepId}.png`), `real-${stepId}`, 'utf8');
	}
	await writeFile(path.join(run, 'manifest.json'), JSON.stringify({
		scenarioId: 'fikeya-chat-plan-proof',
		outcome: 'passed',
		completedAt: '2026-08-26T00:00:00.000Z',
		environment: { platform: 'test', vscodeVersion: '1.0.0', quality: 'Dev' },
		workspacePath: '/proof',
		artifacts: { report: 'report.html', videos: [] },
		steps: stepIds.map(id => ({ id, captures: [{ status: 'passed', screenshot: `${id}.png` }] }))
	}), 'utf8');
	const summary = await readEvidenceSummary(run);
	const published = await publishStableEvidence(summary, output);
	assert.equal(published.proofManifest.outcome, 'passed');
	assert.equal(published.proofManifest.screenshots.length, 4);
	assert.ok(published.proofManifest.screenshots.every((item: { readonly sha256: string }) => /^sha256:[0-9a-f]{64}$/u.test(item.sha256)));
	assert.equal(JSON.parse(await readFile(published.manifestPath, 'utf8')).schemaVersion, 'fikeya.desktop-proof.v1');
});
