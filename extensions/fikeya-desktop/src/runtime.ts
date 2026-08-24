/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';

const maximumOutputBytes = 1024 * 1024;
const maximumAgentOutputBytes = 5 * 1024 * 1024;
const runtimeTimeoutMilliseconds = 30_000;
const agentTimeoutMilliseconds = 65_000;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type FikeyaRuntimeFailure = 'none' | 'not-found' | 'timeout' | 'output-limit' | 'runtime-error' | 'invalid-json' | 'cancelled';

export type FikeyaRuntimeCommand = 'doctor' | 'init';

export interface FikeyaRuntimeResult {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly report?: FikeyaRuntimeReport;
	readonly failure: FikeyaRuntimeFailure;
}

export interface FikeyaRuntimeReport {
	readonly status?: string;
	readonly initialized?: boolean;
	readonly workspaceId?: string;
	readonly qarinah?: string;
	readonly providerCount?: number;
	readonly providerName?: string;
	readonly secretConfigured?: boolean;
}

export interface FikeyaProviderConfiguration {
	readonly name: string;
	readonly kind: 'azure-openai' | 'openai' | 'anthropic' | 'openrouter' | 'nvidia-nim' | 'ollama' | 'openai-compatible';
	readonly model: string;
	readonly baseUrl: string;
	readonly credentialType: 'api-key' | 'bearer' | 'entra-id' | 'none';
}

export interface FikeyaProviderProfile {
	readonly name: string;
	readonly kind: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly credentialType: string;
	readonly secretConfigured: boolean;
}

export interface FikeyaProviderProbe {
	readonly name: string;
	readonly statusCode: number;
	readonly latencyMs: number;
}

export interface FikeyaAgentUsage {
	readonly measurement: 'provider-reported' | 'unavailable';
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cachedInputTokens: number | null;
}

export interface FikeyaAgentTurn {
	readonly sessionId: string;
	readonly callId: string;
	readonly output: string;
	readonly usage: FikeyaAgentUsage;
}

export interface FikeyaProviderReceipt {
	readonly apiMode: string;
	readonly cachedInputTokens: number | null;
	readonly callId: string;
	readonly createdAt: string;
	readonly durationMs: number;
	readonly inputTokens: number | null;
	readonly model: string;
	readonly outputTokens: number | null;
	readonly provider: string;
	readonly requestBytes: number;
	readonly requestSha256: string;
	readonly responseBytes: number;
	readonly responseSha256: string;
	readonly statusCode: number;
	readonly usageMeasurement: 'provider-reported' | 'unavailable';
}

export interface FikeyaCliResult<T> {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly value?: T;
	readonly failure: FikeyaRuntimeFailure;
}

export interface FikeyaAgentRunHandle {
	readonly result: Promise<FikeyaCliResult<FikeyaAgentTurn>>;
	cancel(): void;
}

/** Runs a bounded Fikeya workspace command with no shell interpolation. */
export async function runFikeyaRuntime(command: FikeyaRuntimeCommand, workspacePath: string): Promise<FikeyaRuntimeResult> {
	return runFikeyaCli([command, '--json'], workspacePath, value => parseRuntimeReport(value, command));
}

/**
 * Configures a provider through the runtime. Credential bytes cross the process boundary only
 * through stdin: they never appear in process arguments, output, persisted metadata, or logs.
 */
export async function configureFikeyaProvider(configuration: FikeyaProviderConfiguration, workspacePath: string, secret?: string): Promise<FikeyaRuntimeResult> {
	const hasSecret = typeof secret === 'string' && secret.length > 0;
	return runFikeyaCli(
		buildProviderConfigureArguments(configuration, hasSecret),
		workspacePath,
		value => parseProviderReport(value),
		hasSecret ? secret : undefined
	);
}

/** Lists the exact profiles currently known to Fikeya Runtime. */
export async function listFikeyaProviders(workspacePath: string): Promise<FikeyaCliResult<readonly FikeyaProviderProfile[]>> {
	return runBoundedJsonCli(['provider', 'list', '--json'], workspacePath, parseProviderList);
}

/** Runs one explicitly authorized, content-free provider connectivity probe. */
export async function testFikeyaProvider(providerName: string, workspacePath: string): Promise<FikeyaCliResult<FikeyaProviderProbe>> {
	if (!identifierPattern.test(providerName)) {
		return invalidLocalRequest();
	}
	return runBoundedJsonCli(['provider', 'test', providerName, '--allow-network', '--json'], workspacePath, parseProviderProbe);
}

/** Removes one profile and its runtime-owned credential reference. */
export async function removeFikeyaProvider(providerName: string, workspacePath: string): Promise<FikeyaCliResult<{ readonly name: string; readonly removed: boolean }>> {
	if (!identifierPattern.test(providerName)) {
		return invalidLocalRequest();
	}
	return runBoundedJsonCli(['provider', 'remove', providerName, '--json'], workspacePath, parseProviderRemoval);
}

/** Starts one real provider turn. Prompt content is written to stdin and never placed in argv. */
export function startFikeyaAgentRun(
	providerName: string,
	prompt: string,
	maxOutputTokens: number,
	workspacePath: string
): FikeyaAgentRunHandle {
	if (!identifierPattern.test(providerName)
		|| !prompt.trim()
		|| Buffer.byteLength(prompt, 'utf8') > 262_144
		|| !Number.isSafeInteger(maxOutputTokens)
		|| maxOutputTokens < 1
		|| maxOutputTokens > 32_768) {
		return {
			result: Promise.resolve(invalidLocalRequest()),
			cancel: () => undefined
		};
	}

	const operation = startBoundedJsonCli(
		buildAgentRunArguments(providerName, maxOutputTokens),
		workspacePath,
		parseAgentTurn,
		prompt,
		agentTimeoutMilliseconds,
		maximumAgentOutputBytes
	);
	return { result: operation.result, cancel: operation.cancel };
}

/** Reloads the durable, content-free provider call receipts for one completed session. */
export async function loadFikeyaAgentReceipts(sessionId: string, workspacePath: string): Promise<FikeyaCliResult<readonly FikeyaProviderReceipt[]>> {
	if (!identifierPattern.test(sessionId)) {
		return invalidLocalRequest();
	}
	return runBoundedJsonCli(['agent', 'receipts', sessionId, '--workspace', '.', '--json'], workspacePath, parseAgentReceipts);
}

/** Builds the public argument vector. Prompt content is deliberately absent. */
export function buildAgentRunArguments(providerName: string, maxOutputTokens: number): readonly string[] {
	return [
		'agent',
		'run',
		'.',
		'--provider',
		providerName,
		'--prompt-stdin',
		'--allow-network',
		'--max-output-tokens',
		String(maxOutputTokens),
		'--json'
	];
}

/** Builds the public, non-secret CLI argument vector for one provider profile. */
export function buildProviderConfigureArguments(configuration: FikeyaProviderConfiguration, hasSecret: boolean): readonly string[] {
	const args = [
		'provider',
		'configure',
		configuration.name,
		'--kind',
		configuration.kind,
		'--model',
		configuration.model,
		'--base-url',
		configuration.baseUrl,
		'--credential-type',
		configuration.credentialType
	];
	if (hasSecret) {
		args.push('--secret-stdin');
	}
	args.push('--json');
	return args;
}

export function parseProviderList(value: unknown): readonly FikeyaProviderProfile[] | undefined {
	const record = asRecord(value);
	if (!record || record.ok !== true || !Array.isArray(record.providers) || record.providers.length > 128) {
		return undefined;
	}
	const providers: FikeyaProviderProfile[] = [];
	for (const candidate of record.providers) {
		const provider = asRecord(candidate);
		const name = boundedString(provider?.name, 128);
		const kind = boundedString(provider?.kind, 80);
		const model = boundedString(provider?.model, 160);
		const baseUrl = boundedString(provider?.baseUrl, 2048);
		const credentialType = boundedString(provider?.credentialType, 40);
		if (!provider || !name || !identifierPattern.test(name) || !kind || !model || baseUrl === undefined || !credentialType || typeof provider.secretConfigured !== 'boolean') {
			return undefined;
		}
		providers.push({ name, kind, model, baseUrl, credentialType, secretConfigured: provider.secretConfigured });
	}
	return providers;
}

export function parseProviderProbe(value: unknown): FikeyaProviderProbe | undefined {
	const record = asRecord(value);
	const name = boundedString(record?.name, 128);
	if (!record || record.ok !== true || !name || !identifierPattern.test(name)
		|| !isBoundedInteger(record.statusCode, 100, 599)
		|| !isBoundedInteger(record.latencyMs, 0, 3_600_000)) {
		return undefined;
	}
	return { name, statusCode: record.statusCode, latencyMs: record.latencyMs };
}

export function parseProviderRemoval(value: unknown): { readonly name: string; readonly removed: boolean } | undefined {
	const record = asRecord(value);
	const name = boundedString(record?.name, 128);
	if (!record || record.ok !== true || !name || !identifierPattern.test(name) || typeof record.removed !== 'boolean') {
		return undefined;
	}
	return { name, removed: record.removed };
}

export function parseAgentTurn(value: unknown): FikeyaAgentTurn | undefined {
	const record = asRecord(value);
	const usage = asRecord(record?.usage);
	const sessionId = boundedString(record?.sessionId, 128);
	const callId = boundedString(record?.callId, 128);
	const output = strictBoundedString(record?.output, 4_194_304);
	const measurement = usage?.measurement;
	if (!record || record.ok !== true || !sessionId || !identifierPattern.test(sessionId)
		|| !callId || !identifierPattern.test(callId) || output === undefined
		|| (measurement !== 'provider-reported' && measurement !== 'unavailable')) {
		return undefined;
	}
	const inputTokens = nullableBoundedInteger(usage?.inputTokens);
	const outputTokens = nullableBoundedInteger(usage?.outputTokens);
	const cachedInputTokens = nullableBoundedInteger(usage?.cachedInputTokens);
	if (inputTokens === undefined || outputTokens === undefined || cachedInputTokens === undefined) {
		return undefined;
	}
	if (measurement === 'provider-reported' && (inputTokens === null || outputTokens === null || cachedInputTokens === null)) {
		return undefined;
	}
	if (measurement === 'unavailable' && (inputTokens !== null || outputTokens !== null || cachedInputTokens !== null)) {
		return undefined;
	}
	return {
		sessionId,
		callId,
		output,
		usage: { measurement, inputTokens, outputTokens, cachedInputTokens }
	};
}

export function parseAgentReceipts(value: unknown): readonly FikeyaProviderReceipt[] | undefined {
	const record = asRecord(value);
	if (!record || record.ok !== true || !Array.isArray(record.receipts) || record.receipts.length > 64) {
		return undefined;
	}
	const receipts: FikeyaProviderReceipt[] = [];
	for (const candidate of record.receipts) {
		const receipt = parseProviderReceipt(candidate);
		if (!receipt) {
			return undefined;
		}
		receipts.push(receipt);
	}
	return receipts;
}

function parseProviderReceipt(value: unknown): FikeyaProviderReceipt | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	const apiMode = boundedString(record.apiMode, 40);
	const callId = boundedString(record.callId, 128);
	const createdAt = boundedString(record.createdAt, 80);
	const model = boundedString(record.model, 160);
	const provider = boundedString(record.provider, 128);
	const requestSha256 = boundedString(record.requestSha256, 71);
	const responseSha256 = boundedString(record.responseSha256, 71);
	const usageMeasurement = record.usageMeasurement;
	const inputTokens = nullableBoundedInteger(record.inputTokens);
	const outputTokens = nullableBoundedInteger(record.outputTokens);
	const cachedInputTokens = nullableBoundedInteger(record.cachedInputTokens);
	if (!apiMode || !callId || !identifierPattern.test(callId) || !createdAt || !model || !provider
		|| !requestSha256 || !/^sha256:[0-9a-f]{64}$/.test(requestSha256)
		|| !responseSha256 || !/^sha256:[0-9a-f]{64}$/.test(responseSha256)
		|| (usageMeasurement !== 'provider-reported' && usageMeasurement !== 'unavailable')
		|| inputTokens === undefined || outputTokens === undefined || cachedInputTokens === undefined
		|| !isBoundedInteger(record.requestBytes, 0, 16_777_216)
		|| !isBoundedInteger(record.responseBytes, 0, 16_777_216)
		|| !isBoundedInteger(record.statusCode, 100, 599)
		|| !isBoundedInteger(record.durationMs, 0, 86_400_000)) {
		return undefined;
	}
	if (usageMeasurement === 'provider-reported' && (inputTokens === null || outputTokens === null || cachedInputTokens === null)) {
		return undefined;
	}
	if (usageMeasurement === 'unavailable' && (inputTokens !== null || outputTokens !== null || cachedInputTokens !== null)) {
		return undefined;
	}
	return {
		apiMode,
		cachedInputTokens,
		callId,
		createdAt,
		durationMs: record.durationMs,
		inputTokens,
		model,
		outputTokens,
		provider,
		requestBytes: record.requestBytes,
		requestSha256,
		responseBytes: record.responseBytes,
		responseSha256,
		statusCode: record.statusCode,
		usageMeasurement
	};
}

/** Parses the two versioned JSON shapes emitted by `fikeya init` and `fikeya doctor`. */
export function parseRuntimeReport(value: unknown, command: FikeyaRuntimeCommand): FikeyaRuntimeReport {
	const record = asRecord(value);
	if (!record) {
		return {};
	}

	if (command === 'init') {
		if (typeof record.ok !== 'boolean') {
			return {};
		}
		const workspaceId = boundedString(record.workspaceId, 200);
		const initialized = record.ok === true && workspaceId !== undefined;
		return {
			status: initialized ? 'initialized' : undefined,
			initialized,
			workspaceId
		};
	}

	if (typeof record.ok !== 'boolean' || !Array.isArray(record.checks)) {
		return {};
	}
	const checks = record.checks.map(asRecord).filter((check): check is Record<string, unknown> => check !== undefined);
	const workspace = findCheck(checks, 'workspace');
	const qarinah = findCheck(checks, 'qarinah');
	const providers = findCheck(checks, 'provider-metadata');
	return {
		status: record.ok === true ? 'ready' : 'attention',
		initialized: workspace?.ok === true,
		workspaceId: boundedString(workspace?.detail, 200),
		qarinah: boundedString(qarinah?.detail, 120),
		providerCount: parseProviderCount(providers?.detail)
	};
}

function parseProviderReport(value: unknown): FikeyaRuntimeReport {
	const record = asRecord(value);
	if (!record || record.ok !== true) {
		return {};
	}
	return {
		status: 'configured',
		providerName: boundedString(record.name, 128),
		secretConfigured: typeof record.secretConfigured === 'boolean' ? record.secretConfigured : undefined
	};
}

function runFikeyaCli(
	args: readonly string[],
	workspacePath: string,
	parseReport: (value: unknown) => FikeyaRuntimeReport,
	stdinSecret?: string
): Promise<FikeyaRuntimeResult> {
	return new Promise(resolve => {
		const child = spawn('fikeya', args, {
			cwd: workspacePath,
			shell: false,
			stdio: [stdinSecret === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			windowsHide: true
		});
		let output = '';
		let outputBytes = 0;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const finish = (result: FikeyaRuntimeResult): void => {
			if (!settled) {
				settled = true;
				if (timeout) {
					clearTimeout(timeout);
				}
				resolve(result);
			}
		};

		const capture = (chunk: Buffer, retain: boolean): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maximumOutputBytes) {
				child.kill();
				finish({ ok: false, exitCode: null, failure: 'output-limit' });
				return;
			}
			if (retain) {
				output += chunk.toString('utf8');
			}
		};

		if (!child.stdout || !child.stderr) {
			child.kill();
			finish({ ok: false, exitCode: null, failure: 'runtime-error' });
			return;
		}
		child.stdout.on('data', chunk => capture(chunk as Buffer, true));
		child.stderr.on('data', chunk => capture(chunk as Buffer, false));
		child.on('error', error => {
			finish({
				ok: false,
				exitCode: null,
				failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'runtime-error'
			});
		});
		child.on('close', exitCode => {
			if (exitCode !== 0) {
				finish({ ok: false, exitCode, failure: 'runtime-error' });
				return;
			}

			try {
				const report = parseReport(JSON.parse(output));
				if (!report.status) {
					throw new Error('Fikeya CLI response did not match the expected schema.');
				}
				finish({ ok: true, exitCode, report, failure: 'none' });
			} catch {
				finish({ ok: false, exitCode, failure: 'invalid-json' });
			}
		});

		if (stdinSecret !== undefined && child.stdin) {
			child.stdin.end(stdinSecret, 'utf8');
		}

		timeout = setTimeout(() => {
			child.kill();
			finish({ ok: false, exitCode: null, failure: 'timeout' });
		}, runtimeTimeoutMilliseconds);
	});
}

function runBoundedJsonCli<T>(
	args: readonly string[],
	workspacePath: string,
	parser: (value: unknown) => T | undefined
): Promise<FikeyaCliResult<T>> {
	return startBoundedJsonCli(args, workspacePath, parser).result;
}

function startBoundedJsonCli<T>(
	args: readonly string[],
	workspacePath: string,
	parser: (value: unknown) => T | undefined,
	stdinPayload?: string,
	timeoutMilliseconds = runtimeTimeoutMilliseconds,
	outputLimitBytes = maximumOutputBytes
): { readonly result: Promise<FikeyaCliResult<T>>; cancel(): void } {
	let cancelOperation = (): void => undefined;
	const result = new Promise<FikeyaCliResult<T>>(resolve => {
		const child = spawn('fikeya', args, {
			cwd: workspacePath,
			shell: false,
			stdio: [stdinPayload === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			windowsHide: true
		});
		let output = '';
		let outputBytes = 0;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const finish = (operationResult: FikeyaCliResult<T>): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			resolve(operationResult);
		};

		cancelOperation = (): void => {
			if (settled) {
				return;
			}
			child.kill();
			finish({ ok: false, exitCode: null, failure: 'cancelled' });
		};

		const capture = (chunk: Buffer, retain: boolean): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > outputLimitBytes) {
				child.kill();
				finish({ ok: false, exitCode: null, failure: 'output-limit' });
				return;
			}
			if (retain) {
				output += chunk.toString('utf8');
			}
		};

		if (!child.stdout || !child.stderr) {
			child.kill();
			finish({ ok: false, exitCode: null, failure: 'runtime-error' });
			return;
		}
		child.stdout.on('data', chunk => capture(chunk as Buffer, true));
		child.stderr.on('data', chunk => capture(chunk as Buffer, false));
		child.on('error', error => {
			finish({
				ok: false,
				exitCode: null,
				failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'runtime-error'
			});
		});
		child.on('close', exitCode => {
			if (exitCode !== 0) {
				finish({ ok: false, exitCode, failure: 'runtime-error' });
				return;
			}
			try {
				const parsed = parser(JSON.parse(output));
				if (parsed === undefined) {
					throw new Error('Fikeya CLI response did not match the expected schema.');
				}
				finish({ ok: true, exitCode, value: parsed, failure: 'none' });
			} catch {
				finish({ ok: false, exitCode, failure: 'invalid-json' });
			}
		});

		if (stdinPayload !== undefined && child.stdin) {
			child.stdin.end(stdinPayload, 'utf8');
		}

		timeout = setTimeout(() => {
			child.kill();
			finish({ ok: false, exitCode: null, failure: 'timeout' });
		}, timeoutMilliseconds);
	});
	return { result, cancel: () => cancelOperation() };
}

function invalidLocalRequest<T>(): FikeyaCliResult<T> {
	return { ok: false, exitCode: null, failure: 'runtime-error' };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
	return typeof value === 'string' ? value.slice(0, maximumLength) : undefined;
}

function strictBoundedString(value: unknown, maximumLength: number): string | undefined {
	return typeof value === 'string' && value.length <= maximumLength ? value : undefined;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function nullableBoundedInteger(value: unknown): number | null | undefined {
	if (value === null) {
		return null;
	}
	return isBoundedInteger(value, 0, 1_000_000_000) ? value : undefined;
}

function findCheck(checks: readonly Record<string, unknown>[], name: string): Record<string, unknown> | undefined {
	return checks.find(check => check.name === name);
}

function parseProviderCount(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const match = /^(\d+) configured$/.exec(value);
	if (!match) {
		return undefined;
	}
	const count = Number(match[1]);
	return Number.isSafeInteger(count) ? count : undefined;
}
