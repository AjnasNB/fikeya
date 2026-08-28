#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const { spawn }: typeof import('node:child_process') = require('node:child_process');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { copyFile, mkdir, mkdtemp, readFile, stat, writeFile }: typeof import('node:fs/promises') = require('node:fs/promises');
const { createServer }: typeof import('node:http') = require('node:http');
const path: typeof import('node:path') = require('node:path');
const process: typeof import('node:process') = require('node:process');

const scriptDirectory = __dirname;
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const scenarioSourcePath = path.join(scriptDirectory, 'capture-desktop-proof.scenario.ts');
const scenarioBuildDirectory = path.join(repositoryRoot, '.build', 'fikeya-desktop-proof-scenario');
const compiledScenarioPath = path.join(scenarioBuildDirectory, 'capture-desktop-proof.scenario.js');
const defaultOutputDirectory = path.join(repositoryRoot, '.build', 'fikeya-desktop-proof');
const captureProviderName = 'fikeya-desktop-proof';
const captureProviderModel = 'fikeya-proof-model';
const captureProviderOutput = 'Verified the disposable proof workspace: README.md documents the durable reviewable plan, src/calculator.js exports add, and test/calculator.test.js checks add(2, 3).';
const captureProviderPlanSpecification = {
	schemaVersion: 1,
	title: 'Verify the real Fikeya proof workspace',
	steps: [
		{
			stepId: 'inventory-project',
			title: 'Inventory bounded project files',
			toolCall: {
				callId: 'proof-list-files',
				name: 'workspace.list_files',
				arguments: { path: '.' }
			},
			verify: { expectedStatus: 'ok' }
		},
		{
			stepId: 'inspect-readme',
			title: 'Inspect the proof workspace brief',
			dependsOn: ['inventory-project'],
			toolCall: {
				callId: 'proof-read-readme',
				name: 'workspace.read_file',
				arguments: { path: 'README.md' }
			},
			verify: { expectedStatus: 'ok' }
		},
		{
			stepId: 'find-review-boundary',
			title: 'Find the explicit review boundary',
			dependsOn: ['inspect-readme'],
			toolCall: {
				callId: 'proof-search-review',
				name: 'workspace.search_text',
				arguments: { path: '.', query: 'reviewable plan' }
			},
			verify: { expectedStatus: 'ok' }
		}
	]
} as const;
const captureProviderPlanEnvelope = JSON.stringify({
	protocol: 'fikeya.plan-proposal.v1',
	plan: captureProviderPlanSpecification
});
const captureProviderDecisions = [
	{
		kind: 'plan',
		content: 'Summarize the initialized proof workspace from its bounded project evidence without running a tool.'
	},
	{
		kind: 'answer',
		content: 'The proof workspace contains a calculator module, its focused test, and a README describing the durable reviewable plan.'
	},
	{
		kind: 'review',
		reviewAction: 'complete',
		content: captureProviderOutput
	}
] as const;
// Chat, pasted-image Chat, and mentioned-file Chat each use the three-stage
// agent loop. Multitask exercises two advisory loops plus one lead loop. The durable Plan adds one
// provider proposal; its reviewed execution then runs only the three approved local workspace tools.
const captureProviderExpectedRequestCount = (captureProviderDecisions.length * 6) + 1;

interface CaptureOptions {
	compile: boolean;
	checkOnly: boolean;
	outputDirectory: string;
	help?: boolean;
}

interface RunProcessOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
}

interface RunProcessResult {
	readonly stdout: string;
	readonly stderr: string;
}

interface EvidenceCapture {
	readonly status: string;
	readonly screenshot?: string;
}

interface EvidenceStep {
	readonly id: string;
	readonly captures?: readonly EvidenceCapture[];
}

interface EvidenceManifest {
	readonly scenarioId: string;
	readonly outcome: string;
	readonly completedAt?: string;
	readonly environment?: unknown;
	readonly workspacePath?: string;
	readonly artifacts: {
		readonly report: string;
		readonly logs?: readonly string[];
		readonly videos?: readonly string[];
	};
	readonly steps: readonly EvidenceStep[];
}

interface EvidenceSummary {
	readonly manifest: EvidenceManifest;
	readonly manifestPath: string;
	readonly chatScreenshot: string;
	readonly multitaskScreenshot: string;
	readonly draftScreenshot: string;
	readonly narrowChatScreenshot: string;
	readonly narrowGraphScreenshot: string;
	readonly reviewedScreenshot: string;
	readonly approvalScreenshot: string;
	readonly exactApprovalScreenshot: string;
	readonly firstVerifiedScreenshot: string;
	readonly succeededScreenshot: string;
	readonly reportPath: string;
	readonly tracePath?: string;
	readonly videoPath?: string;
}

interface CompletedPlanProofStep {
	readonly order: number;
	readonly stepId: string;
	readonly toolName: string;
	readonly status: 'succeeded';
	readonly approvalReference: string;
	readonly approvalConsumedAt: string;
	readonly approvalExpiresAt: string;
	readonly toolCallSha256: string;
	readonly resultSha256: string;
	readonly executionSha256: string;
	readonly verificationSha256: string;
	readonly verificationStatus: 'passed';
}

interface CompletedPlanProof {
	readonly schemaVersion: 'fikeya.desktop-plan-proof.v1';
	readonly capturedAt: string;
	readonly planId: string;
	readonly recordSha256: string;
	readonly specSha256: string;
	readonly status: 'succeeded';
	readonly steps: readonly CompletedPlanProofStep[];
}

interface ProofScreenshot {
	readonly name: string;
	readonly path: string;
	readonly sha256: string;
}

interface PublishedEvidence {
	readonly manifestPath: string;
	readonly proofManifest: {
		readonly schemaVersion: string;
		readonly scenarioId: string;
		readonly capturedAt?: string;
		readonly outcome: string;
		readonly environment?: unknown;
		readonly workspacePath?: string;
		readonly sourceEvidenceDirectory: string;
		readonly reportPath: string;
		readonly tracePath: string | null;
		readonly videoPath: string | null;
		readonly screenshots: readonly ProofScreenshot[];
		readonly planProof: {
			readonly name: string;
			readonly path: string;
			readonly sha256: string;
			readonly planId: string;
			readonly recordSha256: string;
			readonly specSha256: string;
			readonly status: 'succeeded';
			readonly steps: readonly CompletedPlanProofStep[];
		};
	};
}

interface DeterministicProviderServer {
	readonly baseUrl: string;
	readonly imageRequestCount: () => number;
	readonly requestCount: () => number;
	readonly close: () => Promise<void>;
}

function parseCaptureArguments(argv: readonly string[]): CaptureOptions {
	const options: CaptureOptions = {
		compile: true,
		checkOnly: false,
		outputDirectory: defaultOutputDirectory
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--skip-compile') {
			options.compile = false;
		} else if (argument === '--check') {
			options.checkOnly = true;
		} else if (argument === '--output') {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) {
				throw new Error('--output requires a directory path.');
			}
			options.outputDirectory = path.resolve(value);
			index += 1;
		} else if (argument === '--help' || argument === '-h') {
			options.help = true;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}
	return options;
}

function captureHelp(): string {
	return [
		'Usage: node scripts/fikeya/capture-desktop-proof.ts [options]',
		'',
		'Launch the real Fikeya dev Electron build with the local extension, complete',
		'one Chat turn and a bounded two-agent Multitask batch through an isolated',
		'deterministic loopback provider, create a',
		'durable draft through the actual Plan UI, review it, grant each exact approval,',
		'execute three read-only workspace tools, verify their receipts, and save the',
		'successful Chat/Plan screenshots plus the report, video, trace, and proof JSON.',
		'',
		'Options:',
		'  --output <dir>   copy stable proof screenshots and a manifest here',
		'  --skip-compile   reuse existing extension and scenario JavaScript output',
		'  --check          validate prerequisites without launching Electron',
		'  --help           show this message'
	].join('\n');
}

function buildCaptureProviderArguments(baseUrl: string): string[] {
	if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/u.test(baseUrl)) {
		throw new Error('The deterministic capture provider must use an ephemeral IPv4 loopback endpoint.');
	}
	return [
		'provider',
		'configure',
		captureProviderName,
		'--kind',
		'openai-compatible',
		'--base-url',
		baseUrl,
		'--model',
		captureProviderModel,
		'--credential-type',
		'none',
		'--api-mode',
		'chat-completions',
		'--json'
	];
}

function providerMessageText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '')
		.filter(Boolean)
		.join('\n');
}

function requestedProviderStage(messages: readonly { readonly content?: unknown }[] | undefined): 'plan' | 'act' | 'review' | undefined {
	if (!messages) {
		return undefined;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = providerMessageText(messages[index]?.content);
		if (!content) {
			continue;
		}
		const marker = 'Input:\n';
		const markerIndex = content.lastIndexOf(marker);
		if (markerIndex < 0) {
			continue;
		}
		try {
			const input = JSON.parse(content.slice(markerIndex + marker.length)) as { readonly stage?: unknown };
			if (input.stage === 'plan' || input.stage === 'act' || input.stage === 'review') {
				return input.stage;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function providerMessagesContain(messages: readonly { readonly content?: unknown }[] | undefined, needle: string): boolean {
	const normalizedNeedle = needle.toLowerCase();
	return messages?.some(message => providerMessageText(message.content).toLowerCase().includes(normalizedNeedle)) ?? false;
}

function providerMessagesContainImage(messages: readonly { readonly content?: unknown }[] | undefined): boolean {
	return messages?.some(message => Array.isArray(message.content) && message.content.some(item => {
		if (!isRecord(item) || item.type !== 'image_url' || !isRecord(item.image_url)) {
			return false;
		}
		return typeof item.image_url.url === 'string' && /^data:image\/(?:gif|jpeg|png|webp);base64,/u.test(item.image_url.url);
	})) ?? false;
}

async function startDeterministicProvider(): Promise<DeterministicProviderServer> {
	let requestCount = 0;
	let imageRequestCount = 0;
	const server = createServer(async (request, response) => {
		try {
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				response.writeHead(404, { 'Content-Type': 'application/json' });
				response.end('{"error":"not found"}');
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += bytes.length;
				if (size > 1_048_576) {
					throw new Error('Deterministic provider request exceeded one MiB.');
				}
				chunks.push(bytes);
			}
			const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
				readonly model?: unknown;
				readonly messages?: readonly { readonly content?: unknown }[];
			};
			if (payload.model !== captureProviderModel) {
				response.writeHead(400, { 'Content-Type': 'application/json' });
				response.end('{"error":"unexpected model"}');
				return;
			}
			const stage = requestedProviderStage(payload.messages);
			if (providerMessagesContainImage(payload.messages)) {
				imageRequestCount += 1;
			}
			const planningProposal = providerMessagesContain(payload.messages, 'fikeya.plan-proposal.v1');
			const multitaskProof = providerMessagesContain(payload.messages, 'inspect the proof workspace in parallel');
			let providerContent: string;
			if (planningProposal) {
				// Planning-only execution validates the provider text itself as the
				// versioned envelope; it does not use the reviewed-agent decision schema.
				providerContent = captureProviderPlanEnvelope;
			} else {
				const decisionIndex = stage === 'plan' ? 0 : stage === 'act' ? 1 : stage === 'review' ? 2 : undefined;
				const decision = decisionIndex === undefined && payload.messages?.length === 0
					? captureProviderDecisions[requestCount]
					: decisionIndex === undefined
						? undefined
						: captureProviderDecisions[decisionIndex];
				if (!decision) {
					response.writeHead(409, { 'Content-Type': 'application/json' });
					response.end('{"error":"unexpected provider call"}');
					return;
				}
				providerContent = JSON.stringify(decision);
			}
			if (multitaskProof) {
				// Keep the bounded run observable long enough for the UI proof to witness
				// the real in-flight progress surface rather than only its final state.
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			requestCount += 1;
			const body = JSON.stringify({
				choices: [{ message: { content: providerContent } }],
				usage: {
					completion_tokens: 5,
					prompt_tokens: 20,
					prompt_tokens_details: { cached_tokens: 4 }
				}
			});
			response.writeHead(200, {
				'Connection': 'close',
				'Content-Length': Buffer.byteLength(body),
				'Content-Type': 'application/json'
			});
			response.end(body);
		} catch {
			if (!response.headersSent) {
				response.writeHead(400, { 'Content-Type': 'application/json' });
			}
			response.end('{"error":"invalid request"}');
		}
	});
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(0, '127.0.0.1');
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		await new Promise<void>(resolve => server.close(() => resolve()));
		throw new Error('The deterministic capture provider did not bind an IP loopback port.');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		imageRequestCount: () => imageRequestCount,
		requestCount: () => requestCount,
		close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
	};
}

async function createProofWorkspace(parentDirectory: string = defaultOutputDirectory): Promise<string> {
	await mkdir(parentDirectory, { recursive: true });
	const workspace = await mkdtemp(path.join(parentDirectory, 'workspace-'));
	await mkdir(path.join(workspace, 'src'), { recursive: true });
	await mkdir(path.join(workspace, 'test'), { recursive: true });
	await writeFile(
		path.join(workspace, 'README.md'),
		'# Fikeya Desktop proof workspace\n\nThis disposable project demonstrates a real Chat surface and a durable reviewable plan.\n',
		'utf8'
	);
	await writeFile(
		path.join(workspace, 'src', 'calculator.js'),
		'export function add(left, right) {\n\treturn left + right;\n}\n',
		'utf8'
	);
	await writeFile(
		path.join(workspace, 'test', 'calculator.test.js'),
		'import assert from \'node:assert/strict\';\nimport { add } from \'../src/calculator.js\';\nassert.equal(add(2, 3), 5);\n',
		'utf8'
	);
	return workspace;
}

async function validateCapturePrerequisites(): Promise<readonly string[]> {
	const required = [
		path.join(repositoryRoot, '.build', 'electron'),
		path.join(repositoryRoot, 'out', 'main.js'),
		path.join(repositoryRoot, 'extensions', 'fikeya-desktop', 'src', 'extension.ts'),
		path.join(repositoryRoot, 'extensions', 'fikeya-desktop', 'runtime'),
		path.join(repositoryRoot, 'test', 'scenario', 'src', 'runScenario.ts'),
		scenarioSourcePath
	];
	const missing = [];
	for (const candidate of required) {
		try {
			await stat(candidate);
		} catch {
			missing.push(path.relative(repositoryRoot, candidate));
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`Desktop proof prerequisites are missing: ${missing.join(', ')}. ` +
			'Build the desktop checkout with "npm run electron" and "npm run transpile-client" first.'
		);
	}
	return required;
}

async function resolveTypeScriptCompiler(): Promise<string> {
	const candidates = [
		path.join(repositoryRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc'),
		path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
		path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc.js'),
		path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc6')
	];
	for (const candidate of candidates) {
		try {
			await stat(candidate);
			return candidate;
		} catch {
			// Try the next compiler shape supported by this checkout.
		}
	}
	throw new Error('The repository TypeScript compiler is missing. Run "npm install" before capturing desktop proof.');
}

async function runProcess(executable: string, args: string[], options: RunProcessOptions = {}): Promise<RunProcessResult> {
	return new Promise<RunProcessResult>((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd ?? repositoryRoot,
			env: options.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			stdout += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on('data', chunk => {
			stderr += chunk;
			process.stderr.write(chunk);
		});
		child.once('error', reject);
		child.once('close', code => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${path.basename(executable)} exited with ${code}.\n${stderr || stdout}`));
		});
	});
}

async function readEvidenceSummary(runDirectory: string): Promise<EvidenceSummary> {
	const resolveArtifact = (relativePath: string): string => {
		if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
			throw new Error('Evidence artifact paths must be non-empty paths relative to the evidence run.');
		}
		const root = path.resolve(runDirectory);
		const resolved = path.resolve(root, relativePath);
		if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
			throw new Error(`Evidence artifact escapes the evidence run: ${relativePath}`);
		}
		return resolved;
	};
	const manifestPath = path.join(runDirectory, 'manifest.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvidenceManifest;
	if (manifest.scenarioId !== 'fikeya-chat-plan-proof' || manifest.outcome !== 'passed') {
		throw new Error(`Unexpected evidence manifest: ${manifestPath}`);
	}
	const screenshotFor = (stepId: string): string => {
		const step = manifest.steps.find(candidate => candidate.id === stepId);
		const capture = step?.captures?.find(candidate => candidate.status === 'passed');
		if (!capture?.screenshot) {
			throw new Error(`The evidence run is missing the passed screenshot for '${stepId}'.`);
		}
		return resolveArtifact(capture.screenshot);
	};
	const trace = manifest.artifacts.logs?.find(candidate => /(?:^|[\\/])playwright-trace-[^\\/]+\.zip$/u.test(candidate));
	return {
		manifest,
		manifestPath,
		chatScreenshot: screenshotFor('successful-chat'),
		multitaskScreenshot: screenshotFor('completed-multitask'),
		draftScreenshot: screenshotFor('draft-plan'),
		narrowChatScreenshot: screenshotFor('narrow-chat-panel'),
		narrowGraphScreenshot: screenshotFor('narrow-memory-graph'),
		reviewedScreenshot: screenshotFor('reviewed-plan'),
		approvalScreenshot: screenshotFor('awaiting-approval'),
		exactApprovalScreenshot: screenshotFor('exact-step-approved'),
		firstVerifiedScreenshot: screenshotFor('first-step-verified'),
		succeededScreenshot: screenshotFor('succeeded-plan'),
		reportPath: resolveArtifact(manifest.artifacts.report),
		tracePath: trace ? resolveArtifact(trace) : undefined,
		videoPath: manifest.artifacts.videos?.includes('videos/annotated.mp4')
			? resolveArtifact('videos/annotated.mp4')
			: undefined
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireHash(value: unknown, field: string): string {
	if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
		throw new Error(`Completed Desktop plan proof has an invalid ${field}.`);
	}
	return value;
}

function requireTimestamp(value: unknown, field: string): string {
	if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
		throw new Error(`Completed Desktop plan proof has an invalid ${field}.`);
	}
	return value;
}

async function readCompletedPlanProof(workspacePath: string): Promise<CompletedPlanProof> {
	const proofPath = path.join(workspacePath, '.fikeya', 'desktop-plan-proof.json');
	const payload = JSON.parse(await readFile(proofPath, 'utf8')) as unknown;
	if (!isRecord(payload) || payload.schemaVersion !== 'fikeya.desktop-plan-proof.v1') {
		throw new Error('Completed Desktop plan proof has an unsupported schema.');
	}
	const capturedAt = requireTimestamp(payload.capturedAt, 'capturedAt');
	const plan = isRecord(payload.plan) ? payload.plan : undefined;
	const receipt = isRecord(payload.receipt) ? payload.receipt : undefined;
	const recordSha256 = requireHash(payload.recordSha256, 'recordSha256');
	if (!plan || !receipt || plan.status !== 'succeeded' || receipt.status !== 'succeeded'
		|| receipt.kind !== 'fikeya.plan.receipt' || receipt.recordSha256 !== recordSha256
		|| plan.planId !== receipt.planId || plan.specSha256 !== receipt.specSha256
		|| typeof plan.planId !== 'string' || !/^pln_[a-z0-9]+$/u.test(plan.planId)
		|| !Array.isArray(plan.steps) || !Array.isArray(receipt.steps)
		|| plan.steps.length !== 3 || receipt.steps.length !== 3) {
		throw new Error('Completed Desktop plan proof is not one matching succeeded plan and receipt.');
	}
	const expected = [
		['inventory-project', 'workspace.list_files'],
		['inspect-readme', 'workspace.read_file'],
		['find-review-boundary', 'workspace.search_text']
	] as const;
	const steps = expected.map(([expectedStepId, expectedTool], index): CompletedPlanProofStep => {
		const sourceStep = isRecord(plan.steps[index]) ? plan.steps[index] : undefined;
		const proofStep = isRecord(receipt.steps[index]) ? receipt.steps[index] : undefined;
		if (!sourceStep || !proofStep || sourceStep.stepId !== expectedStepId || proofStep.stepId !== expectedStepId
			|| sourceStep.status !== 'succeeded' || proofStep.status !== 'succeeded'
			|| proofStep.order !== index + 1 || proofStep.toolName !== expectedTool) {
			throw new Error(`Completed Desktop plan proof has an invalid step ${index + 1}.`);
		}
		const approval = isRecord(sourceStep.approval) ? sourceStep.approval : undefined;
		const execution = isRecord(sourceStep.execution) ? sourceStep.execution : undefined;
		const verification = isRecord(sourceStep.verification) ? sourceStep.verification : undefined;
		if (!approval || !execution || !verification || verification.status !== 'passed'
			|| !Array.isArray(verification.checks) || verification.checks.length === 0
			|| verification.checks.some(check => !isRecord(check) || check.passed !== true)
			|| typeof proofStep.approvalReference !== 'string' || !/^apr_[a-z0-9]+$/u.test(proofStep.approvalReference)
			|| approval.referenceId !== proofStep.approvalReference
			|| approval.consumedAt !== proofStep.approvalConsumedAt
			|| approval.expiresAt !== proofStep.approvalExpiresAt) {
			throw new Error(`Completed Desktop plan proof is missing a consumed exact approval or passed checks for ${expectedStepId}.`);
		}
		const toolCallSha256 = requireHash(proofStep.toolCallSha256, `${expectedStepId}.toolCallSha256`);
		const resultSha256 = requireHash(proofStep.resultSha256, `${expectedStepId}.resultSha256`);
		const executionSha256 = requireHash(proofStep.executionSha256, `${expectedStepId}.executionSha256`);
		const verificationSha256 = requireHash(proofStep.verificationSha256, `${expectedStepId}.verificationSha256`);
		if (sourceStep.toolCallSha256 !== toolCallSha256 || approval.toolCallSha256 !== toolCallSha256
			|| execution.toolCallSha256 !== toolCallSha256 || execution.resultSha256 !== resultSha256
			|| execution.executionSha256 !== executionSha256 || verification.outcomeSha256 !== verificationSha256) {
			throw new Error(`Completed Desktop plan proof hash linkage is invalid for ${expectedStepId}.`);
		}
		return {
			order: index + 1,
			stepId: expectedStepId,
			toolName: expectedTool,
			status: 'succeeded',
			approvalReference: proofStep.approvalReference,
			approvalConsumedAt: requireTimestamp(proofStep.approvalConsumedAt, `${expectedStepId}.approvalConsumedAt`),
			approvalExpiresAt: requireTimestamp(proofStep.approvalExpiresAt, `${expectedStepId}.approvalExpiresAt`),
			toolCallSha256,
			resultSha256,
			executionSha256,
			verificationSha256,
			verificationStatus: 'passed'
		};
	});
	return {
		schemaVersion: 'fikeya.desktop-plan-proof.v1',
		capturedAt,
		planId: plan.planId,
		recordSha256,
		specSha256: requireHash(plan.specSha256, 'specSha256'),
		status: 'succeeded',
		steps
	};
}

async function sha256File(filePath: string): Promise<string> {
	return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
}

async function publishStableEvidence(summary: EvidenceSummary, outputDirectory: string, completedPlanProof: CompletedPlanProof): Promise<PublishedEvidence> {
	await mkdir(outputDirectory, { recursive: true });
	const copies: readonly (readonly [string, string])[] = [
		['fikeya-chat-real.png', summary.chatScreenshot],
		['fikeya-multitask-real.png', summary.multitaskScreenshot],
		['fikeya-plan-draft-real.png', summary.draftScreenshot],
		['fikeya-chat-narrow-real.png', summary.narrowChatScreenshot],
		['fikeya-context-graph-narrow-real.png', summary.narrowGraphScreenshot],
		['fikeya-plan-reviewed-real.png', summary.reviewedScreenshot],
		['fikeya-plan-awaiting-approval-real.png', summary.approvalScreenshot],
		['fikeya-plan-exact-approval-real.png', summary.exactApprovalScreenshot],
		['fikeya-plan-executed-verified-real.png', summary.firstVerifiedScreenshot],
		['fikeya-plan-succeeded-real.png', summary.succeededScreenshot]
	];
	const screenshots: ProofScreenshot[] = [];
	for (const [name, source] of copies) {
		const destination = path.join(outputDirectory, name);
		await copyFile(source, destination);
		screenshots.push({ name, path: destination, sha256: await sha256File(destination) });
	}
	const planProofName = 'fikeya-plan-lifecycle-proof.json';
	const planProofPath = path.join(outputDirectory, planProofName);
	await writeFile(planProofPath, `${JSON.stringify(completedPlanProof, null, 2)}\n`, 'utf8');
	const proofManifest = {
		schemaVersion: 'fikeya.desktop-proof.v2',
		scenarioId: summary.manifest.scenarioId,
		capturedAt: summary.manifest.completedAt,
		outcome: summary.manifest.outcome,
		environment: summary.manifest.environment,
		workspacePath: summary.manifest.workspacePath,
		sourceEvidenceDirectory: path.dirname(summary.manifestPath),
		reportPath: summary.reportPath,
		tracePath: summary.tracePath ?? null,
		videoPath: summary.videoPath ?? null,
		screenshots,
		planProof: {
			name: planProofName,
			path: planProofPath,
			sha256: await sha256File(planProofPath),
			planId: completedPlanProof.planId,
			recordSha256: completedPlanProof.recordSha256,
			specSha256: completedPlanProof.specSha256,
			status: completedPlanProof.status,
			steps: completedPlanProof.steps
		}
	};
	const destination = path.join(outputDirectory, 'fikeya-desktop-proof.json');
	await writeFile(destination, `${JSON.stringify(proofManifest, null, 2)}\n`, 'utf8');
	return { manifestPath: destination, proofManifest };
}

async function captureDesktopProof(options: CaptureOptions) {
	await validateCapturePrerequisites();
	if (options.checkOnly) {
		return { checked: true };
	}
	if (options.compile) {
		const compiler = await resolveTypeScriptCompiler();
		await runProcess(process.execPath, [
			compiler,
			'--project',
			path.join(repositoryRoot, 'extensions', 'fikeya-desktop', 'tsconfig.json')
		]);
		await runProcess(process.execPath, [
			compiler,
			'--project',
			path.join(repositoryRoot, 'test', 'scenario', 'tsconfig.json')
		]);
		await mkdir(scenarioBuildDirectory, { recursive: true });
		await writeFile(path.join(scenarioBuildDirectory, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
		await runProcess(process.execPath, [
			compiler,
			scenarioSourcePath,
			'--module',
			'commonjs',
			'--target',
			'es2024',
			'--types',
			'node',
			'--skipLibCheck',
			'--outDir',
			scenarioBuildDirectory
		]);
		// The native desktop resolves an extension-owned PyInstaller executable rather
		// than the Python source tree. Rebuild that executable together with the VSIX
		// before launching Electron so a protocol change cannot be tested against a
		// stale runtime binary.
		await runProcess(process.execPath, [
			path.join(repositoryRoot, 'extensions', 'fikeya-desktop', 'scripts', 'package-extension.mjs')
		], {
			cwd: path.join(repositoryRoot, 'extensions', 'fikeya-desktop')
		});
	}
	const runner = path.join(repositoryRoot, 'test', 'scenario', 'out', 'runScenario.js');
	await stat(runner).catch(() => {
		throw new Error('The compiled scenario runner is missing. Re-run without --skip-compile.');
	});
	await stat(compiledScenarioPath).catch(() => {
		throw new Error('The compiled desktop proof scenario is missing. Re-run without --skip-compile.');
	});
	const workspace = await createProofWorkspace(options.outputDirectory);
	const runtimeHome = await mkdtemp(path.join(options.outputDirectory, 'home-'));
	const provider = await startDeterministicProvider();
	let result: RunProcessResult;
	try {
		const runtimeExecutable = path.join(
			repositoryRoot,
			'extensions',
			'fikeya-desktop',
			'runtime',
			process.platform === 'win32' ? 'fikeya-runtime.exe' : 'fikeya-runtime'
		);
		await runProcess(runtimeExecutable, buildCaptureProviderArguments(provider.baseUrl), {
			env: { ...process.env, FIKEYA_HOME: runtimeHome }
		});
		result = await runProcess(process.execPath, [
			runner,
			compiledScenarioPath,
			'--dev',
			`--extensionDevelopmentPath=${path.join(repositoryRoot, 'extensions', 'fikeya-desktop')}`
		], {
			env: {
				...process.env,
				FIKEYA_CAPTURE_PROVIDER_NAME: captureProviderName,
				FIKEYA_CAPTURE_PROVIDER_OUTPUT: captureProviderOutput,
				FIKEYA_CAPTURE_RUNTIME_EXECUTABLE: runtimeExecutable,
				FIKEYA_CAPTURE_WORKSPACE: workspace,
				FIKEYA_HOME: runtimeHome
			}
		});
		if (provider.requestCount() !== captureProviderExpectedRequestCount) {
			throw new Error(`The Chat, Multitask, and Plan proof made ${provider.requestCount()} provider calls; expected ${captureProviderExpectedRequestCount}.`);
		}
		if (provider.imageRequestCount() !== 3) {
			throw new Error(`The pasted-image proof delivered image input on ${provider.imageRequestCount()} provider calls; expected all 3 coding-agent stages.`);
		}
	} finally {
		await provider.close();
	}
	const match = result.stdout.match(/^Evidence run:\s*(.+)$/mu);
	if (!match) {
		throw new Error('The scenario runner did not report its evidence directory.');
	}
	const summary = await readEvidenceSummary(match[1].trim());
	const completedPlanProof = await readCompletedPlanProof(workspace);
	const published = await publishStableEvidence(summary, options.outputDirectory, completedPlanProof);
	return {
		checked: true,
		workspace,
		runtimeHome,
		evidenceDirectory: path.dirname(summary.manifestPath),
		reportPath: summary.reportPath,
		tracePath: summary.tracePath,
		videoPath: summary.videoPath,
		...published
	};
}

async function main(): Promise<void> {
	const options = parseCaptureArguments(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${captureHelp()}\n`);
		return;
	}
	const result = await captureDesktopProof(options);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
	main().catch(error => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

module.exports = {
	buildCaptureProviderArguments,
	captureProviderDecisions,
	captureProviderExpectedRequestCount,
	captureProviderModel,
	captureProviderName,
	captureProviderOutput,
	captureProviderPlanEnvelope,
	captureProviderPlanSpecification,
	captureDesktopProof,
	captureHelp,
	compiledScenarioPath,
	createProofWorkspace,
	defaultOutputDirectory,
	parseCaptureArguments,
	publishStableEvidence,
	readCompletedPlanProof,
	readEvidenceSummary,
	repositoryRoot,
	runProcess,
	scenarioBuildDirectory,
	scenarioSourcePath,
	startDeterministicProvider,
	validateCapturePrerequisites
};
