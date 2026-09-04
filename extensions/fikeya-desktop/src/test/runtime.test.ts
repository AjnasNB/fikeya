/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
	agentTerminalFailureToRuntimeFailure,
	buildAgentRunArguments,
	buildFikeyaBrowserEnvironment,
	buildFikeyaRuntimeEnvironment,
	buildPlanActionArguments,
	buildPlanApproveArguments,
	buildPlanCreateArguments,
	buildPlanProposalArguments,
	buildProjectRunArguments,
	buildProviderConfigureArguments,
	buildStatisticsArguments,
	parseAgentApproval,
	parseAgentReceipts,
	parseAgentTurn,
	parseProviderList,
	parseProviderProbe,
	parseProtocolFailure,
	parsePlanProposalView,
	parsePlanView,
	parseProjectView,
	parseRuntimeReport,
	parseStatistics,
	resolveFikeyaCli,
	startFikeyaAgentRun,
	startFikeyaPlan,
	startFikeyaPlanProposal,
	startFikeyaProject
} from '../runtime';

const protocolInvocation = { executable: process.execPath, source: 'path' } as const;

function agentResultRecord(): Readonly<Record<string, unknown>> {
	return {
		providerAttemptId: 'evt_attempt_fixture',
		providerAttemptIds: ['evt_attempt_fixture'],
		callId: 'call_fixture',
		failure: null,
		memory: { coverage: null, evidenceCount: null, receiptId: null, responseSha256: null, status: 'off' },
		ok: true,
		outcome: { changedFiles: [], plan: 'Complete the fixture.', steps: 1, summary: 'Fixture complete.', tests: [], toolCalls: [] },
		output: 'Fixture complete.',
		providerCallIds: ['call_fixture'],
		sessionId: 'ses_fixture',
		status: 'completed',
		type: 'result',
		usage: { cachedInputTokens: null, inputTokens: null, measurement: 'unavailable', outputTokens: null }
	};
}

function planResultRecord(): Readonly<Record<string, unknown>> {
	const hash = `sha256:${'a'.repeat(64)}`;
	return {
		ok: true,
		plan: {
			createdAt: '2026-08-26T10:00:00.000Z',
			failureReason: null,
			planId: 'pln_fixture',
			revision: 2,
			schemaVersion: 1,
			specSha256: hash,
			status: 'awaiting_approval',
			steps: [{
				approval: null,
				dependsOn: [],
				execution: null,
				order: 1,
				status: 'awaiting_approval',
				stepId: 'inspect',
				title: 'Inspect the fixture',
				toolCall: { arguments: { path: '.' }, callId: 'plan_inspect', name: 'workspace.list_files' },
				toolCallSha256: hash,
				verification: null,
				verificationSpec: { expectedExitCode: null, expectedOutputSha256: null, expectedStatus: 'ok', files: [] }
			}],
			title: 'Fixture plan',
			updatedAt: '2026-08-26T10:01:00.000Z',
			workspaceId: 'ws_fixture'
		},
		recordSha256: hash
	};
}

function planProposalResultRecord(): Readonly<Record<string, unknown>> {
	return {
		...planResultRecord(),
		proposal: {
			callId: 'call_plan_fixture',
			memory: { coverage: null, evidenceCount: null, receiptId: null, responseSha256: null, status: 'off' },
			protocol: 'fikeya.plan-proposal.v1',
			sessionId: 'ses_plan_fixture',
			usage: { cachedInputTokens: null, inputTokens: null, measurement: 'unavailable', outputTokens: null }
		}
	};
}

function projectResultRecord(): Readonly<Record<string, unknown>> {
	const hash = `sha256:${'a'.repeat(64)}`;
	const history = ['plan', 'audit_plan', 'execute', 'stopped'].map((stage, index) => ({
		createdAt: `2026-08-28T00:00:0${index}.000Z`,
		documentSha256: `sha256:${String(index + 1).repeat(64)}`,
		revision: index + 1,
		stage
	}));
	return {
		history,
		message: 'Project run reached a durable stop.',
		nextAction: { action: 'review_plan', planId: 'pln_fixture' },
		ok: true,
		planId: 'pln_fixture',
		record: {
			codeAudit: null,
			completionCriteria: [{ criterionId: 'criterion-1', description: 'The project is verified.', descriptionSha256: hash }],
			createdAt: '2026-08-28T00:00:00.000Z',
			executionFailures: 0,
			failureReason: null,
			feedback: '',
			goalSha256: hash,
			limits: { maxExecutionRetries: 2, maxNoProgress: 2, maxPlanRevisions: 3, maxProviderRetries: 2, maxTransitions: 64 },
			noProgressCount: 0,
			planAudit: null,
			planHistory: [hash],
			planId: 'pln_fixture',
			planRevisions: 0,
			planSpecSha256: hash,
			providerFailures: 0,
			resumeStage: 'execute',
			revision: 4,
			runId: 'aut_fixture',
			schemaVersion: 1,
			stage: 'stopped',
			stopReason: 'plan_review_required',
			transitionCount: 3,
			updatedAt: '2026-08-28T00:00:03.000Z',
			verification: null,
			workspaceId: 'ws_fixture'
		},
		runId: 'aut_fixture',
		stage: 'stopped',
		type: 'project_result'
	};
}

async function writeProtocolFixture(
	workspacePath: string,
	command: 'agent' | 'plan',
	records: readonly Readonly<Record<string, unknown>>[],
	exitCode = 0
): Promise<void> {
	const output = records.map(record => `${JSON.stringify(record)}\n`).join('');
	await writeFile(path.join(workspacePath, `${command}.stdout`), output, 'utf8');
	const source = command === 'agent'
		? `const fs = require('node:fs'); const output = fs.readFileSync(process.argv[1] + '.stdout', 'utf8'); process.stdin.once('data', () => { process.stdin.pause(); process.stdout.end(output, () => process.exit(${exitCode})); });\n`
		: `const fs = require('node:fs'); const output = fs.readFileSync(process.argv[1] + '.stdout', 'utf8'); process.stdout.end(output, () => process.exit(${exitCode}));\n`;
	await writeFile(path.join(workspacePath, command), source, 'utf8');
}

async function writeCapturingProtocolFixture(
	workspacePath: string,
	command: 'agent' | 'plan',
	output: string
): Promise<string> {
	const fixturePath = path.join(workspacePath, command);
	const capturePath = `${fixturePath}.capture`;
	await writeFile(`${fixturePath}.stdout`, output, 'utf8');
	const source = command === 'agent'
		? "const fs = require('node:fs'); const base = process.argv[1]; const output = fs.readFileSync(`${base}.stdout`, 'utf8'); let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; const newline = input.indexOf('\\n'); if (newline < 0) return; fs.writeFileSync(`${base}.capture`, input.slice(0, newline), 'utf8'); process.stdin.pause(); process.stdout.end(output, () => process.exit(0)); });\n"
		: "const fs = require('node:fs'); const base = process.argv[1]; const output = fs.readFileSync(`${base}.stdout`, 'utf8'); let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { fs.writeFileSync(`${base}.capture`, input, 'utf8'); process.stdout.end(output); });\n";
	await writeFile(fixturePath, source, 'utf8');
	return capturePath;
}

async function writeProjectProtocolFixture(
	workspacePath: string,
	result: Readonly<Record<string, unknown>>,
	approval?: Readonly<Record<string, unknown>>
): Promise<string> {
	const fixturePath = path.join(workspacePath, 'project');
	const capturePath = `${fixturePath}.capture`;
	const started = { type: 'project_started', runId: result.runId, stage: 'plan', revision: 1 };
	const source = `const fs = require('node:fs'); const base = process.argv[1]; let input = ''; const messages = []; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; while (input.includes('\\n')) { const newline = input.indexOf('\\n'); const message = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); messages.push(message); if (messages.length === 1) { process.stdout.write(${JSON.stringify(`${JSON.stringify(started)}\n`)}); ${approval ? `process.stdout.write(${JSON.stringify(`${JSON.stringify(approval)}\n`)});` : `fs.writeFileSync(base + '.capture', JSON.stringify(messages), 'utf8'); process.stdin.pause(); process.stdout.end(${JSON.stringify(`${JSON.stringify(result)}\n`)}, () => process.exit(0));`} } else { fs.writeFileSync(base + '.capture', JSON.stringify(messages), 'utf8'); process.stdin.pause(); process.stdout.end(${JSON.stringify(`${JSON.stringify(result)}\n`)}, () => process.exit(0)); } } });\n`;
	await writeFile(fixturePath, source, 'utf8');
	return capturePath;
}

describe('Fikeya runtime protocol', () => {
	test('classifies bounded provider handoff messages without inventing an HTTP response', () => {
		assert.strictEqual(parseProtocolFailure({
			kind: 'quota',
			message: 'Provider returned HTTP 429; response body was not retained.',
			retryable: true,
			statusCode: 429,
			type: 'error'
		}), 'quota');
		assert.strictEqual(parseProtocolFailure({
			kind: 'quota',
			message: '',
			retryable: true,
			statusCode: 429,
			type: 'error'
		}), undefined);
		assert.strictEqual(parseProtocolFailure({
			kind: 'connectivity',
			message: 'Provider endpoint could not be reached before a response was received.',
			retryable: true,
			type: 'error'
		}), 'provider-unreachable');
		assert.strictEqual(parseProtocolFailure({
			kind: 'connectivity',
			message: 'Provider endpoint could not be reached before a response was received.',
			retryable: true,
			statusCode: 503,
			type: 'error'
		}), undefined, 'connectivity failures must not imply that an HTTP response existed');
		assert.strictEqual(parseProtocolFailure({
			kind: 'agent_no_progress',
			message: 'Fikeya stopped before repeating an unchanged provider request.',
			retryable: false,
			type: 'error'
		}), 'agent-no-progress');
	});

	test('returns a specific failure when the agent protocol cannot reach its provider', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-connectivity-'));
		try {
			await writeProtocolFixture(workspacePath, 'agent', [{
				kind: 'connectivity',
				message: 'Provider endpoint could not be reached before a response was received.',
				retryable: true,
				type: 'error'
			}], 2);
			const operation = startFikeyaAgentRun(
				'fixture-provider', 'Complete the fixture.', 256, 512, 'off', workspacePath,
				async () => 'deny_once', [], [], 'build', protocolInvocation, process.env
			);

			assert.deepStrictEqual(await operation.result, {
				exitCode: 2,
				failure: 'provider-unreachable',
				ok: false
			});
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('prefers the absolute extension-owned runtime over PATH', async () => {
		const extensionPath = path.join(tmpdir(), `fikeya-desktop-runtime-${process.pid}-${Date.now()}`);
		const runtimeDirectory = path.join(extensionPath, 'runtime');
		await mkdir(runtimeDirectory, { recursive: true });
		await writeFile(path.join(runtimeDirectory, 'fikeya-runtime.exe'), 'fixture', 'utf8');

		assert.deepStrictEqual(resolveFikeyaCli(extensionPath, 'win32'), {
			executable: path.join(runtimeDirectory, 'fikeya-runtime.exe'),
			source: 'bundled'
		});
		assert.deepStrictEqual(resolveFikeyaCli(extensionPath, 'linux'), {
			executable: 'fikeya',
			source: 'path'
		});
	});

	test('parses the actual init response shape', () => {
		assert.deepStrictEqual(parseRuntimeReport({
			created: true,
			message: 'Initialized Fikeya workspace.',
			ok: true,
			root: 'D:\\workspace',
			workspaceId: 'ws_example'
		}, 'init'), {
			status: 'initialized',
			initialized: true,
			workspaceId: 'ws_example'
		});
	});

	test('derives workspace, Qarinah, and provider status from doctor checks', () => {
		assert.deepStrictEqual(parseRuntimeReport({
			ok: true,
			checks: [
				{ name: 'workspace', ok: true, detail: 'ws_example' },
				{ name: 'provider-metadata', ok: true, detail: '7 configured' },
				{ name: 'qarinah', ok: false, optional: true, detail: 'optional CLI not found' }
			]
		}, 'doctor'), {
			status: 'ready',
			initialized: true,
			workspaceId: 'ws_example',
			qarinah: 'optional CLI not found',
			providerCount: 7
		});
	});

	test('never places provider credential bytes in process arguments', () => {
		const secret = 'credential-must-remain-on-stdin';
		const args = buildProviderConfigureArguments({
			name: 'openrouter-primary',
			kind: 'openrouter',
			model: 'example/model',
			baseUrl: 'https://openrouter.ai/api/v1',
			credentialType: 'bearer'
		}, true);

		assert.ok(args.includes('--secret-stdin'));
		assert.ok(args.includes('--json'));
		assert.ok(!args.includes(secret));
		assert.ok(!args.some(argument => /api[-_]?key|credential-must-remain/i.test(argument)));
	});

	test('omits secret stdin for credential-free local providers', () => {
		const args = buildProviderConfigureArguments({
			name: 'ollama-local',
			kind: 'ollama',
			model: 'qwen3',
			baseUrl: 'http://127.0.0.1:11434',
			credentialType: 'none'
		}, false);

		assert.ok(!args.includes('--secret-stdin'));
	});

	test('configures Azure Entra ID without a credential payload', () => {
		const args = buildProviderConfigureArguments({
			name: 'azure-production',
			kind: 'azure-openai',
			model: 'coding-deployment',
			baseUrl: 'https://example.openai.azure.com',
			credentialType: 'entra-id'
		}, false);

		assert.deepStrictEqual(args.slice(-3), ['--credential-type', 'entra-id', '--json']);
		assert.ok(!args.includes('--secret-stdin'));
	});

	test('configures Google Gemini through its compatible API without exposing the key', () => {
		const args = buildProviderConfigureArguments({
			name: 'google-gemini-work',
			kind: 'google-gemini',
			model: 'gemini-2.5-pro',
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
			credentialType: 'bearer'
		}, true);

		assert.ok(args.includes('google-gemini'));
		const credentialTypeIndex = args.indexOf('--credential-type');
		assert.ok(credentialTypeIndex >= 0);
		assert.equal(args[credentialTypeIndex + 1], 'bearer');
		assert.ok(args.includes('--secret-stdin'));
		assert.ok(!args.some(argument => argument.includes('AIza')));
	});

	test('parses live provider profiles without credential bytes', () => {
		assert.deepStrictEqual(parseProviderList({
			ok: true,
			providers: [{
				baseUrl: 'https://example.openai.azure.com',
				credentialType: 'entra-id',
				kind: 'azure-openai',
				model: 'coding-deployment',
				name: 'azure-primary',
				secretConfigured: false
			}]
		}), [{
			baseUrl: 'https://example.openai.azure.com',
			credentialType: 'entra-id',
			kind: 'azure-openai',
			model: 'coding-deployment',
			name: 'azure-primary',
			secretConfigured: false
		}]);
	});

	test('keeps prompt content out of agent process arguments', () => {
		const prompt = 'private prompt content';
		const args = buildAgentRunArguments('openrouter-primary', 2048, 12_000, 'auto', 'review');
		assert.deepStrictEqual(args.slice(0, 7), ['agent', 'execute', '.', '--provider', 'openrouter-primary', '--protocol-stdin', '--allow-network']);
		assert.ok(!args.includes(prompt));
		assert.deepStrictEqual(args.slice(-9), ['--context-max-characters', '12000', '--memory', 'auto', '--mode', 'review', '--browser-engine', 'playwright', '--json-lines']);
		assert.ok(args.includes('--context-max-characters'));
		assert.ok(args.includes('--json-lines'));
	});

	test('keeps project goals off argv and binds resume to one durable run', () => {
		const goal = 'Build the complete animation and verify it.';
		const start = buildProjectRunArguments('start', 'azure-primary');
		const resume = buildProjectRunArguments('resume', 'azure-primary', 'aut_fixture');
		const localBrowserResume = buildProjectRunArguments('resume', 'azure-primary', 'aut_fixture', true);
		assert.deepStrictEqual(start, ['project', 'start', '.', '--provider', 'azure-primary', '--protocol-stdin', '--allow-network', '--browser-engine', 'playwright', '--json-lines']);
		assert.deepStrictEqual(resume, ['project', 'resume', 'aut_fixture', '--workspace', '.', '--provider', 'azure-primary', '--protocol-stdin', '--allow-network', '--browser-engine', 'playwright', '--json-lines']);
		assert.deepStrictEqual(localBrowserResume, ['project', 'resume', 'aut_fixture', '--workspace', '.', '--provider', 'azure-primary', '--protocol-stdin', '--allow-network', '--allow-private-browser', '--browser-engine', 'playwright', '--json-lines']);
		assert.deepStrictEqual(buildProjectRunArguments('start', 'azure-primary', undefined, false, 'puppeteer').slice(-3), ['--browser-engine', 'puppeteer', '--json-lines']);
		assert.ok(!start.includes(goal));
		assert.ok(!resume.includes(goal));
	});

	test('parses exact durable project stages, history, and next action', () => {
		const value = projectResultRecord();
		const parsed = parseProjectView(value);
		assert.strictEqual(parsed?.runId, 'aut_fixture');
		assert.strictEqual(parsed?.planId, 'pln_fixture');
		assert.strictEqual(parsed?.stage, 'stopped');
		assert.strictEqual(parsed?.history.length, 4);
		assert.deepStrictEqual(parsed?.nextAction, { action: 'review_plan', planId: 'pln_fixture' });

		assert.strictEqual(parseProjectView({ ...value, unexpected: true }), undefined);
		assert.strictEqual(parseProjectView({ ...value, stage: 'completed' }), undefined);
		assert.strictEqual(parseProjectView({ ...value, runId: 'aut_other' }), undefined);
		assert.strictEqual(parseProjectView({ ...value, history: (value.history as object[]).slice(1) }), undefined);
		assert.strictEqual(parseProjectView({ ...value, nextAction: { action: 'review_plan', planId: 'pln_other' } }), undefined);
		assert.strictEqual(parseProjectView({ ...value, nextAction: { action: 'resume_project', runId: 'aut_fixture' } }), undefined);
		assert.strictEqual(parseProjectView({ ...value, nextAction: null }), undefined);
		assert.strictEqual(parseProjectView({ ...value, record: { ...(value.record as object), goalSha256: 'bad' } }), undefined);

		const digest = `sha256:${'c'.repeat(64)}`;
		const record = value.record as Readonly<Record<string, unknown>>;
		const audited = {
			...value,
			record: {
				...record,
				planAudit: { accepted: true, criteriaSha256: null, executionEvidenceSha256: null, phase: 'audit_plan', planSpecSha256: digest, resultSha256: digest },
				codeAudit: { accepted: true, criteriaSha256: null, executionEvidenceSha256: digest, phase: 'audit_code', planSpecSha256: digest, resultSha256: digest },
				verification: { accepted: true, criteriaSha256: digest, executionEvidenceSha256: digest, phase: 'verify', planSpecSha256: digest, resultSha256: digest }
			}
		};
		assert.ok(parseProjectView(audited), 'real audit bindings include their execution evidence digest');
		assert.strictEqual(parseProjectView({
			...audited,
			record: {
				...(audited.record as Readonly<Record<string, unknown>>),
				codeAudit: { accepted: true, criteriaSha256: null, phase: 'audit_code', planSpecSha256: digest, resultSha256: digest }
			}
		}), undefined, 'audit bindings fail closed when execution evidence is omitted');
	});

	test('uses bounded project JSON lines and sends only an exact approval decision', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-project-'));
		try {
			const approval = {
				arguments: { path: 'src/main.ts' },
				argumentsSha256: 'b'.repeat(64),
				callId: 'read_main',
				expectedRevision: 2,
				requestId: 'approval_project',
				sessionId: 'ses_project',
				summary: 'Read src/main.ts',
				toolName: 'workspace.read_file',
				type: 'approval'
			};
			const capturePath = await writeProjectProtocolFixture(workspacePath, projectResultRecord(), approval);
			const operation = startFikeyaProject(
				'start',
				'fixture-provider',
				'Build the verified fixture.',
				workspacePath,
				async request => {
					assert.deepStrictEqual(request, approval);
					return 'allow_once';
				},
				undefined,
				['The fixture is rendered and verified.'], false,
				protocolInvocation,
				process.env
			);
			let startedRunId: string | undefined;
			const stopStartedObserver = operation.onStarted(started => {
				startedRunId = started.runId;
			});
			const result = await operation.result;
			stopStartedObserver();
			const captured = JSON.parse(await readFile(capturePath, 'utf8'));
			assert.strictEqual(result.ok, true);
			assert.strictEqual(startedRunId, 'aut_fixture');
			assert.strictEqual(result.value?.stage, 'stopped');
			assert.deepStrictEqual(captured, [
				{ type: 'start', goal: 'Build the verified fixture.', completionCriteria: ['The fixture is rendered and verified.'] },
				{ type: 'approval', requestId: 'approval_project', decision: 'allow_once' }
			]);
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('resumes a project with the exact goal and rejects malformed local requests', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-project-resume-'));
		try {
			const capturePath = await writeProjectProtocolFixture(workspacePath, projectResultRecord());
			const operation = startFikeyaProject(
				'resume', 'fixture-provider', 'Build the verified fixture.', workspacePath,
				async () => 'deny_once', 'aut_fixture', [], false, protocolInvocation, process.env
			);
			assert.strictEqual((await operation.result).ok, true);
			assert.deepStrictEqual(JSON.parse(await readFile(capturePath, 'utf8')), [
				{ type: 'resume', runId: 'aut_fixture', goal: 'Build the verified fixture.' }
			]);
			assert.deepStrictEqual(await startFikeyaProject(
				'resume', 'fixture-provider', 'Goal', workspacePath, async () => 'deny_once', '../escape'
			).result, { ok: false, exitCode: null, failure: 'runtime-error' });
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('sends bounded provider history only through agent and planning stdin payloads', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-history-'));
		try {
			const history = [
				{ role: 'user', content: 'Inspect the current implementation.' },
				{ role: 'assistant', content: 'I inspected the focused files.' }
			] as const;
			const agentOutput = `${JSON.stringify(agentResultRecord())}\n`;
			const agentCapturePath = await writeCapturingProtocolFixture(workspacePath, 'agent', agentOutput);
			const agentOperation = startFikeyaAgentRun(
				'fixture-provider', 'Continue the work.', 256, 512, 'off', workspacePath,
				async () => 'deny_once', history, [], 'build', protocolInvocation, process.env
			);
			const agentResult = await agentOperation.result;

			const proposalOutput = `${JSON.stringify(planProposalResultRecord())}\n`;
			const proposalCapturePath = await writeCapturingProtocolFixture(workspacePath, 'plan', proposalOutput);
			const proposalOperation = startFikeyaPlanProposal(
				'fixture-provider', 'Create the next plan.', 256, 512, 'off', workspacePath,
				history, [], protocolInvocation, process.env
			);
			const proposalResult = await proposalOperation.result;

			const rejectedAgent = startFikeyaAgentRun(
				'fixture-provider', 'Reject this history.', 256, 512, 'off', workspacePath,
				async () => 'deny_once', Array.from({ length: 13 }, () => ({ role: 'user' as const, content: 'bounded' })),
				[], 'build', protocolInvocation, process.env
			);
			const rejectedProposal = startFikeyaPlanProposal(
				'fixture-provider', 'Reject this history.', 256, 512, 'off', workspacePath,
				[{ role: 'assistant', content: 'History cannot begin with an assistant.' }], [], protocolInvocation, process.env
			);

			assert.deepStrictEqual({
				agentPayload: JSON.parse(await readFile(agentCapturePath, 'utf8')),
				agentResult: { ok: agentResult.ok, failure: agentResult.failure },
				proposalPayload: JSON.parse(await readFile(proposalCapturePath, 'utf8')),
				proposalResult: { ok: proposalResult.ok, failure: proposalResult.failure },
				rejectedAgent: await rejectedAgent.result,
				rejectedProposal: await rejectedProposal.result
			}, {
				agentPayload: { type: 'start', prompt: 'Continue the work.', history, images: [] },
				agentResult: { ok: true, failure: 'none' },
				proposalPayload: { protocol: 'fikeya.plan-request.v1', prompt: 'Create the next plan.', history, images: [] },
				proposalResult: { ok: true, failure: 'none' },
				rejectedAgent: { ok: false, exitCode: null, failure: 'runtime-error' },
				rejectedProposal: { ok: false, exitCode: null, failure: 'runtime-error' }
			});
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('delivers ordered bounded progress from agent and plan handles without replacing final results', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-progress-'));
		try {
			const progress = [
				{ event: 'stage_started', sequence: 1, stage: 'planning', type: 'progress' },
				{ event: 'stage_completed', sequence: 2, stage: 'planning', type: 'progress' }
			] as const;
			await writeProtocolFixture(workspacePath, 'agent', [...progress, agentResultRecord()]);
			const agentOperation = startFikeyaAgentRun(
				'fixture-provider',
				'Complete the fixture.',
				256,
				512,
				'off',
				workspacePath,
				async () => 'deny_once',
				[],
				[],
				'build',
				protocolInvocation,
				process.env
			);
			const agentProgress: unknown[] = [];
			const disposeAgentProgress = agentOperation.onProgress(event => agentProgress.push(event));
			const agentResult = await agentOperation.result;
			disposeAgentProgress();

			await writeProtocolFixture(workspacePath, 'plan', [...progress, planResultRecord()]);
			const planOperation = startFikeyaPlan('run', 'pln_fixture', workspacePath, false, protocolInvocation, process.env);
			const planProgress: unknown[] = [];
			const disposePlanProgress = planOperation.onProgress(event => planProgress.push(event));
			const planResult = await planOperation.result;
			disposePlanProgress();

			assert.deepStrictEqual({
				agentProgress,
				agentResult: { ok: agentResult.ok, failure: agentResult.failure, output: agentResult.value?.output },
				planProgress,
				planResult: { ok: planResult.ok, failure: planResult.failure, status: planResult.value?.plan.status }
			}, {
				agentProgress: progress,
				agentResult: { ok: true, failure: 'none', output: 'Fixture complete.' },
				planProgress: progress,
				planResult: { ok: true, failure: 'none', status: 'awaiting_approval' }
			});
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('replays the latest bounded progress event to an immediate late subscriber', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-progress-replay-'));
		try {
			const progress = { event: 'stage_started', sequence: 1, stage: 'executing', type: 'progress' } as const;
			const approval = {
				arguments: { path: '.' },
				argumentsSha256: 'a'.repeat(64),
				callId: 'tool_fixture',
				expectedRevision: 1,
				requestId: 'approval_fixture',
				sessionId: 'ses_fixture',
				summary: 'Inspect the fixture',
				toolName: 'workspace.list_files',
				type: 'approval'
			};
			const initialOutput = `${JSON.stringify(progress)}\n${JSON.stringify(approval)}\n`;
			const finalOutput = `${JSON.stringify(agentResultRecord())}\n`;
			await writeFile(
				path.join(workspacePath, 'agent'),
				`let input = ''; let started = false; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; while (input.includes('\\n')) { const newline = input.indexOf('\\n'); const message = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); if (message.type === 'start' && !started) { started = true; process.stdout.write(${JSON.stringify(initialOutput)}); } else if (message.type === 'approval') { process.stdin.pause(); process.stdout.end(${JSON.stringify(finalOutput)}, () => process.exit(0)); } } });\n`,
				'utf8'
			);

			let signalApprovalReached = (): void => undefined;
			const approvalReached = new Promise<void>(resolve => signalApprovalReached = resolve);
			let releaseApproval = (): void => undefined;
			const approvalRelease = new Promise<void>(resolve => releaseApproval = resolve);
			const operation = startFikeyaAgentRun(
				'fixture-provider', 'Complete the fixture.', 256, 512, 'off', workspacePath,
				async () => {
					signalApprovalReached();
					await approvalRelease;
					return 'deny_once';
				},
				[], [], 'build', protocolInvocation, process.env
			);
			await approvalReached;
			const observed: unknown[] = [];
			operation.onProgress(event => observed.push(event));
			releaseApproval();
			const result = await operation.result;

			assert.deepStrictEqual({ observed, result: { ok: result.ok, failure: result.failure } }, {
				observed: [progress],
				result: { ok: true, failure: 'none' }
			});
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('rejects malformed, oversized, and non-monotonic progress records', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-invalid-progress-'));
		try {
			await writeProtocolFixture(workspacePath, 'agent', [
				{ event: 'stage_started', extra: true, sequence: 1, stage: 'planning', type: 'progress' },
				agentResultRecord()
			]);
			const malformedAgent = startFikeyaAgentRun(
				'fixture-provider', 'Complete the fixture.', 256, 512, 'off', workspacePath,
				async () => 'deny_once', [], [], 'build', protocolInvocation, process.env
			);
			const malformedAgentProgress: unknown[] = [];
			malformedAgent.onProgress(event => malformedAgentProgress.push(event));

			await writeProtocolFixture(workspacePath, 'plan', [
				{ event: 'x'.repeat(81), sequence: 1, stage: 'planning', type: 'progress' },
				planResultRecord()
			]);
			const oversizedPlan = startFikeyaPlan('run', 'pln_fixture', workspacePath, false, protocolInvocation, process.env);
			const oversizedPlanProgress: unknown[] = [];
			oversizedPlan.onProgress(event => oversizedPlanProgress.push(event));

			const malformedAgentResult = await malformedAgent.result;
			const oversizedPlanResult = await oversizedPlan.result;

			await writeProtocolFixture(workspacePath, 'plan', [
				{ event: 'stage_started', sequence: 2, stage: 'executing', type: 'progress' },
				{ event: 'stage_completed', sequence: 2, stage: 'executing', type: 'progress' },
				planResultRecord()
			]);
			const unorderedPlan = startFikeyaPlan('resume', 'pln_fixture', workspacePath, false, protocolInvocation, process.env);
			const unorderedPlanProgress: unknown[] = [];
			unorderedPlan.onProgress(event => unorderedPlanProgress.push(event));
			const unorderedPlanResult = await unorderedPlan.result;

			assert.deepStrictEqual({
				malformedAgent: { failure: malformedAgentResult.failure, progress: malformedAgentProgress },
				oversizedPlan: { failure: oversizedPlanResult.failure, progress: oversizedPlanProgress },
				unorderedPlan: { failure: unorderedPlanResult.failure, progress: unorderedPlanProgress }
			}, {
				malformedAgent: { failure: 'invalid-json', progress: [] },
				oversizedPlan: { failure: 'invalid-json', progress: [] },
				unorderedPlan: {
					failure: 'invalid-json',
					progress: [{ event: 'stage_started', sequence: 2, stage: 'executing', type: 'progress' }]
				}
			});
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('plan progress observers can cancel without changing cancellation semantics', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-progress-cancel-'));
		try {
			const progress = { event: 'stage_started', sequence: 1, stage: 'executing', type: 'progress' };
			await writeFile(
				path.join(workspacePath, 'plan'),
				`process.stdout.write(${JSON.stringify(`${JSON.stringify(progress)}\n`)}); setInterval(() => undefined, 1000);\n`,
				'utf8'
			);
			const operation = startFikeyaPlan('run', 'pln_fixture', workspacePath, false, protocolInvocation, process.env);
			operation.onProgress(() => operation.cancel());
			const cancelled = await operation.result;
			assert.deepStrictEqual({ ok: cancelled.ok, failure: cancelled.failure }, { ok: false, failure: 'cancelled' });
			assert.notStrictEqual(cancelled.exitCode, 0);
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('connects the runtime to the extension-owned Qarinah sidecar without mutating the parent environment', async () => {
		const extensionPath = path.join(tmpdir(), `fikeya-desktop-sidecar-${process.pid}-${Date.now()}`);
		const sidecarDirectory = path.join(extensionPath, 'sidecar');
		await mkdir(sidecarDirectory, { recursive: true });
		await writeFile(path.join(sidecarDirectory, 'qarinah-memory-view.mjs'), 'fixture', 'utf8');
		const parentEnvironment: NodeJS.ProcessEnv = { PATH: 'fixed-path' };

		assert.deepStrictEqual(buildFikeyaRuntimeEnvironment(extensionPath, 'C:\\fake\\Code.exe', parentEnvironment), {
			PATH: 'fixed-path',
			ELECTRON_RUN_AS_NODE: '1',
			FIKEYA_NODE_EXECUTABLE: 'C:\\fake\\Code.exe',
			FIKEYA_QARINAH_SIDECAR: path.join(sidecarDirectory, 'qarinah-memory-view.mjs')
		});
		assert.deepStrictEqual(parentEnvironment, { PATH: 'fixed-path' });
	});

	test('accepts an initial-provider-failure result with an attempt but no receipt on exit code 2', async () => {
		const workspacePath = await mkdtemp(path.join(tmpdir(), 'fikeya-runtime-failed-result-'));
		try {
			const base = agentResultRecord();
			const output = 'The run failed; measured file evidence remains available.';
			const failed = {
				...base,
				callId: null,
				failure: { kind: 'quota', retryable: true, statusCode: 429 },
				ok: false,
				providerCallIds: [],
				status: 'failed',
				output,
				outcome: { ...(base.outcome as Record<string, unknown>), summary: output }
			};
			await writeProtocolFixture(workspacePath, 'agent', [failed], 2);
			const operation = startFikeyaAgentRun(
				'fixture-provider', 'Complete the fixture.', 256, 512, 'off', workspacePath,
				async () => 'deny_once', [], [], 'build', protocolInvocation, process.env
			);
			const result = await operation.result;
			assert.strictEqual(result.ok, true);
			assert.strictEqual(result.failure, 'none');
			assert.strictEqual(result.exitCode, 2);
			assert.strictEqual(result.value?.status, 'failed');
			assert.deepStrictEqual(result.value?.failure, { kind: 'quota', retryable: true, statusCode: 429 });
			assert.strictEqual(agentTerminalFailureToRuntimeFailure(result.value!.failure!), 'quota');
			assert.strictEqual(result.value?.providerAttemptId, 'evt_attempt_fixture');
			assert.strictEqual(result.value?.callId, null);
			assert.deepStrictEqual(result.value?.providerCallIds, []);
		} finally {
			await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	test('maps structured connectivity and authentication failures without collapsing their semantics', () => {
		assert.strictEqual(agentTerminalFailureToRuntimeFailure({
			kind: 'connectivity', retryable: true, statusCode: null
		}), 'provider-unreachable');
		assert.strictEqual(agentTerminalFailureToRuntimeFailure({
			kind: 'authentication', retryable: false, statusCode: 401
		}), 'authentication');
	});

	test('rejects contradictory structured terminal failure classifications', () => {
		const base = agentResultRecord();
		const failed = (failure: unknown) => {
			const output = 'The provider request failed.';
			return parseAgentTurn({
				...base,
				callId: null,
				failure,
				ok: false,
				providerCallIds: [],
				status: 'failed',
				output,
				outcome: { ...(base.outcome as Record<string, unknown>), summary: output }
			});
		};

		assert.ok(failed({ kind: 'provider', retryable: true, statusCode: 503 }));
		assert.ok(failed({ kind: 'provider', retryable: false, statusCode: null }));
		assert.strictEqual(failed({ kind: 'quota', retryable: false, statusCode: 429 }), undefined);
		assert.strictEqual(failed({ kind: 'provider', retryable: false, statusCode: 503 }), undefined);
		assert.strictEqual(failed({ kind: 'provider', retryable: true, statusCode: null }), undefined);
		assert.strictEqual(failed({ kind: 'provider', retryable: true, statusCode: 429 }), undefined);
		assert.strictEqual(failed({ kind: 'connectivity', retryable: true, statusCode: null, detail: 'extra' }), undefined);
	});

	test('keeps Puppeteer selection explicit and removes stale transport paths', () => {
		const parentEnvironment: NodeJS.ProcessEnv = {
			FIKEYA_PUPPETEER_ROOT: 'stale-root',
			FIKEYA_CHROME_EXECUTABLE: 'stale-chrome',
			PATH: 'fixed-path'
		};
		assert.deepStrictEqual(buildFikeyaBrowserEnvironment({ engine: 'playwright' }, parentEnvironment), {
			FIKEYA_BROWSER_ENGINE: 'playwright',
			PATH: 'fixed-path'
		});
		assert.deepStrictEqual(buildFikeyaBrowserEnvironment({
			engine: 'puppeteer',
			puppeteerRoot: 'D:\\reviewed\\puppeteer',
			chromeExecutable: 'D:\\reviewed\\chrome.exe'
		}, parentEnvironment), {
			FIKEYA_BROWSER_ENGINE: 'puppeteer',
			FIKEYA_PUPPETEER_ROOT: 'D:\\reviewed\\puppeteer',
			FIKEYA_CHROME_EXECUTABLE: 'D:\\reviewed\\chrome.exe',
			PATH: 'fixed-path'
		});
		assert.deepStrictEqual(parentEnvironment, {
			FIKEYA_PUPPETEER_ROOT: 'stale-root',
			FIKEYA_CHROME_EXECUTABLE: 'stale-chrome',
			PATH: 'fixed-path'
		});
	});

	test('keeps exact plan specifications out of process arguments', () => {
		const privateContent = 'private file content';
		assert.deepStrictEqual(buildPlanCreateArguments(), ['plan', 'create', '.', '--spec-stdin', '--json']);
		assert.ok(!buildPlanCreateArguments().includes(privateContent));
		assert.deepStrictEqual(buildPlanActionArguments('resume', 'pln_example'), ['plan', 'resume', 'pln_example', '--workspace', '.', '--browser-engine', 'playwright', '--json']);
		assert.deepStrictEqual(buildPlanActionArguments('resume', 'pln_example', true), ['plan', 'resume', 'pln_example', '--workspace', '.', '--allow-private-browser', '--browser-engine', 'playwright', '--json']);
		assert.deepStrictEqual(buildPlanApproveArguments('pln_example', ['inspect', 'verify']), ['plan', 'approve', 'pln_example', '--workspace', '.', '--step', 'inspect', '--step', 'verify', '--json']);
		assert.deepStrictEqual(buildPlanApproveArguments('pln_example', 'all'), ['plan', 'approve', 'pln_example', '--workspace', '.', '--all', '--json']);
		const proposalArgs = buildPlanProposalArguments('azure-primary', 2048, 12_000, 'required');
		assert.deepStrictEqual(proposalArgs.slice(0, 7), ['plan', 'propose', '.', '--provider', 'azure-primary', '--request-stdin', '--allow-network']);
		assert.deepStrictEqual(proposalArgs.slice(-5), ['--context-max-characters', '12000', '--memory', 'required', '--json']);
		assert.ok(!proposalArgs.includes(privateContent));
	});

	test('parses a durable plan with exact approval, execution, and verification evidence', () => {
		const hash = (character: string) => `sha256:${character.repeat(64)}`;
		const plan = {
			createdAt: '2026-08-26T10:00:00.000Z',
			failureReason: null,
			planId: 'pln_example',
			revision: 5,
			schemaVersion: 1,
			specSha256: hash('a'),
			status: 'succeeded',
			steps: [{
				approval: { consumedAt: '2026-08-26T10:01:00.000Z', expiresAt: '2026-08-26T10:05:30.000Z', issuedAt: '2026-08-26T10:00:30.000Z', referenceId: 'apr_example', toolCallSha256: hash('b') },
				dependsOn: [],
				execution: { durationMs: 4, executionSha256: hash('d'), exitCode: null, finishedAt: '2026-08-26T10:01:00.004Z', resultSha256: hash('c'), startedAt: '2026-08-26T10:01:00.000Z', status: 'ok', toolCallSha256: hash('b') },
				order: 1,
				status: 'succeeded',
				stepId: 'inspect',
				title: 'Inspect the project',
				toolCall: { arguments: { path: '.' }, callId: 'plan:list', name: 'workspace.list_files' },
				toolCallSha256: hash('b'),
				verification: { checks: [{ actual: 'ok', expected: 'ok', kind: 'status', passed: true, subject: 'workspace.list_files' }], outcomeSha256: hash('e'), status: 'passed', verifiedAt: '2026-08-26T10:01:00.005Z' },
				verificationSpec: { expectedExitCode: null, expectedOutputSha256: null, expectedStatus: 'ok', files: [] }
			}],
			title: 'Inspect this project safely',
			updatedAt: '2026-08-26T10:01:00.005Z',
			workspaceId: 'ws_example'
		};
		const parsed = parsePlanView({ ok: true, plan, receipt: {}, recordSha256: hash('f') });
		assert.strictEqual(parsed?.recordSha256, hash('f'));
		assert.strictEqual(parsed?.plan.status, 'succeeded');
		assert.strictEqual(parsed?.plan.steps[0].approval?.referenceId, 'apr_example');
		assert.strictEqual(parsed?.plan.steps[0].approval?.expiresAt, '2026-08-26T10:05:30.000Z');
		assert.strictEqual(parsed?.plan.steps[0].execution?.executionSha256, hash('d'));
		assert.strictEqual(parsed?.plan.steps[0].verification?.checks[0].passed, true);
		assert.deepStrictEqual(parsed?.plan.steps[0].toolCall.arguments, { path: '.' });
		assert.deepStrictEqual(parsed?.plan.steps[0].verificationSpec, { expectedExitCode: null, expectedOutputSha256: null, expectedStatus: 'ok', files: [] });
		const mismatchedApproval = structuredClone({ ok: true, plan, receipt: {}, recordSha256: hash('f') });
		mismatchedApproval.plan.steps[0].approval.toolCallSha256 = hash('9');
		assert.strictEqual(parsePlanView(mismatchedApproval), undefined);
		const malformedExpiry = structuredClone({ ok: true, plan, receipt: {}, recordSha256: hash('f') });
		malformedExpiry.plan.steps[0].approval.expiresAt = 'not-a-timestamp';
		assert.strictEqual(parsePlanView(malformedExpiry), undefined, 'approval expiry must be a timestamp');
		const precedingExpiry = structuredClone({ ok: true, plan, receipt: {}, recordSha256: hash('f') });
		precedingExpiry.plan.steps[0].approval.expiresAt = '2026-08-26T10:00:29.999Z';
		assert.strictEqual(parsePlanView(precedingExpiry), undefined, 'approval expiry cannot precede issuance');
		const legacyApproval = structuredClone({ ok: true, plan, receipt: {}, recordSha256: hash('f') });
		delete (legacyApproval.plan.steps[0].approval as Partial<typeof plan.steps[0]['approval']>).expiresAt;
		assert.strictEqual(
			parsePlanView(legacyApproval)?.plan.steps[0].approval?.expiresAt,
			'2026-08-26T10:00:30.000Z',
			'legacy approvals normalize expiry to issuance and therefore fail closed at execution time'
		);
		assert.strictEqual(parsePlanView({
			ok: true,
			plan: {
				...plan,
				steps: [
					plan.steps[0],
					{ ...plan.steps[0], approval: null, dependsOn: ['inspect'], execution: null, order: 2, status: 'pending', stepId: 'second', verification: null }
				]
			},
			recordSha256: hash('f')
		}), undefined, 'duplicate tool-call identifiers must be rejected');
		assert.strictEqual(parsePlanView({
			ok: true,
			plan: {
				...plan,
				steps: [
					plan.steps[0],
					{ ...plan.steps[0], approval: null, dependsOn: ['inspect', 'inspect'], execution: null, order: 2, status: 'pending', stepId: 'second', toolCall: { ...plan.steps[0].toolCall, callId: 'plan:second' }, verification: null }
				]
			},
			recordSha256: hash('f')
		}), undefined, 'duplicate dependency identifiers must be rejected');
		assert.strictEqual(parsePlanView({ ok: true, plan: { ...plan, title: '🧠'.repeat(1_025) }, recordSha256: hash('f') }), undefined, 'title limits use UTF-8 bytes');
		assert.strictEqual(parsePlanView({
			ok: true,
			plan: { ...plan, steps: [{ ...plan.steps[0], verificationSpec: { ...plan.steps[0].verificationSpec, unexpected: true } }] },
			recordSha256: hash('f')
		}), undefined, 'verification specifications reject unknown fields');
		assert.strictEqual(parsePlanView({
			ok: true,
			plan: { ...plan, steps: [{ ...plan.steps[0], toolCall: { ...plan.steps[0].toolCall, arguments: { limit: Number.NaN } } }] },
			recordSha256: hash('f')
		}), undefined, 'tool arguments reject non-finite values');

		const proposalValue = {
			ok: true,
			plan,
			recordSha256: hash('f'),
			proposal: {
				protocol: 'fikeya.plan-proposal.v1',
				sessionId: 'ses_plan_example',
				callId: 'call_plan_example',
				usage: { measurement: 'provider-reported', inputTokens: 120, outputTokens: 80, cachedInputTokens: 20 },
				memory: { status: 'off', coverage: null, evidenceCount: null, receiptId: null, responseSha256: null }
			}
		};
		const proposal = parsePlanProposalView(proposalValue);
		assert.strictEqual(proposal?.proposal.protocol, 'fikeya.plan-proposal.v1');
		assert.strictEqual(proposal?.proposal.sessionId, 'ses_plan_example');
		assert.strictEqual(proposal?.plan.planId, 'pln_example');
		assert.strictEqual(parsePlanProposalView({
			...proposalValue,
			proposal: { ...proposalValue.proposal, protocol: 'fikeya.plan-proposal.v2' }
		}), undefined);
	});

	test('accepts a failed plan document while rejecting unsupported tool records', () => {
		const hash = `sha256:${'a'.repeat(64)}`;
		const value = {
			ok: false,
			recordSha256: hash,
			plan: {
				createdAt: '2026-08-26T10:00:00.000Z', failureReason: 'Verification failed.', planId: 'pln_failed', revision: 2, schemaVersion: 1,
				specSha256: hash, status: 'failed', title: 'Fail safely', updatedAt: '2026-08-26T10:01:00.000Z', workspaceId: 'ws_example',
				steps: [{ approval: null, dependsOn: [], execution: null, order: 1, status: 'failed', stepId: 'unsafe', title: 'Unsafe tool', toolCall: { arguments: {}, callId: 'call_unsafe', name: 'network.fetch' }, toolCallSha256: hash, verification: null, verificationSpec: { expectedExitCode: null, expectedOutputSha256: null, expectedStatus: 'ok', files: [] } }]
			}
		};
		assert.strictEqual(parsePlanView(value), undefined);
		value.plan.steps[0].toolCall.name = 'workspace.list_files';
		assert.strictEqual(parsePlanView(value)?.plan.status, 'failed');
	});

	test('does not force Electron Node mode for a standalone Node executable', async () => {
		const extensionPath = path.join(tmpdir(), `fikeya-desktop-node-sidecar-${process.pid}-${Date.now()}`);
		const sidecarDirectory = path.join(extensionPath, 'sidecar');
		await mkdir(sidecarDirectory, { recursive: true });
		await writeFile(path.join(sidecarDirectory, 'qarinah-memory-view.mjs'), 'fixture', 'utf8');

		assert.deepStrictEqual(buildFikeyaRuntimeEnvironment(extensionPath, 'node.exe', { PATH: 'fixed-path' }), {
			PATH: 'fixed-path',
			FIKEYA_NODE_EXECUTABLE: 'node.exe',
			FIKEYA_QARINAH_SIDECAR: path.join(sidecarDirectory, 'qarinah-memory-view.mjs')
		});
	});

	test('does not invent Qarinah sidecar configuration for source-only installs', () => {
		const parentEnvironment: NodeJS.ProcessEnv = { PATH: 'fixed-path' };
		const result = buildFikeyaRuntimeEnvironment(path.join(tmpdir(), 'missing-fikeya-extension'), 'node', parentEnvironment);
		assert.deepStrictEqual(result, { PATH: 'fixed-path' });
		assert.notStrictEqual(result, parentEnvironment);
	});

		test('parses completed turns and exact provider-reported usage', () => {
		const outcome = {
			changedFilesScope: 'regular-project-files-v1',
			changedFilesTruncated: false,
			changedFiles: [{
				afterSha256: `sha256:${'d'.repeat(64)}`,
				afterBytes: 640,
				afterExists: true,
				beforeSha256: `sha256:${'b'.repeat(64)}`,
				beforeBytes: 580,
				beforeExists: true,
				lineDeltaStatus: 'exact',
				linesAdded: 8,
				linesDeleted: 3,
				operation: 'edit',
				path: 'src/payment.ts'
			}, {
				afterSha256: null,
				afterBytes: null,
				afterExists: false,
				beforeSha256: `sha256:${'a'.repeat(64)}`,
				beforeBytes: 120,
				beforeExists: true,
				lineDeltaStatus: 'exact',
				linesAdded: 0,
				linesDeleted: 7,
				operation: 'delete',
				path: 'src/removed.ts'
			}],
			plan: 'Inspect, edit, and verify the focused behavior.',
			steps: 3,
			summary: 'Updated the focused behavior and its test passed.',
			tests: [{
				callId: 'tool_test',
				durationMs: 140,
				exitCode: 0,
				name: 'process.run',
				outputSha256: `sha256:${'e'.repeat(64)}`,
				status: 'ok',
				test: true
			}],
			toolCalls: [{
				callId: 'tool_test',
				durationMs: 140,
				exitCode: 0,
				name: 'process.run',
				outputSha256: `sha256:${'e'.repeat(64)}`,
				status: 'ok',
				test: true
			}]
		};
		assert.deepStrictEqual(parseAgentTurn({
			providerAttemptId: 'evt_attempt_0123456789abcdef',
			providerAttemptIds: ['evt_attempt_aaaaaaaaaaaaaaaa', 'evt_attempt_0123456789abcdef'],
			callId: 'call_0123456789abcdef',
			failure: null,
			ok: true,
			outcome,
			output: outcome.summary,
			providerCallIds: ['call_aaaaaaaaaaaaaaaa', 'call_0123456789abcdef'],
			sessionId: 'ses_0123456789abcdef',
			status: 'completed',
			type: 'result',
			usage: {
				cachedInputTokens: 32,
				inputTokens: 128,
				measurement: 'provider-reported',
				outputTokens: 64
			},
			memory: {
				coverage: 'direct',
				evidenceCount: 7,
				receiptId: 'ctx_0123456789abcdef0123456789abcdef',
				responseSha256: `sha256:${'c'.repeat(64)}`,
				status: 'used'
			}
		}), {
			providerAttemptId: 'evt_attempt_0123456789abcdef',
			providerAttemptIds: ['evt_attempt_aaaaaaaaaaaaaaaa', 'evt_attempt_0123456789abcdef'],
			providerAttemptMeasurement: 'exact',
			callId: 'call_0123456789abcdef',
			failure: null,
			outcome,
			output: outcome.summary,
			providerCallIds: ['call_aaaaaaaaaaaaaaaa', 'call_0123456789abcdef'],
			sessionId: 'ses_0123456789abcdef',
			status: 'completed',
			usage: {
				cachedInputTokens: 32,
				inputTokens: 128,
				measurement: 'provider-reported',
				outputTokens: 64
			},
			memory: {
				coverage: 'direct',
				evidenceCount: 7,
				receiptId: 'ctx_0123456789abcdef0123456789abcdef',
				responseSha256: `sha256:${'c'.repeat(64)}`,
				status: 'used'
			}
		});
	});

	test('parses deliberate memory-free turns without inventing context evidence', () => {
		const output = 'No project context was attached.';
		assert.deepStrictEqual(parseAgentTurn({
			providerAttemptId: 'evt_attempt_0123456789abcdef',
			providerAttemptIds: ['evt_attempt_0123456789abcdef'],
			callId: 'call_0123456789abcdef',
			failure: null,
			memory: {
				coverage: null,
				evidenceCount: null,
				receiptId: null,
				responseSha256: null,
				status: 'off'
			},
			ok: true,
			outcome: {
				changedFiles: [],
				plan: 'Answer without project context.',
				steps: 1,
				summary: output,
				tests: [],
				toolCalls: []
			},
			output,
			providerCallIds: ['call_0123456789abcdef'],
			sessionId: 'ses_0123456789abcdef',
			status: 'completed',
			type: 'result',
			usage: {
				cachedInputTokens: null,
				inputTokens: null,
				measurement: 'unavailable',
				outputTokens: null
			}
		})?.memory, {
			coverage: null,
			evidenceCount: null,
			receiptId: null,
			responseSha256: null,
			status: 'off'
		});
	});

	test('normalizes legacy runtime results without inventing failed provider attempts', () => {
		const current = agentResultRecord();
		const {
			providerAttemptId: _providerAttemptId,
			providerAttemptIds: _providerAttemptIds,
			...legacyCompleted
		} = current;
		const completed = parseAgentTurn(legacyCompleted);
		assert.strictEqual(completed?.providerAttemptMeasurement, 'legacy-minimum');
		assert.strictEqual(completed?.providerAttemptId, 'call_fixture');
		assert.deepStrictEqual(completed?.providerAttemptIds, ['call_fixture']);

		const output = 'Legacy runtime cancelled with unknown provider-attempt accounting.';
		const cancelled = parseAgentTurn({
			...legacyCompleted,
			callId: null,
			providerCallIds: [],
			ok: false,
			status: 'cancelled',
			output,
			outcome: {
				changedFiles: [], changedFilesTruncated: false, changedFilesScope: 'regular-project-files-v1',
				plan: '', steps: 1, summary: output, tests: [], toolCalls: []
			}
		});
		assert.strictEqual(cancelled?.providerAttemptMeasurement, 'unavailable');
		assert.strictEqual(cancelled?.providerAttemptId, null);
		assert.deepStrictEqual(cancelled?.providerAttemptIds, []);
	});

	test('parses only the explicit pre-provider cancellation shape without a call id', () => {
		const output = 'The run was cancelled before a reviewed answer was produced. Completed tool and changed-file evidence is retained below.';
		const cancelled = parseAgentTurn({
			...agentResultRecord(),
			providerAttemptId: null,
			providerAttemptIds: [],
			callId: null,
			ok: false,
			providerCallIds: [],
			status: 'cancelled',
			output,
			outcome: {
				changedFiles: [], changedFilesTruncated: false, changedFilesScope: 'regular-project-files-v1',
				plan: '', steps: 0, summary: output, tests: [], toolCalls: []
			}
		});
		assert.strictEqual(cancelled?.callId, null);
		assert.strictEqual(cancelled?.providerAttemptId, null);
		assert.deepStrictEqual(cancelled?.providerAttemptIds, []);
		assert.deepStrictEqual(cancelled?.providerCallIds, []);
		assert.strictEqual(parseAgentTurn({ ...cancelled, status: 'failed' }), undefined);
	});

	test('distinguishes a pending provider cancellation and initial failure from pre-provider cancellation', () => {
		const terminal = (status: 'cancelled' | 'failed') => {
			const output = status === 'cancelled'
				? 'The pending provider request was cancelled.'
				: 'The initial provider request failed.';
			return parseAgentTurn({
				...agentResultRecord(),
				providerAttemptId: 'evt_pending_provider_request',
				providerAttemptIds: ['evt_pending_provider_request'],
				callId: null,
				providerCallIds: [],
				ok: false,
				failure: status === 'failed'
					? { kind: 'connectivity', retryable: true, statusCode: null }
					: null,
				status,
				output,
				outcome: {
					changedFiles: [], changedFilesTruncated: false, changedFilesScope: 'regular-project-files-v1',
					plan: '', steps: 1, summary: output, tests: [], toolCalls: []
				}
			});
		};

		for (const status of ['cancelled', 'failed'] as const) {
			const turn = terminal(status);
			assert.strictEqual(turn?.status, status);
			assert.strictEqual(turn?.providerAttemptId, 'evt_pending_provider_request');
			assert.deepStrictEqual(turn?.providerAttemptIds, ['evt_pending_provider_request']);
			assert.strictEqual(turn?.callId, null);
			assert.deepStrictEqual(turn?.providerCallIds, []);
		}
		assert.strictEqual(parseAgentTurn({
			...agentResultRecord(),
			providerAttemptId: 'evt_unlisted',
			providerAttemptIds: [],
			callId: null,
			providerCallIds: [],
			ok: false,
			status: 'failed'
		}), undefined);
	});

	test('rejects duplicate and contradictory outcome aggregates', () => {
		const base = agentResultRecord();
		const tool = {
			callId: 'tool_test', durationMs: 12, exitCode: 0, name: 'process.run',
			outputSha256: `sha256:${'e'.repeat(64)}`, status: 'ok', test: true
		};
		const changedFile = {
			path: 'src/result.ts', operation: 'add', beforeSha256: null, afterSha256: `sha256:${'a'.repeat(64)}`,
			beforeBytes: null, afterBytes: 12, linesAdded: 1, linesDeleted: 0, lineDeltaStatus: 'exact'
		};
		const result = (outcome: Record<string, unknown>) => parseAgentTurn({ ...base, outcome });
		const common = {
			changedFiles: [changedFile], plan: 'Verify the result.', steps: 1,
			summary: 'Fixture complete.', tests: [tool], toolCalls: [tool]
		};
		assert.ok(result(common));
		assert.strictEqual(result({ ...common, toolCalls: [tool, tool] }), undefined);
		assert.strictEqual(result({ ...common, changedFiles: [changedFile, changedFile] }), undefined);
		assert.strictEqual(result({ ...common, tests: [] }), undefined);
		assert.strictEqual(result({ ...common, tests: [{ ...tool, status: 'error' }] }), undefined);
	});

	test('normalizes legacy changed-file receipts and rejects inconsistent line evidence', () => {
		const hash = `sha256:${'a'.repeat(64)}`;
		const legacy = parseAgentTurn({
			...agentResultRecord(),
			output: 'Created the file.',
			outcome: {
				changedFiles: [{ path: 'src/legacy.ts', beforeSha256: null, afterSha256: hash }],
				plan: 'Create the file.',
				steps: 1,
				summary: 'Created the file.',
				tests: [],
				toolCalls: []
			}
		});
		assert.deepStrictEqual(legacy?.outcome.changedFiles[0], {
			path: 'src/legacy.ts',
			operation: 'add',
			beforeExists: false,
			afterExists: true,
			beforeSha256: null,
			afterSha256: hash,
			beforeBytes: null,
			afterBytes: null,
			linesAdded: null,
			linesDeleted: null,
			lineDeltaStatus: 'unavailable'
		});
		const thresholdEdit = parseAgentTurn({
			...agentResultRecord(),
			output: 'Edited the file.',
			outcome: {
				changedFilesTruncated: true,
				changedFiles: [{
					path: 'src/threshold.bin', operation: 'edit', beforeSha256: null, afterSha256: hash,
					beforeBytes: 16_777_217, afterBytes: 1, linesAdded: null, linesDeleted: null, lineDeltaStatus: 'too-large'
				}],
				plan: 'Edit the file.',
				steps: 1,
				summary: 'Edited the file.',
				tests: [],
				toolCalls: []
			}
		});
		assert.strictEqual(thresholdEdit?.outcome.changedFiles[0]?.operation, 'edit');
		assert.strictEqual(thresholdEdit?.outcome.changedFiles[0]?.beforeBytes, 16_777_217);
		assert.strictEqual(thresholdEdit?.outcome.changedFilesTruncated, true);

		const sparseAdd = parseAgentTurn({
			...agentResultRecord(),
			output: 'Created an oversized sparse file.',
			outcome: {
				changedFilesTruncated: true,
				changedFiles: [{
					path: 'huge.bin', operation: 'add', beforeExists: false, afterExists: true,
					beforeSha256: null, afterSha256: null, beforeBytes: null, afterBytes: 1_000_000_001,
					linesAdded: null, linesDeleted: null, lineDeltaStatus: 'too-large'
				}],
				plan: 'Create the sparse file.',
				steps: 1,
				summary: 'Created an oversized sparse file.',
				tests: [],
				toolCalls: []
			}
		});
		assert.strictEqual(sparseAdd?.outcome.changedFiles[0]?.operation, 'add');
		assert.strictEqual(sparseAdd?.outcome.changedFiles[0]?.afterExists, true);
		const sparseEdit = parseAgentTurn({
			...agentResultRecord(),
			outcome: {
				changedFiles: [{
					path: 'huge.bin', operation: 'edit', beforeExists: true, afterExists: true,
					beforeSha256: null, afterSha256: null,
					beforeBytes: 1_000_000_001, afterBytes: 1_000_000_002,
					linesAdded: null, linesDeleted: null, lineDeltaStatus: 'too-large'
				}],
				plan: 'Resize the sparse file.', steps: 1, summary: 'Fixture complete.', tests: [], toolCalls: []
			}
		});
		assert.strictEqual(sparseEdit?.outcome.changedFiles[0]?.afterBytes, 1_000_000_002);

		assert.strictEqual(parseAgentTurn({
			...agentResultRecord(),
			output: 'Edited the file.',
			outcome: {
				changedFiles: [{
					path: 'src/invalid.ts', operation: 'edit', beforeSha256: hash, afterSha256: `sha256:${'b'.repeat(64)}`,
					beforeBytes: 10, afterBytes: 12, linesAdded: null, linesDeleted: null, lineDeltaStatus: 'exact'
				}],
				plan: 'Edit the file.',
				steps: 1,
				summary: 'Edited the file.',
				tests: [],
				toolCalls: []
			}
		}), undefined);

		const contradictoryFiles = [
			{ path: 'src/add-bytes.ts', operation: 'add', beforeSha256: null, afterSha256: hash, beforeBytes: 1, afterBytes: 2, linesAdded: 1, linesDeleted: 0, lineDeltaStatus: 'exact' },
			{ path: 'src/delete-bytes.ts', operation: 'delete', beforeSha256: hash, afterSha256: null, beforeBytes: 2, afterBytes: 1, linesAdded: 0, linesDeleted: 1, lineDeltaStatus: 'exact' },
			{ path: 'src/add-lines.ts', operation: 'add', beforeSha256: null, afterSha256: hash, beforeBytes: null, afterBytes: 2, linesAdded: 1, linesDeleted: 1, lineDeltaStatus: 'exact' },
			{ path: 'src/delete-lines.ts', operation: 'delete', beforeSha256: hash, afterSha256: null, beforeBytes: 2, afterBytes: null, linesAdded: 1, linesDeleted: 1, lineDeltaStatus: 'exact' },
			{ path: 'src/no-change.ts', operation: 'edit', beforeSha256: hash, afterSha256: hash, beforeBytes: 2, afterBytes: 2, linesAdded: 1, linesDeleted: 1, lineDeltaStatus: 'exact' }
		];
		for (const changedFile of contradictoryFiles) {
			assert.strictEqual(parseAgentTurn({
				...agentResultRecord(),
				output: 'Edited the file.',
				outcome: {
					changedFiles: [changedFile],
					plan: 'Edit the file.',
					steps: 1,
					summary: 'Edited the file.',
					tests: [],
					toolCalls: []
				}
			}), undefined);
		}
	});

	test('parses an exact one-use approval request and rejects malformed hashes', () => {
		const request = {
			arguments: { path: 'src/payment.ts' },
			argumentsSha256: 'a'.repeat(64),
			callId: 'tool_read',
			expectedRevision: 3,
			requestId: 'approval_read',
			sessionId: 'ses_0123456789abcdef',
			summary: 'Read src/payment.ts',
			toolName: 'workspace.read_file',
			type: 'approval'
		};
		assert.deepStrictEqual(parseAgentApproval(request), request);
		assert.strictEqual(parseAgentApproval({ ...request, argumentsSha256: 'not-a-hash' }), undefined);
	});

	test('parses content-free call receipts with provenance hashes', () => {
		const hashA = `sha256:${'a'.repeat(64)}`;
		const hashB = `sha256:${'b'.repeat(64)}`;
		assert.deepStrictEqual(parseAgentReceipts({
			ok: true,
			receipts: [{
				apiMode: 'responses',
				cachedInputTokens: 32,
				callId: 'call_0123456789abcdef',
				createdAt: '2026-08-24T10:00:00.000Z',
				durationMs: 412,
				inputTokens: 128,
				model: 'coding-deployment',
				outputTokens: 64,
				provider: 'azure-primary',
				requestBytes: 700,
				requestSha256: hashA,
				responseBytes: 900,
				responseSha256: hashB,
				statusCode: 200,
				usageMeasurement: 'provider-reported'
			}],
			sessionId: 'ses_0123456789abcdef'
		})?.[0], {
			apiMode: 'responses',
			cachedInputTokens: 32,
			callId: 'call_0123456789abcdef',
			createdAt: '2026-08-24T10:00:00.000Z',
			durationMs: 412,
			inputTokens: 128,
			model: 'coding-deployment',
			outputTokens: 64,
			provider: 'azure-primary',
			requestBytes: 700,
			requestSha256: hashA,
			responseBytes: 900,
			responseSha256: hashB,
			statusCode: 200,
			usageMeasurement: 'provider-reported'
		});
	});

	test('builds the content-free local statistics command without network flags', () => {
		assert.deepStrictEqual(buildStatisticsArguments('D:\\workspace'), [
			'stats',
			'--workspace',
			'D:\\workspace',
			'--json'
		]);
	});

	test('parses measured local statistics and provider-model breakdowns', () => {
		const value = {
			ok: true,
			source: 'local-runtime-sqlite',
			measurement: 'provider-reported-only',
			generatedAt: '2026-08-25T07:30:00.000Z',
			sessions: 3,
			providerCalls: 4,
			measuredProviderCalls: 3,
			inputTokens: 1_024,
			cachedInputTokens: 256,
			outputTokens: 512,
			qarinahContextReceipts: 2,
			lastActivity: '2026-08-25T07:29:00.000Z',
			matchedComparison: {
				status: 'matched',
				pairCount: 2,
				baselineBilledTokens: 1_000,
				fikeyaBilledTokens: 600,
				baselineVerifiedSolveRate: 1,
				fikeyaVerifiedSolveRate: 1,
				billedTokenReductionPercent: 40,
				reportSha256: `sha256:${'a'.repeat(64)}`
			},
			breakdown: [{
				provider: 'azure-primary',
				model: 'gpt-coding',
				calls: 4,
				measuredCalls: 3,
				inputTokens: 1_024,
				cachedInputTokens: 256,
				outputTokens: 512,
				lastActivity: '2026-08-25T07:29:00.000Z'
			}]
		};
		assert.deepStrictEqual(parseStatistics(value), {
			source: value.source,
			measurement: value.measurement,
			generatedAt: value.generatedAt,
			sessions: value.sessions,
			providerCalls: value.providerCalls,
			measuredProviderCalls: value.measuredProviderCalls,
			inputTokens: value.inputTokens,
			cachedInputTokens: value.cachedInputTokens,
			outputTokens: value.outputTokens,
			qarinahContextReceipts: value.qarinahContextReceipts,
			lastActivity: value.lastActivity,
			breakdown: value.breakdown,
			matchedComparison: value.matchedComparison
		});
	});

	test('accepts an honest unavailable-measurement snapshot and rejects inconsistent totals', () => {
		const unavailable = {
			ok: true,
			source: 'local-runtime-sqlite',
			measurement: 'unavailable',
			generatedAt: '2026-08-25T07:30:00+00:00',
			sessions: 1,
			providerCalls: 1,
			measuredProviderCalls: 0,
			inputTokens: null,
			cachedInputTokens: null,
			outputTokens: null,
			qarinahContextReceipts: 0,
			lastActivity: null,
			matchedComparison: null,
			breakdown: [{
				provider: 'local',
				model: 'unknown',
				calls: 1,
				measuredCalls: 0,
				inputTokens: null,
				cachedInputTokens: null,
				outputTokens: null,
				lastActivity: null
			}]
		};
		assert.ok(parseStatistics(unavailable));
		assert.strictEqual(parseStatistics({ ...unavailable, inputTokens: 0 }), undefined);
		assert.strictEqual(parseStatistics({ ...unavailable, measuredProviderCalls: 1 }), undefined);
		assert.strictEqual(parseStatistics({ ...unavailable, generatedAt: 'not-a-date' }), undefined);
		assert.strictEqual(parseStatistics({ ...unavailable, matchedComparison: { status: 'matched' } }), undefined);
	});

	test('rejects provider metadata and probes outside the bounded schema', () => {
		assert.strictEqual(parseProviderList({ ok: true, providers: [{ name: '../escape' }] }), undefined);
		assert.strictEqual(parseProviderProbe({ ok: true, name: 'provider', statusCode: 200, latencyMs: -1 }), undefined);
	});
});
