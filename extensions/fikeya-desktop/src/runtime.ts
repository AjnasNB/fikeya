/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'child_process';
import { TextDecoder } from 'node:util';

const maximumOutputBytes = 1024 * 1024;
const maximumAgentOutputBytes = 5 * 1024 * 1024;
const runtimeTimeoutMilliseconds = 30_000;
const agentTimeoutMilliseconds = 15 * 60_000;
const maximumProtocolLineBytes = 1024 * 1024;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const contextReceiptPattern = /^ctx_[0-9a-f]{32}$/;

export type FikeyaRuntimeFailure = 'none' | 'not-found' | 'timeout' | 'output-limit' | 'runtime-error' | 'provider-error' | 'authentication' | 'quota' | 'invalid-json' | 'cancelled';

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
	readonly kind: 'azure-openai' | 'openai' | 'anthropic' | 'openrouter' | 'nvidia-nim' | 'google-gemini' | 'hugging-face' | 'groq' | 'ollama' | 'openai-compatible';
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

export type FikeyaMemoryMode = 'auto' | 'off' | 'required';

export interface FikeyaAgentMemory {
	readonly status: 'off' | 'unavailable' | 'used';
	readonly coverage: string | null;
	readonly evidenceCount: number | null;
	readonly receiptId: string | null;
	readonly responseSha256: string | null;
}

export type FikeyaAgentApprovalDecision = 'allow_once' | 'deny_once' | 'cancel';

export interface FikeyaAgentApproval {
	readonly type: 'approval';
	readonly requestId: string;
	readonly sessionId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly argumentsSha256: string;
	readonly expectedRevision: number;
	readonly summary: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

export interface FikeyaToolOutcome {
	readonly callId: string;
	readonly name: string;
	readonly status: 'ok' | 'error';
	readonly outputSha256: string;
	readonly durationMs: number | null;
	readonly exitCode: number | null;
	readonly test: boolean;
}

export interface FikeyaChangedFileOutcome {
	readonly path: string;
	readonly beforeSha256: string | null;
	readonly afterSha256: string;
}

export interface FikeyaCodingOutcome {
	readonly plan: string;
	readonly summary: string;
	readonly steps: number;
	readonly toolCalls: readonly FikeyaToolOutcome[];
	readonly tests: readonly FikeyaToolOutcome[];
	readonly changedFiles: readonly FikeyaChangedFileOutcome[];
}

export interface FikeyaAgentTurn {
	readonly sessionId: string;
	readonly callId: string;
	readonly providerCallIds: readonly string[];
	readonly status: 'completed' | 'cancelled' | 'failed';
	readonly output: string;
	readonly usage: FikeyaAgentUsage;
	readonly memory: FikeyaAgentMemory;
	readonly outcome: FikeyaCodingOutcome;
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

export interface FikeyaStatisticsBreakdown {
	readonly provider: string;
	readonly model: string;
	readonly calls: number;
	readonly measuredCalls: number;
	readonly inputTokens: number | null;
	readonly cachedInputTokens: number | null;
	readonly outputTokens: number | null;
	readonly lastActivity: string | null;
}

/** Content-free aggregate metrics read from the local Fikeya Runtime SQLite database. */
export interface FikeyaStatistics {
	readonly source: 'local-runtime-sqlite';
	readonly measurement: 'provider-reported-only' | 'unavailable';
	readonly generatedAt: string;
	readonly sessions: number;
	readonly providerCalls: number;
	readonly measuredProviderCalls: number;
	readonly inputTokens: number | null;
	readonly cachedInputTokens: number | null;
	readonly outputTokens: number | null;
	readonly qarinahContextReceipts: number;
	readonly lastActivity: string | null;
	readonly breakdown: readonly FikeyaStatisticsBreakdown[];
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

export interface FikeyaCliInvocation {
	readonly executable: string;
	readonly source: 'bundled' | 'path';
}

/**
 * Resolves the extension-owned runtime before considering PATH. Packaged builds always include
 * this platform-specific executable, while the PATH fallback keeps source checkouts usable.
 */
export function resolveFikeyaCli(extensionPath = path.resolve(__dirname, '..'), platform = process.platform): FikeyaCliInvocation {
	const executable = path.resolve(extensionPath, 'runtime', platform === 'win32' ? 'fikeya-runtime.exe' : 'fikeya-runtime');
	if (existsSync(executable)) {
		return { executable, source: 'bundled' };
	}
	return { executable: 'fikeya', source: 'path' };
}

export type FikeyaAgentApprovalHandler = (request: FikeyaAgentApproval) => Promise<FikeyaAgentApprovalDecision>;

/**
 * Connects the packaged Python runtime to the exact Qarinah sidecar shipped with this extension.
 * The values remain process-local and contain no credential or workspace content.
 */
export function buildFikeyaRuntimeEnvironment(
	extensionPath = path.resolve(__dirname, '..'),
	nodeExecutable = process.execPath,
	environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	const result = { ...environment };
	const sidecar = path.resolve(extensionPath, 'sidecar', 'qarinah-memory-view.mjs');
	if (existsSync(sidecar)) {
		result.FIKEYA_NODE_EXECUTABLE = nodeExecutable;
		result.FIKEYA_QARINAH_SIDECAR = sidecar;
	}
	return result;
}

/** Runs a bounded Fikeya workspace command with no shell interpolation. */
export async function runFikeyaRuntime(
	command: FikeyaRuntimeCommand,
	workspacePath: string,
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment()
): Promise<FikeyaRuntimeResult> {
	return runFikeyaCli([command, '--json'], workspacePath, value => parseRuntimeReport(value, command), undefined, invocation, environment);
}

/**
 * Configures a provider through the runtime. Credential bytes cross the process boundary only
 * through stdin: they never appear in process arguments, output, persisted metadata, or logs.
 */
export async function configureFikeyaProvider(
	configuration: FikeyaProviderConfiguration,
	workspacePath: string,
	secret?: string,
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment()
): Promise<FikeyaRuntimeResult> {
	const hasSecret = typeof secret === 'string' && secret.length > 0;
	return runFikeyaCli(
		buildProviderConfigureArguments(configuration, hasSecret),
		workspacePath,
		value => parseProviderReport(value),
		hasSecret ? secret : undefined,
		invocation,
		environment
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

/** Starts one reviewed coding loop. Prompt and approval content cross only the private stdin protocol. */
export function startFikeyaAgentRun(
	providerName: string,
	prompt: string,
	maxOutputTokens: number,
	contextMaxCharacters: number,
	memoryMode: FikeyaMemoryMode,
	workspacePath: string,
	approvalHandler: FikeyaAgentApprovalHandler,
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment()
): FikeyaAgentRunHandle {
	if (!identifierPattern.test(providerName)
		|| !prompt.trim()
		|| Buffer.byteLength(prompt, 'utf8') > 262_144
		|| !Number.isSafeInteger(maxOutputTokens)
		|| maxOutputTokens < 1
		|| maxOutputTokens > 32_768
		|| !Number.isSafeInteger(contextMaxCharacters)
		|| contextMaxCharacters < 512
		|| contextMaxCharacters > 64_000
		|| !['auto', 'off', 'required'].includes(memoryMode)) {
		return {
			result: Promise.resolve(invalidLocalRequest()),
			cancel: () => undefined
		};
	}

	const operation = startAgentProtocolCli(
		buildAgentRunArguments(providerName, maxOutputTokens, contextMaxCharacters, memoryMode),
		workspacePath,
		prompt,
		approvalHandler,
		agentTimeoutMilliseconds,
		maximumAgentOutputBytes,
		invocation,
		environment
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

/** Reads content-free, measured-only aggregate statistics from the local runtime database. */
export async function loadFikeyaStatistics(workspacePath: string): Promise<FikeyaCliResult<FikeyaStatistics>> {
	return runBoundedJsonCli(buildStatisticsArguments(workspacePath), workspacePath, parseStatistics);
}

export function buildStatisticsArguments(workspacePath: string): readonly string[] {
	return ['stats', '--workspace', workspacePath, '--json'];
}

/** Builds the public argument vector. Prompt content is deliberately absent. */
export function buildAgentRunArguments(
	providerName: string,
	maxOutputTokens: number,
	contextMaxCharacters: number,
	memoryMode: FikeyaMemoryMode
): readonly string[] {
	return [
		'agent',
		'execute',
		'.',
		'--provider',
		providerName,
		'--protocol-stdin',
		'--allow-network',
		'--max-output-tokens',
		String(maxOutputTokens),
		'--context-max-characters',
		String(contextMaxCharacters),
		'--memory',
		memoryMode,
		'--json-lines'
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
	const memory = asRecord(record?.memory);
	const outcomeRecord = asRecord(record?.outcome);
	const sessionId = strictBoundedString(record?.sessionId, 128);
	const callId = strictBoundedString(record?.callId, 128);
	const output = strictBoundedString(record?.output, 4_194_304);
	const measurement = usage?.measurement;
	const memoryStatus = memory?.status;
	const status = record?.status;
	if (!record || record.type !== 'result'
		|| (status !== 'completed' && status !== 'cancelled' && status !== 'failed')
		|| record.ok !== (status === 'completed')
		|| !sessionId || !identifierPattern.test(sessionId)
		|| !callId || !identifierPattern.test(callId) || output === undefined
		|| (measurement !== 'provider-reported' && measurement !== 'unavailable')
		|| (memoryStatus !== 'off' && memoryStatus !== 'unavailable' && memoryStatus !== 'used')
		|| !Array.isArray(record.providerCallIds) || record.providerCallIds.length < 1 || record.providerCallIds.length > 128
		|| !outcomeRecord) {
		return undefined;
	}
	const providerCallIds = record.providerCallIds.map(candidate => strictBoundedString(candidate, 128));
	if (providerCallIds.some(candidate => !candidate || !identifierPattern.test(candidate))
		|| providerCallIds.at(-1) !== callId) {
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
	const coverage = nullableBoundedString(memory?.coverage, 40);
	const evidenceCount = nullableBoundedInteger(memory?.evidenceCount);
	const receiptId = nullableBoundedString(memory?.receiptId, 128);
	const responseSha256 = nullableBoundedString(memory?.responseSha256, 71);
	if (coverage === undefined || evidenceCount === undefined || receiptId === undefined || responseSha256 === undefined) {
		return undefined;
	}
	if (memoryStatus === 'used') {
		if (!coverage || evidenceCount === null || !receiptId || !contextReceiptPattern.test(receiptId)
			|| !responseSha256 || !/^sha256:[0-9a-f]{64}$/.test(responseSha256)) {
			return undefined;
		}
	} else if (coverage !== null || evidenceCount !== null || receiptId !== null || responseSha256 !== null) {
		return undefined;
	}
	const outcome = parseCodingOutcome(outcomeRecord);
	if (!outcome || outcome.summary !== output) {
		return undefined;
	}
	return {
		sessionId,
		callId,
		providerCallIds: providerCallIds as string[],
		status,
		output,
		usage: { measurement, inputTokens, outputTokens, cachedInputTokens },
		memory: { status: memoryStatus, coverage, evidenceCount, receiptId, responseSha256 },
		outcome
	};
}

export function parseAgentApproval(value: unknown): FikeyaAgentApproval | undefined {
	const record = asRecord(value);
	const requestId = strictBoundedString(record?.requestId, 128);
	const sessionId = strictBoundedString(record?.sessionId, 128);
	const callId = strictBoundedString(record?.callId, 128);
	const toolName = strictBoundedString(record?.toolName, 128);
	const argumentsSha256 = strictBoundedString(record?.argumentsSha256, 64);
	const summary = strictBoundedString(record?.summary, 4_096);
	const args = asRecord(record?.arguments);
	if (!record || record.type !== 'approval'
		|| !requestId || !identifierPattern.test(requestId)
		|| !sessionId || !identifierPattern.test(sessionId)
		|| !callId || !identifierPattern.test(callId)
		|| !toolName || !identifierPattern.test(toolName)
		|| !argumentsSha256 || !/^[0-9a-f]{64}$/.test(argumentsSha256)
		|| summary === undefined || !args
		|| !isBoundedInteger(record.expectedRevision, 0, 1_000_000_000)) {
		return undefined;
	}
	return {
		type: 'approval',
		requestId,
		sessionId,
		callId,
		toolName,
		argumentsSha256,
		expectedRevision: record.expectedRevision,
		summary,
		arguments: args
	};
}

function parseCodingOutcome(value: Record<string, unknown>): FikeyaCodingOutcome | undefined {
	const plan = strictBoundedString(value.plan, 4_194_304);
	const summary = strictBoundedString(value.summary, 4_194_304);
	if (plan === undefined || summary === undefined || !isBoundedInteger(value.steps, 0, 1_000)
		|| !Array.isArray(value.toolCalls) || value.toolCalls.length > 1_000
		|| !Array.isArray(value.tests) || value.tests.length > 1_000
		|| !Array.isArray(value.changedFiles) || value.changedFiles.length > 1_000) {
		return undefined;
	}
	const toolCalls = value.toolCalls.map(parseToolOutcome);
	const tests = value.tests.map(parseToolOutcome);
	const changedFiles = value.changedFiles.map(parseChangedFileOutcome);
	if (toolCalls.some(candidate => candidate === undefined)
		|| tests.some(candidate => candidate === undefined || candidate.test !== true)
		|| changedFiles.some(candidate => candidate === undefined)) {
		return undefined;
	}
	return {
		plan,
		summary,
		steps: value.steps,
		toolCalls: toolCalls as FikeyaToolOutcome[],
		tests: tests as FikeyaToolOutcome[],
		changedFiles: changedFiles as FikeyaChangedFileOutcome[]
	};
}

function parseToolOutcome(value: unknown): FikeyaToolOutcome | undefined {
	const record = asRecord(value);
	const callId = boundedString(record?.callId, 128);
	const name = boundedString(record?.name, 128);
	const outputSha256 = boundedString(record?.outputSha256, 71);
	const status = record?.status;
	const durationMs = nullableBoundedInteger(record?.durationMs);
	const exitCode = nullableSignedInteger(record?.exitCode, -65_535, 2_147_483_647);
	if (!record || !callId || !identifierPattern.test(callId)
		|| !name || !identifierPattern.test(name)
		|| (status !== 'ok' && status !== 'error')
		|| !outputSha256 || !/^sha256:[0-9a-f]{64}$/.test(outputSha256)
		|| durationMs === undefined || exitCode === undefined || typeof record.test !== 'boolean') {
		return undefined;
	}
	return { callId, name, status, outputSha256, durationMs, exitCode, test: record.test };
}

function parseChangedFileOutcome(value: unknown): FikeyaChangedFileOutcome | undefined {
	const record = asRecord(value);
	const filePath = strictBoundedString(record?.path, 4_096);
	const beforeSha256 = nullableBoundedString(record?.beforeSha256, 71);
	const afterSha256 = boundedString(record?.afterSha256, 71);
	if (!record || !filePath || filePath.includes('\\') || filePath.startsWith('/')
		|| filePath.split('/').includes('..')
		|| beforeSha256 === undefined
		|| (beforeSha256 !== null && !/^sha256:[0-9a-f]{64}$/.test(beforeSha256))
		|| !afterSha256 || !/^sha256:[0-9a-f]{64}$/.test(afterSha256)) {
		return undefined;
	}
	return { path: filePath, beforeSha256, afterSha256 };
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
	stdinSecret?: string,
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment()
): Promise<FikeyaRuntimeResult> {
	return new Promise(resolve => {
		const child = spawn(invocation.executable, args, {
			cwd: workspacePath,
			env: environment,
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
	outputLimitBytes = maximumOutputBytes,
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment()
): { readonly result: Promise<FikeyaCliResult<T>>; cancel(): void } {
	let cancelOperation = (): void => undefined;
	const result = new Promise<FikeyaCliResult<T>>(resolve => {
		const child = spawn(invocation.executable, args, {
			cwd: workspacePath,
			env: environment,
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

export function parseStatistics(value: unknown): FikeyaStatistics | undefined {
	const record = asRecord(value);
	const source = record?.source;
	const measurement = record?.measurement;
	const generatedAt = parseTimestamp(record?.generatedAt);
	const lastActivity = parseNullableTimestamp(record?.lastActivity);
	const inputTokens = nullableBoundedInteger(record?.inputTokens);
	const cachedInputTokens = nullableBoundedInteger(record?.cachedInputTokens);
	const outputTokens = nullableBoundedInteger(record?.outputTokens);
	if (!record || record.ok !== true
		|| source !== 'local-runtime-sqlite'
		|| (measurement !== 'provider-reported-only' && measurement !== 'unavailable')
		|| !generatedAt || lastActivity === undefined
		|| !isBoundedInteger(record.sessions, 0, Number.MAX_SAFE_INTEGER)
		|| !isBoundedInteger(record.providerCalls, 0, Number.MAX_SAFE_INTEGER)
		|| !isBoundedInteger(record.measuredProviderCalls, 0, Number.MAX_SAFE_INTEGER)
		|| record.measuredProviderCalls > record.providerCalls
		|| inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined
		|| !isBoundedInteger(record.qarinahContextReceipts, 0, Number.MAX_SAFE_INTEGER)
		|| !Array.isArray(record.breakdown) || record.breakdown.length > 128) {
		return undefined;
	}
	const measuredTotals = inputTokens !== null && cachedInputTokens !== null && outputTokens !== null;
	const unavailableTotals = inputTokens === null && cachedInputTokens === null && outputTokens === null;
	if ((measurement === 'provider-reported-only' && !measuredTotals)
		|| (measurement === 'unavailable' && !unavailableTotals)
		|| (record.measuredProviderCalls === 0) !== (measurement === 'unavailable')) {
		return undefined;
	}

	const breakdown: FikeyaStatisticsBreakdown[] = [];
	let breakdownCalls = 0;
	let breakdownMeasuredCalls = 0;
	for (const candidate of record.breakdown) {
		const item = parseStatisticsBreakdown(candidate);
		if (!item) {
			return undefined;
		}
		breakdownCalls += item.calls;
		breakdownMeasuredCalls += item.measuredCalls;
		if (!Number.isSafeInteger(breakdownCalls) || !Number.isSafeInteger(breakdownMeasuredCalls)) {
			return undefined;
		}
		breakdown.push(item);
	}
	if (breakdownCalls !== record.providerCalls || breakdownMeasuredCalls !== record.measuredProviderCalls) {
		return undefined;
	}

	return {
		source,
		measurement,
		generatedAt,
		sessions: record.sessions,
		providerCalls: record.providerCalls,
		measuredProviderCalls: record.measuredProviderCalls,
		inputTokens,
		cachedInputTokens,
		outputTokens,
		qarinahContextReceipts: record.qarinahContextReceipts,
		lastActivity,
		breakdown
	};
}

function parseStatisticsBreakdown(value: unknown): FikeyaStatisticsBreakdown | undefined {
	const record = asRecord(value);
	const provider = boundedString(record?.provider, 128);
	const model = boundedString(record?.model, 160);
	const inputTokens = nullableBoundedInteger(record?.inputTokens);
	const cachedInputTokens = nullableBoundedInteger(record?.cachedInputTokens);
	const outputTokens = nullableBoundedInteger(record?.outputTokens);
	const lastActivity = parseNullableTimestamp(record?.lastActivity);
	if (!record || !provider || !model
		|| !isBoundedInteger(record.calls, 0, Number.MAX_SAFE_INTEGER)
		|| !isBoundedInteger(record.measuredCalls, 0, Number.MAX_SAFE_INTEGER)
		|| record.measuredCalls > record.calls
		|| inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined
		|| lastActivity === undefined) {
		return undefined;
	}
	const measuredTotals = inputTokens !== null && cachedInputTokens !== null && outputTokens !== null;
	const unavailableTotals = inputTokens === null && cachedInputTokens === null && outputTokens === null;
	if ((record.measuredCalls > 0 && !measuredTotals) || (record.measuredCalls === 0 && !unavailableTotals)) {
		return undefined;
	}
	return {
		provider,
		model,
		calls: record.calls,
		measuredCalls: record.measuredCalls,
		inputTokens,
		cachedInputTokens,
		outputTokens,
		lastActivity
	};
}

function startAgentProtocolCli(
	args: readonly string[],
	workspacePath: string,
	prompt: string,
	approvalHandler: FikeyaAgentApprovalHandler,
	timeoutMilliseconds: number,
	outputLimitBytes: number,
	invocation: FikeyaCliInvocation,
	environment: NodeJS.ProcessEnv
): FikeyaAgentRunHandle {
	let cancelOperation = (): void => undefined;
	const result = new Promise<FikeyaCliResult<FikeyaAgentTurn>>(resolve => {
		const child = spawn(invocation.executable, args, {
			cwd: workspacePath,
			env: environment,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});
		let buffered = Buffer.alloc(0);
		let outputBytes = 0;
		let finalValue: FikeyaAgentTurn | undefined;
		let protocolFailure: FikeyaRuntimeFailure | undefined;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let processing = Promise.resolve();

		const finish = (operationResult: FikeyaCliResult<FikeyaAgentTurn>): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			resolve(operationResult);
		};
		const stop = (failure: FikeyaRuntimeFailure): void => {
			if (!settled) {
				child.kill();
				finish({ ok: false, exitCode: null, failure });
			}
		};
		cancelOperation = (): void => stop('cancelled');

		if (!child.stdin || !child.stdout || !child.stderr) {
			stop('runtime-error');
			return;
		}

		const writeMessage = (value: unknown): Promise<void> => new Promise((accept, reject) => {
			const payload = `${JSON.stringify(value)}\n`;
			child.stdin.write(payload, 'utf8', error => error ? reject(error) : accept());
		});
		const processLine = async (line: Buffer): Promise<void> => {
			if (line.length === 0 || line.length > maximumProtocolLineBytes) {
				throw new Error('Fikeya coding protocol line is empty or exceeds its limit.');
			}
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
			} catch {
				throw new Error('Fikeya coding protocol emitted invalid JSON.');
			}
			const record = asRecord(value);
			if (record?.type === 'progress') {
				if (!parseAgentProgress(record)) {
					throw new Error('Fikeya coding progress did not match the bounded schema.');
				}
				return;
			}
			if (record?.type === 'approval') {
				const request = parseAgentApproval(record);
				if (!request) {
					throw new Error('Fikeya coding approval did not match the bounded schema.');
				}
				const decision = await approvalHandler(request);
				if (decision !== 'allow_once' && decision !== 'deny_once' && decision !== 'cancel') {
					throw new Error('Fikeya coding approval handler returned an invalid decision.');
				}
				await writeMessage({ type: 'approval', requestId: request.requestId, decision });
				return;
			}
			if (record?.type === 'result') {
				if (finalValue) {
					throw new Error('Fikeya coding protocol emitted more than one result.');
				}
				finalValue = parseAgentTurn(record);
				if (!finalValue) {
					throw new Error('Fikeya coding result did not match the bounded schema.');
				}
				return;
			}
			if (record?.type === 'error') {
				if (protocolFailure || !parseProtocolFailure(record)) {
					throw new Error('Fikeya coding error did not match the bounded schema.');
				}
				protocolFailure = parseProtocolFailure(record);
				return;
			}
			throw new Error('Fikeya coding protocol emitted an unknown message.');
		};

		const capture = (chunk: Buffer, retain: boolean): void => {
			if (settled) {
				return;
			}
			outputBytes += chunk.byteLength;
			if (outputBytes > outputLimitBytes) {
				stop('output-limit');
				return;
			}
			if (!retain) {
				return;
			}
			buffered = Buffer.concat([buffered, chunk]);
			while (true) {
				const newline = buffered.indexOf(0x0a);
				if (newline < 0) {
					if (buffered.length > maximumProtocolLineBytes) {
						stop('output-limit');
					}
					break;
				}
				let line = buffered.subarray(0, newline);
				buffered = buffered.subarray(newline + 1);
				if (line.at(-1) === 0x0d) {
					line = line.subarray(0, line.length - 1);
				}
				processing = processing.then(() => processLine(line));
				processing.catch(() => stop('invalid-json'));
			}
		};

		child.stdout.on('data', chunk => capture(chunk as Buffer, true));
		child.stderr.on('data', chunk => capture(chunk as Buffer, false));
		child.stdin.on('error', () => {
			if (!settled) {
				stop('runtime-error');
			}
		});
		child.on('error', error => {
			finish({
				ok: false,
				exitCode: null,
				failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'runtime-error'
			});
		});
		child.on('close', exitCode => {
			void processing.then(() => {
				if (settled) {
					return;
				}
				if (buffered.length !== 0) {
					finish({ ok: false, exitCode, failure: 'invalid-json' });
					return;
				}
				if (exitCode !== 0) {
					finish({ ok: false, exitCode, failure: protocolFailure ?? 'runtime-error' });
					return;
				}
				if (!finalValue) {
					finish({ ok: false, exitCode, failure: 'invalid-json' });
					return;
				}
				finish({ ok: true, exitCode, value: finalValue, failure: 'none' });
			}).catch(() => finish({ ok: false, exitCode, failure: 'invalid-json' }));
		});

		void writeMessage({ type: 'start', prompt }).catch(() => stop('runtime-error'));
		timeout = setTimeout(() => stop('timeout'), timeoutMilliseconds);
	});
	return { result, cancel: () => cancelOperation() };
}

export function parseProtocolFailure(record: Record<string, unknown>): FikeyaRuntimeFailure | undefined {
	if (record.type !== 'error'
		|| !boundedString(record.message, 2_048)
		|| !isBoundedInteger(record.statusCode, 100, 599)
		|| typeof record.retryable !== 'boolean') {
		return undefined;
	}
	switch (record.kind) {
		case 'quota':
			return 'quota';
		case 'authentication':
			return 'authentication';
		case 'provider':
			return 'provider-error';
		default:
			return undefined;
	}
}

function parseAgentProgress(record: Record<string, unknown>): boolean {
	const event = boundedString(record.event, 80);
	const stage = boundedString(record.stage, 80);
	return record.type === 'progress'
		&& Boolean(event && identifierPattern.test(event))
		&& Boolean(stage && identifierPattern.test(stage))
		&& isBoundedInteger(record.sequence, 0, 1_000_000_000);
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

function nullableSignedInteger(value: unknown, minimum: number, maximum: number): number | null | undefined {
	if (value === null) {
		return null;
	}
	return isBoundedInteger(value, minimum, maximum) ? value : undefined;
}

function nullableBoundedString(value: unknown, maximumLength: number): string | null | undefined {
	if (value === null) {
		return null;
	}
	return typeof value === 'string' && value.length <= maximumLength ? value : undefined;
}

function parseTimestamp(value: unknown): string | undefined {
	const timestamp = strictBoundedString(value, 80);
	return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

function parseNullableTimestamp(value: unknown): string | null | undefined {
	return value === null ? null : parseTimestamp(value);
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
