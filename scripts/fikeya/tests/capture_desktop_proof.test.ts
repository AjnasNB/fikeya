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
	captureProviderExpectedRequestCount,
	captureProviderModel,
	captureProviderPlanEnvelope,
	captureProviderPlanSpecification,
	captureHelp,
	createProofWorkspace,
	parseCaptureArguments,
	publishStableEvidence,
	readCompletedPlanProof,
	readEvidenceSummary,
	startDeterministicProvider
} = require('../capture-desktop-proof.ts');

const evidenceStepIds = [
	'successful-chat',
	'completed-multitask',
	'draft-plan',
	'narrow-chat-panel',
	'narrow-memory-graph',
	'reviewed-plan',
	'awaiting-approval',
	'exact-step-approved',
	'first-step-verified',
	'succeeded-plan'
] as const;

function hash(character: string): string {
	return `sha256:${character.repeat(64)}`;
}

function completedPlanPayload() {
	const definitions = [
		['inventory-project', 'workspace.list_files'],
		['inspect-readme', 'workspace.read_file'],
		['find-review-boundary', 'workspace.search_text']
	] as const;
	const planSteps = definitions.map(([stepId, toolName], index) => ({
		stepId,
		status: 'succeeded',
		toolCallSha256: hash(String(index + 1)),
		approval: {
			referenceId: `apr_${String(index + 1).repeat(24)}`,
			toolCallSha256: hash(String(index + 1)),
			issuedAt: `2026-08-26T00:0${index}:00.000Z`,
			expiresAt: `2026-08-26T00:1${index}:00.000Z`,
			consumedAt: `2026-08-26T00:0${index}:01.000Z`
		},
		execution: {
			toolCallSha256: hash(String(index + 1)),
			resultSha256: hash(String(index + 4)),
			executionSha256: hash(String(index + 7))
		},
		verification: {
			status: 'passed',
			outcomeSha256: hash(['a', 'b', 'c'][index]),
			checks: [{ passed: true }]
		}
	}));
	const receiptSteps = definitions.map(([stepId, toolName], index) => ({
		order: index + 1,
		stepId,
		toolName,
		status: 'succeeded',
		approvalReference: `apr_${String(index + 1).repeat(24)}`,
		approvalConsumedAt: `2026-08-26T00:0${index}:01.000Z`,
		approvalExpiresAt: `2026-08-26T00:1${index}:00.000Z`,
		toolCallSha256: hash(String(index + 1)),
		resultSha256: hash(String(index + 4)),
		executionSha256: hash(String(index + 7)),
		verificationSha256: hash(['a', 'b', 'c'][index]),
		verificationStatus: 'passed'
	}));
	return {
		schemaVersion: 'fikeya.desktop-plan-proof.v1',
		capturedAt: '2026-08-26T00:20:00.000Z',
		plan: {
			planId: 'pln_1234567890abcdef12345678',
			status: 'succeeded',
			specSha256: hash('d'),
			steps: planSteps
		},
		receipt: {
			kind: 'fikeya.plan.receipt',
			planId: 'pln_1234567890abcdef12345678',
			status: 'succeeded',
			specSha256: hash('d'),
			recordSha256: hash('e'),
			steps: receiptSteps
		},
		recordSha256: hash('e')
	};
}

test('capture arguments default to a compiled real-app run', () => {
	const options = parseCaptureArguments([]);
	assert.equal(options.compile, true);
	assert.equal(options.checkOnly, false);
	assert.ok(path.isAbsolute(options.outputDirectory));
});

test('compiled desktop proof rebuilds the extension-owned runtime before Electron', async () => {
	const capture = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.ts'), 'utf8');
	assert.match(capture, /package-extension\.mjs/u);
	assert.match(capture, /stale runtime binary/u);
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

test('deterministic provider routes concurrent agent calls by requested runtime stage', async () => {
	const provider = await startDeterministicProvider();
	try {
		const stages = ['review', 'plan', 'act'] as const;
		const payloads = await Promise.all(stages.map(async stage => {
			const response = await fetch(`${provider.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: captureProviderModel,
					messages: [{ role: 'user', content: `Input:\n{"stage":"${stage}"}` }]
				})
			});
			assert.equal(response.status, 200);
			return response.json() as Promise<{ readonly choices: readonly { readonly message: { readonly content: string } }[] }>;
		}));
		assert.deepEqual(
			payloads.map(payload => JSON.parse(payload.choices[0].message.content).kind),
			['review', 'plan', 'answer']
		);
		assert.equal(provider.requestCount(), 3);
	} finally {
		await provider.close();
	}
});

test('deterministic provider returns the strict raw plan envelope for planning-only execution', async () => {
	const provider = await startDeterministicProvider();
	try {
		const response = await fetch(`${provider.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: captureProviderModel,
				messages: [
					{ role: 'system', content: 'Return the fikeya.plan-proposal.v1 envelope only.' },
					{ role: 'user', content: 'Create a bounded plan.' }
				]
			})
		});
		assert.equal(response.status, 200);
		const payload = await response.json() as { readonly choices: readonly { readonly message: { readonly content: string } }[] };
		assert.equal(payload.choices[0].message.content, captureProviderPlanEnvelope);
		assert.deepEqual(JSON.parse(payload.choices[0].message.content), {
			protocol: 'fikeya.plan-proposal.v1',
			plan: captureProviderPlanSpecification
		});
		assert.equal(provider.requestCount(), 1);
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

test('Electron Chat proof validates a real 360px-class responsive panel', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /window\.resizeTo/u);
	assert.match(scenario, /resizeFikeyaPanel\(code, page, 380\)/u);
	assert.match(scenario, /document\.documentElement\.scrollWidth/u);
	assert.match(scenario, /document\.body\.scrollWidth/u);
	assert.match(scenario, /\.chat-plan-details/u);
	assert.match(scenario, /\[data-agent-form\] \[name="prompt"\]/u);
	assert.match(scenario, /\[data-agent-form\] \[name="chatMode"\]/u);
	assert.match(scenario, /fiveModesAvailable/u);
	assert.match(scenario, /ask,plan,build,review,research/u);
	assert.match(scenario, /\[data-agent-run\]/u);
	assert.match(scenario, /\[data-network-confirmation\]/u);
	assert.match(scenario, /\[data-network-confirm\]/u);
	assert.match(scenario, /\.composer-route > summary/u);
	assert.match(scenario, /composerAnchored/u);
	assert.match(scenario, /minimumPanelWidth = 340/u);
	assert.match(scenario, /maximumPanelWidth = 420/u);
});

test('Electron proof executes and verifies a bounded two-agent Multitask batch', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /id: 'completed-multitask'/u);
	assert.match(scenario, /mode\.value = 'review'/u);
	assert.match(scenario, /parallelToggle\.click\(\)/u);
	assert.match(scenario, /input\.checked = true/u);
	assert.match(scenario, /form\.requestSubmit\(\)/u);
	assert.match(scenario, /\[data-network-confirm\]/u);
	assert.match(scenario, /Proof Planner/u);
	assert.match(scenario, /Proof Reviewer/u);
	assert.match(scenario, /\.assistant-message/u);
	assert.match(scenario, /\.message-meta span/u);
	assert.match(scenario, /\.message-content/u);
	assert.match(scenario, /\.multi-agent-live/u);
	assert.match(scenario, /status\.toLowerCase\(\)\.includes\('completed'\)/u);
	assert.match(scenario, /specialistAnswerCount === 0/u);
	assert.match(scenario, /currentTurnAnswers\.length === 1/u);
	assert.match(scenario, /one canonical/u);
	assert.equal(captureProviderExpectedRequestCount, 28);
});

test('Electron Chat proof mentions a bounded workspace file through the native picker', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /id: 'mentioned-file-chat'/u);
	assert.match(scenario, /\[data-mention-workspace\]/u);
	assert.match(scenario, /Add workspace files to this message/u);
	assert.match(scenario, /page\.keyboard\.type\('README\.md'\)/u);
	assert.match(scenario, /prompt\?\.value\.includes\('@README\.md'\)/u);
	assert.match(scenario, /attachment === 'README\.md'/u);
});

test('Electron Chat proof pastes an image and delivers it to the provider', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /id: 'pasted-image-chat'/u);
	assert.match(scenario, /new DataTransfer\(\)/u);
	assert.match(scenario, /new ClipboardEvent\('paste'/u);
	assert.match(scenario, /proof-pixel\.png/u);
	assert.match(scenario, /\.composer-attachment/u);
	assert.match(scenario, /\.message-attachment/u);
});

test('Electron proof uses chat-first inline Plan and dialog overlays', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /mode\.value = 'plan'/u);
	assert.match(scenario, /form\.requestSubmit\(\)/u);
	assert.match(scenario, /\[data-network-confirmation\]/u);
	assert.match(scenario, /\[data-network-confirm\]/u);
	assert.doesNotMatch(scenario, /type: 'createPlan'/u);
	assert.match(scenario, /\.chat-plan-details/u);
	assert.match(scenario, /\[data-modal-open="context"\]/u);
	assert.match(scenario, /\[data-workspace-modal="context"\]/u);
	assert.match(scenario, /\[data-modal-open="usage"\]/u);
	assert.match(scenario, /\[data-workspace-modal="usage"\]/u);
	assert.doesNotMatch(scenario, /data-surface-tab/u);
	assert.doesNotMatch(scenario, /data-open-plan/u);
	assert.doesNotMatch(scenario, /data-agent-plan/u);
});

test('Electron proof uses a Windows-safe evidence path and verifies the short composer confirmation', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /recordVideo: process\.platform !== 'win32'/u);
	assert.match(scenario, /id: 'short-composer-confirmation'/u);
	assert.match(scenario, /window\.resizeTo\(window\.outerWidth, 620\)/u);
	assert.match(scenario, /confirmationRect\.top >= promptRect\.bottom/u);
	assert.match(scenario, /confirmationRect\.bottom <= footerRect\.top/u);
	assert.match(scenario, /sendOnceVisible/u);
	assert.match(scenario, /cancelVisible/u);
	assert.match(scenario, /proofPanelWidth \?\?= await evaluateFikeya<number>\(code, 'window\.innerWidth'\)/u);
	assert.match(scenario, /Math\.max\(421, \(proofPanelWidth \?\? 421\) - 8\)/u);
	assert.doesNotMatch(scenario, /window\.innerWidth >= 700/u);
});

test('Electron proof selects an evidence-linked Qarinah node at the narrow width', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /id: 'narrow-memory-graph'/u);
	assert.match(scenario, /\[data-memory-graph\]/u);
	assert.match(scenario, /\.graph-node\[data-selected="true"\]/u);
	assert.match(scenario, /\[data-graph-detail="evidence"\]/u);
});

test('Desktop Plan proof grants exact approvals and verifies only safe workspace tools', async () => {
	const scenario = await readFile(path.join(__dirname, '..', 'capture-desktop-proof.scenario.ts'), 'utf8');
	assert.match(scenario, /approveExactStep\(code, page, 'inventory-project'\)/u);
	assert.match(scenario, /approveExactStep\(code, page, 'inspect-readme'\)/u);
	assert.match(scenario, /approveExactStep\(code, page, 'find-review-boundary'\)/u);
	assert.doesNotMatch(scenario, /data-plan-action="approve-all"/u);
	const toolNames = captureProviderPlanSpecification.steps.map((step: { readonly toolCall: { readonly name: string } }) => step.toolCall.name);
	assert.deepEqual(toolNames, ['workspace.list_files', 'workspace.read_file', 'workspace.search_text']);
	assert.ok(toolNames.every((toolName: string) => !['process.run', 'workspace.write_file', 'workspace.apply_patch'].includes(toolName)));
});

test('completed Plan proof validates linked approvals, executions, results, and verifications', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'fikeya-plan-proof-'));
	await mkdir(path.join(root, '.fikeya'), { recursive: true });
	await writeFile(path.join(root, '.fikeya', 'desktop-plan-proof.json'), `${JSON.stringify(completedPlanPayload())}\n`, 'utf8');
	const proof = await readCompletedPlanProof(root);
	assert.equal(proof.status, 'succeeded');
	assert.equal(proof.steps.length, 3);
	assert.ok(proof.steps.every((step: { readonly verificationStatus: string }) => step.verificationStatus === 'passed'));
	assert.ok(proof.steps.every((step: { readonly approvalConsumedAt: string }) => !Number.isNaN(Date.parse(step.approvalConsumedAt))));

	const invalid = completedPlanPayload();
	invalid.receipt.steps[1].executionSha256 = hash('f');
	await writeFile(path.join(root, '.fikeya', 'desktop-plan-proof.json'), `${JSON.stringify(invalid)}\n`, 'utf8');
	await assert.rejects(() => readCompletedPlanProof(root), /hash linkage is invalid/u);
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
	const stepIds = evidenceStepIds;
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
	const stepIds = evidenceStepIds;
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
	const completedProofWorkspace = path.join(root, 'completed-plan');
	await mkdir(path.join(completedProofWorkspace, '.fikeya'), { recursive: true });
	await writeFile(path.join(completedProofWorkspace, '.fikeya', 'desktop-plan-proof.json'), `${JSON.stringify(completedPlanPayload())}\n`, 'utf8');
	const completedProof = await readCompletedPlanProof(completedProofWorkspace);
	const published = await publishStableEvidence(summary, output, completedProof);
	assert.equal(published.proofManifest.outcome, 'passed');
	assert.equal(published.proofManifest.screenshots.length, 10);
	assert.ok(published.proofManifest.screenshots.some((item: { readonly name: string }) => item.name === 'fikeya-multitask-real.png'));
	assert.ok(published.proofManifest.screenshots.some((item: { readonly name: string }) => item.name === 'fikeya-chat-narrow-real.png'));
	assert.ok(published.proofManifest.screenshots.some((item: { readonly name: string }) => item.name === 'fikeya-context-graph-narrow-real.png'));
	assert.ok(published.proofManifest.screenshots.every((item: { readonly sha256: string }) => /^sha256:[0-9a-f]{64}$/u.test(item.sha256)));
	assert.match(published.proofManifest.planProof.sha256, /^sha256:[0-9a-f]{64}$/u);
	assert.equal(published.proofManifest.planProof.status, 'succeeded');
	assert.equal(JSON.parse(await readFile(published.manifestPath, 'utf8')).schemaVersion, 'fikeya.desktop-proof.v2');
});
