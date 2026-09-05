// Fikeya product delivery and measurement tooling.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const digest = value => createHash('sha256').update(value).digest('hex');
export function environmentMatches(expected, actual) {
	return JSON.stringify(expected) === JSON.stringify(actual);
}
async function installedEnvironment() {
	const script = `import hashlib, importlib, importlib.metadata, json, platform, pathlib, sys
packages = {}
for name in ('fikeya_agent_core', 'fikeya_runtime', 'fikeya_interop'):
    module = importlib.import_module(name)
    root = pathlib.Path(module.__file__).parent
    sources = [(p.relative_to(root).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(root.rglob('*.py'))]
    packages[name] = {'version': importlib.metadata.version(name.replace('_', '-')), 'sourceSha256': hashlib.sha256(json.dumps(sources).encode()).hexdigest()}
print(json.dumps({'python': sys.version, 'platform': platform.platform(), 'packages': packages}, sort_keys=True))`;
	const { stdout } = await promisify(execFile)(process.env.FIKEYA_BENCH_PYTHON || 'python', ['-I', '-c', script], {
		windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024
	});
	return JSON.parse(stdout);
}
const fixture = {
	'config.json': JSON.stringify({ port: 4317, retries: 3, tracing: false }),
	'routes.json': JSON.stringify({ health: '/healthz', ready: '/readyz' }),
	'README.md': 'The service reads config.json and routes.json. Inspect those files for exact settings.',
	'archive.txt': Array.from({ length: 80 }, (_, i) => `Historical release ${i}: old deployment notes, not active configuration.`).join('\n')
};
const tasks = [
	{ id: 'port', prompt: 'What port is configured? Return only JSON {"answer": <number>}.', expected: 4317 },
	{ id: 'tracing', prompt: 'Is tracing enabled? Return only JSON {"answer": <boolean>}.', expected: false },
	{ id: 'readiness', prompt: 'What is the readiness route? Return only JSON {"answer": "<path>"}.', expected: '/readyz' }
];
export function grade(output, expected) {
	try {
		const source = output.trim().replace(/^\x60\x60\x60(?:json)?\s*/u, '').replace(/\s*\x60\x60\x60$/u, '');
		const value = JSON.parse(source);
		return Object.keys(value).length === 1 && value.answer === expected;
	} catch { return false; }
}
export function approvalDecision(message) {
	// The harness can approve only fixture reads. No processes, writes, network
	// tools, browser actions, or workspace configuration changes are authorized.
	if (message.toolName === 'workspace.list_files'
		&& (!message.arguments?.path || message.arguments.path === '.')) return 'allow_once';
	return message.toolName === 'workspace.read_file'
		&& typeof message.arguments?.path === 'string'
		&& Object.hasOwn(fixture, message.arguments.path) ? 'allow_once' : 'deny_once';
}
export function summarize(attempts) {
	const totals = {};
	for (const arm of ['full-context', 'on-demand']) {
		const records = attempts.filter(row => row.arm === arm);
		const known = records.every(row => row.usage?.measurement === 'provider-reported');
		totals[arm] = {
			attempts: records.length,
			verified: records.filter(row => row.verified).length,
			inputTokens: known ? records.reduce((n, row) => n + row.usage.inputTokens, 0) : null,
			cachedInputTokens: known ? records.reduce((n, row) => n + row.usage.cachedInputTokens, 0) : null,
			outputTokens: known ? records.reduce((n, row) => n + row.usage.outputTokens, 0) : null,
			totalDurationMs: records.reduce((n, row) => n + row.durationMs, 0),
			costUsd: null
		};
	}
	return totals;
}

function runCli(args, input, { coding = false, timeoutMs = 120_000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.FIKEYA_BENCH_PYTHON || 'python', ['-I', '-m', 'fikeya_runtime', ...args], {
			shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
		});
		let buffer = '', stdout = '', stderr = '', bytes = 0, timedOut = false;
		const messages = [];
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
		child.on('error', error => { clearTimeout(timer); reject(error); });
		child.stdin.on('error', () => { /* Exit/timeout can close input before a decision. */ });
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
		child.stdout.on('data', chunk => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > 4 * 1024 * 1024) { child.kill(); return; }
			stdout += chunk;
			if (!coding) return;
			buffer += chunk;
			let end;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				let message;
				try { message = JSON.parse(line); } catch { child.kill(); return; }
				messages.push(message);
				if (message.type === 'approval') child.stdin.write(JSON.stringify({
					type: 'approval', requestId: message.requestId, decision: approvalDecision(message)
				}) + '\n');
			}
		});
		child.on('close', code => {
			clearTimeout(timer);
			resolve({ code, timedOut, stdout, stderr, messages });
		});
		if (coding) child.stdin.write(JSON.stringify(input) + '\n');
		else child.stdin.end();
	});
}

export async function main(argv) {
	const providerIndex = argv.indexOf('--provider');
	const provider = providerIndex >= 0 ? argv[providerIndex + 1] : undefined;
	const trialsIndex = argv.indexOf('--trials');
	const trials = trialsIndex < 0 ? 1 : Number(argv[trialsIndex + 1]);
	const pauseIndex = argv.indexOf('--pause-ms');
	const pauseMs = pauseIndex < 0 ? 60000 : Number(argv[pauseIndex + 1]);
	assert(provider && /^[A-Za-z0-9._-]{1,100}$/u.test(provider), 'Specify --provider with an existing Fikeya profile.');
	assert(argv.includes('--allow-network'), 'Live model calls require --allow-network.');
	assert(Number.isInteger(trials) && trials >= 1 && trials <= 5, 'Trials must be 1-5.');
	assert(Number.isInteger(pauseMs) && pauseMs >= 0 && pauseMs <= 120000, 'Pause must be 0-120000ms.');
	const environment = await installedEnvironment();
	const version = await runCli(['--version']);
	assert.equal(version.code, 0, 'The installed CLI is unavailable.');
	assert(version.stdout.includes('0.1.0b8'), 'Install the current beta.8 runtime before benchmarking; an older installed CLI is not the source candidate.');
	const profiles = await runCli(['provider', 'list', '--json']);
	assert.equal(profiles.code, 0, 'Could not read provider metadata.');
	const profile = JSON.parse(profiles.stdout).providers.find(item => item.name === provider);
	assert(profile, 'The selected provider profile does not exist.');
	const output = await mkdtemp(path.join(tmpdir(), 'fikeya-live-efficiency-'));
	const attempts = [];
	const config = { schemaVersion: 'fikeya.live-task-evaluation.v1', protocolRevision: 3, provider, trials, environment,
		runtimeVersion: version.stdout.trim(), model: profile.model, providerKind: profile.kind,
		pauseBetweenAttemptsMs: pauseMs,
		providerEndpointSha256: digest(profile.baseUrl),
		scope: 'Fikeya CLI research loop: full-context versus on-demand file reads on three authored repository questions. Not an independent-agent comparison, Qarinah benchmark, coding-write benchmark, or enterprise production workload.',
		fixtureSha256: digest(JSON.stringify(fixture)), graderSha256: digest(grade.toString()),
		runnerSha256: digest(await readFile(fileURLToPath(import.meta.url))), maxOutputTokens: 1024,
		attemptTimeoutMs: 120000, memory: 'off', pricing: null };
	await writeFile(path.join(output, 'protocol.json'), JSON.stringify(config, null, 2));
	console.log(JSON.stringify({ output, scope: config.scope }));
	for (let trial = 1; trial <= trials; trial++) {
		for (const task of tasks) {
			// Alternate arm order to reduce systematic warm-cache/order effects.
			const arms = (trial + tasks.indexOf(task)) % 2 ? ['full-context', 'on-demand'] : ['on-demand', 'full-context'];
			for (const arm of arms) {
				// Pacing is outside task latency and is identical for both arms.
				// Never silently rerun, drop, or switch the model after a 429.
				if (attempts.length) await delay(pauseMs);
				assert(environmentMatches(environment, await installedEnvironment()), 'Installed code changed during evaluation; start a new run. Earlier attempts remain retained.');
				const runId = `${task.id}-${trial}-${arm}`;
				const workspace = path.join(output, runId);
				await mkdir(workspace);
				await Promise.all(Object.entries(fixture).map(([name, content]) => writeFile(path.join(workspace, name), content)));
				const started = performance.now();
				const initialized = await runCli(['init', workspace, '--json']);
				assert.equal(initialized.code, 0, 'Could not initialize the isolated benchmark workspace.');
				const prompt = task.prompt + '\nUse only the active fixture configuration. You may read README.md, config.json, routes.json, and archive.txt. Do not modify anything or run a process.'
					+ (arm === 'full-context' ? '\nRepository contents:\n' + JSON.stringify(fixture) : '');
				const result = await runCli(['agent', 'execute', workspace, '--provider', provider,
					'--protocol-stdin', '--json-lines', '--allow-network', '--mode', 'research',
					'--memory', 'off', '--timeout', '30', '--max-output-tokens', '1024'], { type: 'start', prompt }, { coding: true });
				const durationMs = Math.round(performance.now() - started);
				const environmentStable = environmentMatches(environment, await installedEnvironment());
				const final = result.messages.findLast(message => message.type === 'result');
				const answer = final?.output ?? final?.outcome?.summary ?? '';
				const record = {
					runId, taskId: task.id, trial, arm, taskPromptSha256: digest(task.prompt),
					requestPromptSha256: digest(prompt), startingStateSha256: config.fixtureSha256,
					durationMs, exitCode: result.code, environmentStable,
					timedOut: result.timedOut, status: final?.status ?? 'incomplete',
					errorKind: result.messages.findLast(message => message.type === 'error')?.kind ?? null,
					failure: final?.failure ?? null,
					stderrSha256: digest(result.stderr),
					verified: environmentStable && result.code === 0 && final?.status === 'completed' && grade(answer, task.expected),
					usage: final?.usage ?? null, providerCallIds: final?.providerCallIds ?? [],
					approvals: result.messages.filter(m => m.type === 'approval').map(m => ({
						toolName: m.toolName, argumentsSha256: m.argumentsSha256, decision: approvalDecision(m)
					})),
					outputSha256: digest(answer),
					// Only authored public fixture answers; no customer repository content.
					answer
				};
				attempts.push(record);
				// Persist every attempt immediately, including failed/unmeasured ones.
				await writeFile(path.join(output, runId + '.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
				await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...config, attempts, summary: summarize(attempts) }, null, 2));
				console.log(JSON.stringify({ runId, verified: record.verified, durationMs: record.durationMs, usage: record.usage }));
				assert(environmentStable, 'Installed code changed during an attempt; the attempt is retained but not verified.');
			}
		}
	}
	console.log(JSON.stringify({ report: path.join(output, 'report.json'), summary: summarize(attempts) }));
	return attempts.every(row => row.verified) ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { process.exitCode = await main(process.argv.slice(2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
