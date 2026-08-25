/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, stat, writeFile }: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const test: typeof import('node:test') = require('node:test');
const {
	captureHelp,
	createProofWorkspace,
	parseCaptureArguments,
	publishStableEvidence,
	readEvidenceSummary
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
	const stepIds = ['chat-ready', 'draft-plan', 'reviewed-plan', 'awaiting-approval'];
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
	const stepIds = ['chat-ready', 'draft-plan', 'reviewed-plan', 'awaiting-approval'];
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
