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
	readonly draftScreenshot: string;
	readonly reviewedScreenshot: string;
	readonly approvalScreenshot: string;
	readonly reportPath: string;
	readonly tracePath?: string;
	readonly videoPath?: string;
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
	};
}

interface DeterministicProviderServer {
	readonly baseUrl: string;
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
		'one Chat turn through an isolated deterministic loopback provider, create a',
		'durable draft through the actual Plan UI, review it, stop at exact approval,',
		'and save successful Chat/Plan screenshots plus the report, video, and trace.',
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

async function startDeterministicProvider(): Promise<DeterministicProviderServer> {
	let requestCount = 0;
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
			const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { readonly model?: unknown };
			if (payload.model !== captureProviderModel) {
				response.writeHead(400, { 'Content-Type': 'application/json' });
				response.end('{"error":"unexpected model"}');
				return;
			}
			const decision = captureProviderDecisions[requestCount];
			if (!decision) {
				response.writeHead(409, { 'Content-Type': 'application/json' });
				response.end('{"error":"unexpected provider call"}');
				return;
			}
			requestCount += 1;
			const body = JSON.stringify({
				choices: [{ message: { content: JSON.stringify(decision) } }],
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
		draftScreenshot: screenshotFor('draft-plan'),
		reviewedScreenshot: screenshotFor('reviewed-plan'),
		approvalScreenshot: screenshotFor('awaiting-approval'),
		reportPath: resolveArtifact(manifest.artifacts.report),
		tracePath: trace ? resolveArtifact(trace) : undefined,
		videoPath: manifest.artifacts.videos?.includes('videos/annotated.mp4')
			? resolveArtifact('videos/annotated.mp4')
			: undefined
	};
}

async function sha256File(filePath: string): Promise<string> {
	return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
}

async function publishStableEvidence(summary: EvidenceSummary, outputDirectory: string): Promise<PublishedEvidence> {
	await mkdir(outputDirectory, { recursive: true });
	const copies: readonly (readonly [string, string])[] = [
		['fikeya-chat-real.png', summary.chatScreenshot],
		['fikeya-plan-draft-real.png', summary.draftScreenshot],
		['fikeya-plan-reviewed-real.png', summary.reviewedScreenshot],
		['fikeya-plan-awaiting-approval-real.png', summary.approvalScreenshot]
	];
	const screenshots: ProofScreenshot[] = [];
	for (const [name, source] of copies) {
		const destination = path.join(outputDirectory, name);
		await copyFile(source, destination);
		screenshots.push({ name, path: destination, sha256: await sha256File(destination) });
	}
	const proofManifest = {
		schemaVersion: 'fikeya.desktop-proof.v1',
		scenarioId: summary.manifest.scenarioId,
		capturedAt: summary.manifest.completedAt,
		outcome: summary.manifest.outcome,
		environment: summary.manifest.environment,
		workspacePath: summary.manifest.workspacePath,
		sourceEvidenceDirectory: path.dirname(summary.manifestPath),
		reportPath: summary.reportPath,
		tracePath: summary.tracePath ?? null,
		videoPath: summary.videoPath ?? null,
		screenshots
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
				FIKEYA_CAPTURE_WORKSPACE: workspace,
				FIKEYA_HOME: runtimeHome
			}
		});
		if (provider.requestCount() !== captureProviderDecisions.length) {
			throw new Error(`The successful Chat proof made ${provider.requestCount()} provider calls; expected ${captureProviderDecisions.length}.`);
		}
	} finally {
		await provider.close();
	}
	const match = result.stdout.match(/^Evidence run:\s*(.+)$/mu);
	if (!match) {
		throw new Error('The scenario runner did not report its evidence directory.');
	}
	const summary = await readEvidenceSummary(match[1].trim());
	const published = await publishStableEvidence(summary, options.outputDirectory);
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
	captureProviderModel,
	captureProviderName,
	captureProviderOutput,
	captureDesktopProof,
	captureHelp,
	compiledScenarioPath,
	createProofWorkspace,
	defaultOutputDirectory,
	parseCaptureArguments,
	publishStableEvidence,
	readEvidenceSummary,
	repositoryRoot,
	runProcess,
	scenarioBuildDirectory,
	scenarioSourcePath,
	startDeterministicProvider,
	validateCapturePrerequisites
};
