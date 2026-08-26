/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import path from 'node:path';
import { ChildProcess, spawn } from 'child_process';
import { TextDecoder } from 'node:util';
import type { FikeyaProviderHistoryMessage } from './conversation';

const maximumOutputBytes = 1024 * 1024;
const maximumAgentOutputBytes = 5 * 1024 * 1024;
const maximumPlanOutputBytes = 3 * 1024 * 1024;
const maximumPlanSpecificationBytes = 1024 * 1024;
const runtimeTimeoutMilliseconds = 30_000;
const agentTimeoutMilliseconds = 15 * 60_000;
const maximumProtocolLineBytes = 1024 * 1024;
const maximumProgressEvents = 4_096;
const processTerminationGraceMilliseconds = 2_000;
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

export interface FikeyaMatchedComparison {
	readonly status: 'matched';
	readonly pairCount: number;
	readonly baselineBilledTokens: number;
	readonly fikeyaBilledTokens: number;
	readonly baselineVerifiedSolveRate: number;
	readonly fikeyaVerifiedSolveRate: number;
	readonly billedTokenReductionPercent: number;
	readonly reportSha256: string;
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
	readonly matchedComparison: FikeyaMatchedComparison | null;
}

export type FikeyaPlanStatus = 'draft' | 'reviewed' | 'awaiting_approval' | 'executing' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
export type FikeyaPlanStepStatus = 'pending' | 'awaiting_approval' | 'approved' | 'executing' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';

export interface FikeyaPlanApprovalReference {
	readonly referenceId: string;
	readonly toolCallSha256: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly consumedAt: string | null;
}

export interface FikeyaPlanExecutionOutcome {
	readonly toolCallSha256: string;
	readonly resultSha256: string;
	readonly executionSha256: string;
	readonly status: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number | null;
	readonly exitCode: number | null;
}

export interface FikeyaPlanVerificationCheck {
	readonly kind: string;
	readonly subject: string;
	readonly expected: string;
	readonly actual: string;
	readonly passed: boolean;
}

export interface FikeyaPlanVerificationOutcome {
	readonly status: 'passed' | 'failed';
	readonly checks: readonly FikeyaPlanVerificationCheck[];
	readonly verifiedAt: string;
	readonly outcomeSha256: string;
}

export interface FikeyaPlanFileExpectation {
	readonly path: string;
	readonly sha256: string;
}

export interface FikeyaPlanVerificationSpec {
	readonly expectedStatus: 'ok' | 'denied' | 'error';
	readonly expectedExitCode: number | null;
	readonly expectedOutputSha256: string | null;
	readonly files: readonly FikeyaPlanFileExpectation[];
}

export interface FikeyaPlanStep {
	readonly stepId: string;
	readonly order: number;
	readonly title: string;
	readonly dependsOn: readonly string[];
	readonly status: FikeyaPlanStepStatus;
	readonly toolCall: {
		readonly callId: string;
		readonly name: string;
		readonly arguments: Readonly<Record<string, unknown>>;
	};
	readonly toolCallSha256: string;
	readonly verificationSpec: FikeyaPlanVerificationSpec;
	readonly approval: FikeyaPlanApprovalReference | null;
	readonly execution: FikeyaPlanExecutionOutcome | null;
	readonly verification: FikeyaPlanVerificationOutcome | null;
}

export interface FikeyaPlanRecord {
	readonly schemaVersion: 1;
	readonly planId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly status: FikeyaPlanStatus;
	readonly revision: number;
	readonly specSha256: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly steps: readonly FikeyaPlanStep[];
	readonly failureReason: string | null;
}

export interface FikeyaPlanView {
	readonly plan: FikeyaPlanRecord;
	readonly recordSha256: string;
}

export interface FikeyaPlanProposalMetadata {
	readonly protocol: 'fikeya.plan-proposal.v1';
	readonly sessionId: string;
	readonly callId: string;
	readonly usage: FikeyaAgentUsage;
	readonly memory: FikeyaAgentMemory;
}

export interface FikeyaPlanProposalView extends FikeyaPlanView {
	readonly proposal: FikeyaPlanProposalMetadata;
}

export interface FikeyaPlanSpecification {
	readonly schemaVersion?: 1;
	readonly title: string;
	readonly steps: readonly Readonly<Record<string, unknown>>[];
}

export interface FikeyaCliResult<T> {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly value?: T;
	readonly failure: FikeyaRuntimeFailure;
}

export interface FikeyaRunProgress {
	readonly type: 'progress';
	readonly event: string;
	readonly stage: string;
	readonly sequence: number;
}

export type FikeyaRunProgressHandler = (progress: FikeyaRunProgress) => void;

export interface FikeyaAgentRunHandle {
	readonly result: Promise<FikeyaCliResult<FikeyaAgentTurn>>;
	onProgress(handler: FikeyaRunProgressHandler): () => void;
	cancel(): void;
}

export interface FikeyaPlanRunHandle {
	readonly result: Promise<FikeyaCliResult<FikeyaPlanView>>;
	onProgress(handler: FikeyaRunProgressHandler): () => void;
	cancel(): void;
}

export interface FikeyaPlanProposalRunHandle {
	readonly result: Promise<FikeyaCliResult<FikeyaPlanProposalView>>;
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
		// Packaged extension hosts expose Electron as process.execPath. Explicitly
		// opt that child process into Node mode before the Python runtime launches
		// the extension-owned Qarinah sidecar. A normal node executable needs no
		// override and remains usable in source tests and standalone hosts.
		if (!/^node(?:\.exe)?$/i.test(path.basename(nodeExecutable))) {
			result.ELECTRON_RUN_AS_NODE = '1';
		}
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
	history: readonly FikeyaProviderHistoryMessage[] = [],
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
		|| !['auto', 'off', 'required'].includes(memoryMode)
		|| !isValidProviderHistory(history)) {
		return {
			result: Promise.resolve(invalidLocalRequest()),
			onProgress: () => () => undefined,
			cancel: () => undefined
		};
	}

	const operation = startAgentProtocolCli(
		buildAgentRunArguments(providerName, maxOutputTokens, contextMaxCharacters, memoryMode),
		workspacePath,
		prompt,
		history,
		approvalHandler,
		agentTimeoutMilliseconds,
		maximumAgentOutputBytes,
		invocation,
		environment
	);
	return operation;
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

/** Creates one immutable plan specification. All titles, tool arguments, and file content use stdin. */
export async function createFikeyaPlan(
	specification: FikeyaPlanSpecification,
	workspacePath: string
): Promise<FikeyaCliResult<FikeyaPlanView>> {
	let payload: string;
	try {
		payload = JSON.stringify(specification);
	} catch {
		return invalidLocalRequest();
	}
	if (!payload || Buffer.byteLength(payload, 'utf8') > maximumPlanSpecificationBytes) {
		return invalidLocalRequest();
	}
	return startBoundedJsonCli(
		buildPlanCreateArguments(),
		workspacePath,
		parsePlanView,
		payload,
		runtimeTimeoutMilliseconds,
		maximumPlanOutputBytes
	).result;
}

/**
 * Starts one planning-only model call. The task crosses stdin, the response must satisfy the
 * versioned plan protocol, and the Python runtime persists only a draft without invoking tools.
 */
export function startFikeyaPlanProposal(
	providerName: string,
	prompt: string,
	maxOutputTokens: number,
	contextMaxCharacters: number,
	memoryMode: FikeyaMemoryMode,
	workspacePath: string,
	history: readonly FikeyaProviderHistoryMessage[] = [],
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment()
): FikeyaPlanProposalRunHandle {
	if (!identifierPattern.test(providerName)
		|| !prompt.trim()
		|| Buffer.byteLength(prompt, 'utf8') > 262_144
		|| !Number.isSafeInteger(maxOutputTokens)
		|| maxOutputTokens < 1
		|| maxOutputTokens > 32_768
		|| !Number.isSafeInteger(contextMaxCharacters)
		|| contextMaxCharacters < 512
		|| contextMaxCharacters > 64_000
		|| !['auto', 'off', 'required'].includes(memoryMode)
		|| !isValidProviderHistory(history)) {
		return { result: Promise.resolve(invalidLocalRequest()), cancel: () => undefined };
	}
	return startBoundedJsonCli(
		buildPlanProposalArguments(providerName, maxOutputTokens, contextMaxCharacters, memoryMode),
		workspacePath,
		parsePlanProposalView,
		JSON.stringify({ protocol: 'fikeya.plan-request.v1', prompt, history }),
		agentTimeoutMilliseconds,
		maximumPlanOutputBytes,
		invocation,
		environment
	);
}

/** Reloads the current integrity-checked plan and its proof-record hash. */
export async function loadFikeyaPlan(planId: string, workspacePath: string): Promise<FikeyaCliResult<FikeyaPlanView>> {
	if (!identifierPattern.test(planId)) {
		return invalidLocalRequest();
	}
	return runBoundedJsonCli(buildPlanActionArguments('show', planId), workspacePath, parsePlanView, maximumPlanOutputBytes);
}

/** Applies a non-executing durable plan transition. */
export async function changeFikeyaPlan(
	action: 'review' | 'cancel',
	planId: string,
	workspacePath: string
): Promise<FikeyaCliResult<FikeyaPlanView>> {
	if (!identifierPattern.test(planId)) {
		return invalidLocalRequest();
	}
	return runBoundedJsonCli(buildPlanActionArguments(action, planId), workspacePath, parsePlanView, maximumPlanOutputBytes);
}

/** Issues single-use references for either exact selected steps or every pending step. */
export async function approveFikeyaPlan(
	planId: string,
	stepIds: readonly string[] | 'all',
	workspacePath: string
): Promise<FikeyaCliResult<FikeyaPlanView>> {
	if (!identifierPattern.test(planId)
		|| (stepIds !== 'all' && (stepIds.length < 1 || stepIds.length > 64 || stepIds.some(stepId => !identifierPattern.test(stepId)) || new Set(stepIds).size !== stepIds.length))) {
		return invalidLocalRequest();
	}
	return runBoundedJsonCli(buildPlanApproveArguments(planId, stepIds), workspacePath, parsePlanView, maximumPlanOutputBytes);
}

/** Runs or resumes an approved durable plan. The caller can stop the child at any time. */
export function startFikeyaPlan(
	action: 'run' | 'resume',
	planId: string,
	workspacePath: string,
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment()
): FikeyaPlanRunHandle {
	if (!identifierPattern.test(planId)) {
		return { result: Promise.resolve(invalidLocalRequest()), onProgress: () => () => undefined, cancel: () => undefined };
	}
	return startPlanProtocolCli(
		buildPlanActionArguments(action, planId),
		workspacePath,
		agentTimeoutMilliseconds,
		maximumPlanOutputBytes,
		invocation,
		environment,
		[0, 2]
	);
}

export function buildPlanCreateArguments(): readonly string[] {
	return ['plan', 'create', '.', '--spec-stdin', '--json'];
}

/** Builds a content-free argument vector; the planning request itself is stdin-only. */
export function buildPlanProposalArguments(
	providerName: string,
	maxOutputTokens: number,
	contextMaxCharacters: number,
	memoryMode: FikeyaMemoryMode
): readonly string[] {
	return [
		'plan',
		'propose',
		'.',
		'--provider',
		providerName,
		'--request-stdin',
		'--allow-network',
		'--max-output-tokens',
		String(maxOutputTokens),
		'--context-max-characters',
		String(contextMaxCharacters),
		'--memory',
		memoryMode,
		'--json'
	];
}

export function buildPlanActionArguments(action: 'show' | 'review' | 'run' | 'resume' | 'cancel', planId: string): readonly string[] {
	return ['plan', action, planId, '--workspace', '.', '--json'];
}

export function buildPlanApproveArguments(planId: string, stepIds: readonly string[] | 'all'): readonly string[] {
	const args = ['plan', 'approve', planId, '--workspace', '.'];
	if (stepIds === 'all') {
		args.push('--all');
	} else {
		for (const stepId of stepIds) {
			args.push('--step', stepId);
		}
	}
	args.push('--json');
	return args;
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

/** Parses the exact durable plan document returned by create/show/action commands. */
export function parsePlanView(value: unknown): FikeyaPlanView | undefined {
	const record = asRecord(value);
	const recordSha256 = strictBoundedString(record?.recordSha256, 71);
	const plan = parsePlanRecord(record?.plan);
	if (!record || typeof record.ok !== 'boolean' || !recordSha256 || !/^sha256:[0-9a-f]{64}$/.test(recordSha256) || !plan) {
		return undefined;
	}
	return { plan, recordSha256 };
}

/** Parses a persisted draft together with the content-free planning call receipt. */
export function parsePlanProposalView(value: unknown): FikeyaPlanProposalView | undefined {
	const record = asRecord(value);
	const view = parsePlanView(value);
	const proposal = asRecord(record?.proposal);
	const sessionId = strictBoundedString(proposal?.sessionId, 128);
	const callId = strictBoundedString(proposal?.callId, 128);
	const usage = parsePlanProposalUsage(proposal?.usage);
	const memory = parsePlanProposalMemory(proposal?.memory);
	if (!record || record.ok !== true || !view || !proposal
		|| !hasExactRecordKeys(proposal, ['callId', 'memory', 'protocol', 'sessionId', 'usage'])
		|| proposal.protocol !== 'fikeya.plan-proposal.v1'
		|| !sessionId || !identifierPattern.test(sessionId)
		|| !callId || !identifierPattern.test(callId)
		|| !usage || !memory) {
		return undefined;
	}
	return { ...view, proposal: { protocol: 'fikeya.plan-proposal.v1', sessionId, callId, usage, memory } };
}

function parsePlanProposalUsage(value: unknown): FikeyaAgentUsage | undefined {
	const record = asRecord(value);
	const measurement = record?.measurement;
	const inputTokens = nullableBoundedInteger(record?.inputTokens);
	const outputTokens = nullableBoundedInteger(record?.outputTokens);
	const cachedInputTokens = nullableBoundedInteger(record?.cachedInputTokens);
	if (!record || !hasExactRecordKeys(record, ['cachedInputTokens', 'inputTokens', 'measurement', 'outputTokens'])
		|| (measurement !== 'provider-reported' && measurement !== 'unavailable')
		|| inputTokens === undefined || outputTokens === undefined || cachedInputTokens === undefined
		|| (measurement === 'provider-reported' && (inputTokens === null || outputTokens === null || cachedInputTokens === null))
		|| (measurement === 'unavailable' && (inputTokens !== null || outputTokens !== null || cachedInputTokens !== null))) {
		return undefined;
	}
	return { measurement, inputTokens, outputTokens, cachedInputTokens };
}

function parsePlanProposalMemory(value: unknown): FikeyaAgentMemory | undefined {
	const record = asRecord(value);
	const status = record?.status;
	const coverage = nullableBoundedString(record?.coverage, 40);
	const evidenceCount = nullableBoundedInteger(record?.evidenceCount);
	const receiptId = nullableBoundedString(record?.receiptId, 128);
	const responseSha256 = nullableBoundedString(record?.responseSha256, 71);
	if (!record || !hasExactRecordKeys(record, ['coverage', 'evidenceCount', 'receiptId', 'responseSha256', 'status'])
		|| (status !== 'off' && status !== 'unavailable' && status !== 'used')
		|| coverage === undefined || evidenceCount === undefined || receiptId === undefined || responseSha256 === undefined) {
		return undefined;
	}
	if (status === 'used') {
		if (!coverage || evidenceCount === null || !receiptId || !contextReceiptPattern.test(receiptId)
			|| !responseSha256 || !/^sha256:[0-9a-f]{64}$/.test(responseSha256)) {
			return undefined;
		}
	} else if (coverage !== null || evidenceCount !== null || receiptId !== null || responseSha256 !== null) {
		return undefined;
	}
	return { status, coverage, evidenceCount, receiptId, responseSha256 };
}

function parsePlanRecord(value: unknown): FikeyaPlanRecord | undefined {
	const record = asRecord(value);
	const planId = strictBoundedString(record?.planId, 128);
	const workspaceId = strictBoundedString(record?.workspaceId, 128);
	const title = strictBoundedUtf8String(record?.title, 4_096);
	const specSha256 = strictBoundedString(record?.specSha256, 71);
	const createdAt = parseTimestamp(record?.createdAt);
	const updatedAt = parseTimestamp(record?.updatedAt);
	const status = record?.status;
	const failureReason = nullableBoundedString(record?.failureReason, 512);
	if (!record || !hasExactRecordKeys(record, ['createdAt', 'failureReason', 'planId', 'revision', 'schemaVersion', 'specSha256', 'status', 'steps', 'title', 'updatedAt', 'workspaceId'])
		|| record.schemaVersion !== 1
		|| !planId || !identifierPattern.test(planId)
		|| !workspaceId || !identifierPattern.test(workspaceId)
		|| !title || !title.trim() || !specSha256 || !/^sha256:[0-9a-f]{64}$/.test(specSha256)
		|| !createdAt || !updatedAt
		|| !isPlanStatus(status)
		|| !isBoundedInteger(record.revision, 1, 1_000_000_000)
		|| failureReason === undefined
		|| !Array.isArray(record.steps) || record.steps.length < 1 || record.steps.length > 64) {
		return undefined;
	}
	const steps = record.steps.map(parsePlanStep);
	if (steps.some(step => step === undefined)) {
		return undefined;
	}
	const typedSteps = steps as FikeyaPlanStep[];
	const stepIds = new Set(typedSteps.map(step => step.stepId));
	const callIds = new Set(typedSteps.map(step => step.toolCall.callId));
	const seen = new Set<string>();
	if (stepIds.size !== typedSteps.length
		|| callIds.size !== typedSteps.length
		|| typedSteps.some((step, index) => {
			const invalid = step.order !== index + 1
				|| new Set(step.dependsOn).size !== step.dependsOn.length
				|| step.dependsOn.some(dependency => !seen.has(dependency));
			seen.add(step.stepId);
			return invalid;
		})) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		planId,
		workspaceId,
		title,
		status,
		revision: record.revision,
		specSha256,
		createdAt,
		updatedAt,
		steps: typedSteps,
		failureReason
	};
}

function parsePlanStep(value: unknown): FikeyaPlanStep | undefined {
	const record = asRecord(value);
	const stepId = strictBoundedString(record?.stepId, 128);
	const title = strictBoundedUtf8String(record?.title, 4_096);
	const status = record?.status;
	const toolCall = asRecord(record?.toolCall);
	const callId = strictBoundedString(toolCall?.callId, 128);
	const name = strictBoundedString(toolCall?.name, 128);
	const args = asRecord(toolCall?.arguments);
	const toolCallSha256 = strictBoundedString(record?.toolCallSha256, 71);
	if (!record || !hasExactRecordKeys(record, ['approval', 'dependsOn', 'execution', 'order', 'status', 'stepId', 'title', 'toolCall', 'toolCallSha256', 'verification', 'verificationSpec'])
		|| !stepId || !identifierPattern.test(stepId) || !title || !title.trim()
		|| !isBoundedInteger(record.order, 1, 64) || !isPlanStepStatus(status)
		|| !Array.isArray(record.dependsOn) || record.dependsOn.length > 64
		|| record.dependsOn.some(dependency => typeof dependency !== 'string' || !identifierPattern.test(dependency))
		|| !toolCall || !hasExactRecordKeys(toolCall, ['arguments', 'callId', 'name'])
		|| !callId || !identifierPattern.test(callId)
		|| !name || !isSupportedPlanTool(name) || !args || !hasBoundedFiniteJsonEncoding(args, 65_536)
		|| !toolCallSha256 || !/^sha256:[0-9a-f]{64}$/.test(toolCallSha256)) {
		return undefined;
	}
	const approval = record.approval === null ? null : parsePlanApproval(record.approval);
	const execution = record.execution === null ? null : parsePlanExecution(record.execution);
	const verification = record.verification === null ? null : parsePlanVerification(record.verification);
	const verificationSpec = parsePlanVerificationSpec(record.verificationSpec);
	if (approval === undefined || execution === undefined || verification === undefined || !verificationSpec
		|| (approval !== null && approval.toolCallSha256 !== toolCallSha256)
		|| (execution !== null && execution.toolCallSha256 !== toolCallSha256)) {
		return undefined;
	}
	return {
		stepId,
		order: record.order,
		title,
		dependsOn: record.dependsOn as string[],
		status,
		toolCall: { callId, name, arguments: args },
		toolCallSha256,
		verificationSpec,
		approval,
		execution,
		verification
	};
}

function parsePlanVerificationSpec(value: unknown): FikeyaPlanVerificationSpec | undefined {
	const record = asRecord(value);
	const expectedStatus = record?.expectedStatus;
	const expectedExitCode = nullableSignedInteger(record?.expectedExitCode, -65_535, 2_147_483_647);
	const expectedOutputSha256 = nullableBoundedString(record?.expectedOutputSha256, 71);
	if (!record || !hasExactRecordKeys(record, ['expectedExitCode', 'expectedOutputSha256', 'expectedStatus', 'files'])
		|| (expectedStatus !== 'ok' && expectedStatus !== 'denied' && expectedStatus !== 'error')
		|| expectedExitCode === undefined || expectedOutputSha256 === undefined
		|| (expectedOutputSha256 !== null && !/^sha256:[0-9a-f]{64}$/.test(expectedOutputSha256))
		|| !Array.isArray(record.files) || record.files.length > 64) {
		return undefined;
	}
	const files = record.files.map(candidate => {
		const file = asRecord(candidate);
		const filePath = strictBoundedString(file?.path, 4_096);
		const sha256 = strictBoundedString(file?.sha256, 71);
		const parts = filePath?.split('/') ?? [];
		return file && hasExactRecordKeys(file, ['path', 'sha256'])
			&& filePath && !filePath.includes('\\') && !filePath.startsWith('/') && !/^[a-zA-Z]:/.test(filePath)
			&& filePath !== '.' && !parts.includes('..') && !parts.some(part => part.toLowerCase() === '.fikeya')
			&& sha256 && /^sha256:[0-9a-f]{64}$/.test(sha256)
			? { path: filePath, sha256 }
			: undefined;
	});
	if (files.some(file => file === undefined)) {
		return undefined;
	}
	const typedFiles = files as FikeyaPlanFileExpectation[];
	if (new Set(typedFiles.map(file => file.path)).size !== typedFiles.length) {
		return undefined;
	}
	return { expectedStatus, expectedExitCode, expectedOutputSha256, files: typedFiles };
}

function parsePlanApproval(value: unknown): FikeyaPlanApprovalReference | undefined {
	const record = asRecord(value);
	const referenceId = strictBoundedString(record?.referenceId, 128);
	const toolCallSha256 = strictBoundedString(record?.toolCallSha256, 71);
	const issuedAt = parseTimestamp(record?.issuedAt);
	// Pre-expiry records are accepted only as already-expired approvals. This mirrors the
	// runtime migration boundary, where a missing expiresAt is normalized to issuedAt so
	// legacy data can be inspected but can never authorize new execution.
	const hasExpiry = record ? Object.prototype.hasOwnProperty.call(record, 'expiresAt') : false;
	const expiresAt = hasExpiry ? parseTimestamp(record?.expiresAt) : issuedAt;
	const consumedAt = parseNullableTimestamp(record?.consumedAt);
	const hasExactKeys = record && (
		hasExactRecordKeys(record, ['consumedAt', 'expiresAt', 'issuedAt', 'referenceId', 'toolCallSha256'])
		|| hasExactRecordKeys(record, ['consumedAt', 'issuedAt', 'referenceId', 'toolCallSha256'])
	);
	if (!record || !hasExactKeys
		|| !referenceId || !identifierPattern.test(referenceId)
		|| !toolCallSha256 || !/^sha256:[0-9a-f]{64}$/.test(toolCallSha256)
		|| !issuedAt || !expiresAt || Date.parse(expiresAt) < Date.parse(issuedAt)
		|| consumedAt === undefined) {
		return undefined;
	}
	return { referenceId, toolCallSha256, issuedAt, expiresAt, consumedAt };
}

function parsePlanExecution(value: unknown): FikeyaPlanExecutionOutcome | undefined {
	const record = asRecord(value);
	const toolCallSha256 = strictBoundedString(record?.toolCallSha256, 71);
	const resultSha256 = strictBoundedString(record?.resultSha256, 71);
	const executionSha256 = strictBoundedString(record?.executionSha256, 71);
	const status = strictBoundedString(record?.status, 40);
	const startedAt = parseTimestamp(record?.startedAt);
	const finishedAt = parseTimestamp(record?.finishedAt);
	const durationMs = nullableBoundedInteger(record?.durationMs);
	const exitCode = nullableSignedInteger(record?.exitCode, -65_535, 2_147_483_647);
	if (!record || !hasExactRecordKeys(record, ['durationMs', 'executionSha256', 'exitCode', 'finishedAt', 'resultSha256', 'startedAt', 'status', 'toolCallSha256'])
		|| !toolCallSha256 || !resultSha256 || !executionSha256
		|| ![toolCallSha256, resultSha256, executionSha256].every(hash => /^sha256:[0-9a-f]{64}$/.test(hash))
		|| !status || !startedAt || !finishedAt || durationMs === undefined || exitCode === undefined) {
		return undefined;
	}
	return { toolCallSha256, resultSha256, executionSha256, status, startedAt, finishedAt, durationMs, exitCode };
}

function parsePlanVerification(value: unknown): FikeyaPlanVerificationOutcome | undefined {
	const record = asRecord(value);
	const status = record?.status;
	const verifiedAt = parseTimestamp(record?.verifiedAt);
	const outcomeSha256 = strictBoundedString(record?.outcomeSha256, 71);
	if (!record || !hasExactRecordKeys(record, ['checks', 'outcomeSha256', 'status', 'verifiedAt'])
		|| (status !== 'passed' && status !== 'failed') || !verifiedAt
		|| !outcomeSha256 || !/^sha256:[0-9a-f]{64}$/.test(outcomeSha256)
		|| !Array.isArray(record.checks) || record.checks.length > 128) {
		return undefined;
	}
	const checks = record.checks.map(candidate => {
		const check = asRecord(candidate);
		const kind = strictBoundedString(check?.kind, 128);
		const subject = strictBoundedString(check?.subject, 4_096);
		const expected = strictBoundedString(check?.expected, 4_096);
		const actual = strictBoundedString(check?.actual, 4_096);
		return check && hasExactRecordKeys(check, ['actual', 'expected', 'kind', 'passed', 'subject'])
			&& kind && subject !== undefined && expected !== undefined && actual !== undefined && typeof check.passed === 'boolean'
			? { kind, subject, expected, actual, passed: check.passed }
			: undefined;
	});
	if (checks.some(check => check === undefined)) {
		return undefined;
	}
	return { status, checks: checks as FikeyaPlanVerificationCheck[], verifiedAt, outcomeSha256 };
}

function isPlanStatus(value: unknown): value is FikeyaPlanStatus {
	return typeof value === 'string' && ['draft', 'reviewed', 'awaiting_approval', 'executing', 'verifying', 'succeeded', 'failed', 'cancelled'].includes(value);
}

function isPlanStepStatus(value: unknown): value is FikeyaPlanStepStatus {
	return typeof value === 'string' && ['pending', 'awaiting_approval', 'approved', 'executing', 'verifying', 'succeeded', 'failed', 'cancelled'].includes(value);
}

function isSupportedPlanTool(value: string): boolean {
	return ['process.run', 'workspace.list_files', 'workspace.read_file', 'workspace.replace_text', 'workspace.search_text', 'workspace.write_file'].includes(value);
}

function hasBoundedFiniteJsonEncoding(value: unknown, maximumBytes: number): boolean {
	const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		visited += 1;
		if (visited > 32_768 || current.depth > 64) {
			return false;
		}
		if (current.value === null || typeof current.value === 'string' || typeof current.value === 'boolean') {
			continue;
		}
		if (typeof current.value === 'number') {
			if (!Number.isFinite(current.value)) {
				return false;
			}
			continue;
		}
		if (Array.isArray(current.value)) {
			for (const item of current.value) {
				pending.push({ value: item, depth: current.depth + 1 });
			}
			continue;
		}
		const record = asRecord(current.value);
		if (!record) {
			return false;
		}
		for (const item of Object.values(record)) {
			pending.push({ value: item, depth: current.depth + 1 });
		}
	}
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes;
	} catch {
		return false;
	}
}

function hasExactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
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

function terminateChildTree(child: ChildProcess): void {
	child.stdin?.destroy();
	if (process.platform === 'win32' && child.pid) {
		const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true,
			shell: false
		});
		killer.unref();
		return;
	}
	try {
		child.kill('SIGTERM');
	} catch {
		return;
	}
	const force = setTimeout(() => {
		try {
			child.kill('SIGKILL');
		} catch {
			// The child already closed between the grace timer and the kill request.
		}
	}, Math.floor(processTerminationGraceMilliseconds / 2));
	force.unref();
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
		let requestedFailure: FikeyaRuntimeFailure | undefined;
		let forcedFinish: NodeJS.Timeout | undefined;

		const finish = (result: FikeyaRuntimeResult): void => {
			if (!settled) {
				settled = true;
				if (timeout) {
					clearTimeout(timeout);
				}
				if (forcedFinish) {
					clearTimeout(forcedFinish);
				}
				resolve(result);
			}
		};
		const stop = (failure: FikeyaRuntimeFailure): void => {
			if (settled || requestedFailure) {
				return;
			}
			requestedFailure = failure;
			terminateChildTree(child);
			forcedFinish = setTimeout(() => finish({ ok: false, exitCode: null, failure }), processTerminationGraceMilliseconds);
		};

		const capture = (chunk: Buffer, retain: boolean): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maximumOutputBytes) {
				stop('output-limit');
				return;
			}
			if (retain) {
				output += chunk.toString('utf8');
			}
		};

		if (!child.stdout || !child.stderr) {
			stop('runtime-error');
			return;
		}
		child.stdout.on('data', chunk => capture(chunk as Buffer, true));
		child.stderr.on('data', chunk => capture(chunk as Buffer, false));
		child.on('error', error => {
			if (requestedFailure) {
				finish({ ok: false, exitCode: null, failure: requestedFailure });
				return;
			}
			finish({
				ok: false,
				exitCode: null,
				failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'runtime-error'
			});
		});
		child.on('close', exitCode => {
			if (requestedFailure) {
				finish({ ok: false, exitCode, failure: requestedFailure });
				return;
			}
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
			stop('timeout');
		}, runtimeTimeoutMilliseconds);
	});
}

function runBoundedJsonCli<T>(
	args: readonly string[],
	workspacePath: string,
	parser: (value: unknown) => T | undefined,
	outputLimitBytes = maximumOutputBytes
): Promise<FikeyaCliResult<T>> {
	return startBoundedJsonCli(args, workspacePath, parser, undefined, runtimeTimeoutMilliseconds, outputLimitBytes).result;
}

function startBoundedJsonCli<T>(
	args: readonly string[],
	workspacePath: string,
	parser: (value: unknown) => T | undefined,
	stdinPayload?: string,
	timeoutMilliseconds = runtimeTimeoutMilliseconds,
	outputLimitBytes = maximumOutputBytes,
	invocation = resolveFikeyaCli(),
	environment: NodeJS.ProcessEnv = buildFikeyaRuntimeEnvironment(),
	acceptedExitCodes: readonly number[] = [0]
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
		let cancellationRequested = false;
		let requestedFailure: FikeyaRuntimeFailure | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let forcedFinish: NodeJS.Timeout | undefined;
		const outputDecoder = new TextDecoder('utf-8', { fatal: true });

		const finish = (operationResult: FikeyaCliResult<T>): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			if (forcedFinish) {
				clearTimeout(forcedFinish);
			}
			resolve(operationResult);
		};
		const stop = (failure: FikeyaRuntimeFailure): void => {
			if (settled || requestedFailure) {
				return;
			}
			requestedFailure = failure;
			terminateChildTree(child);
			forcedFinish = setTimeout(() => finish({ ok: false, exitCode: null, failure }), processTerminationGraceMilliseconds);
		};

		cancelOperation = (): void => {
			if (settled) {
				return;
			}
			cancellationRequested = true;
			stop('cancelled');
		};

		const capture = (chunk: Buffer, retain: boolean): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > outputLimitBytes) {
				stop('output-limit');
				return;
			}
			if (retain) {
				try {
					output += outputDecoder.decode(chunk, { stream: true });
				} catch {
					stop('invalid-json');
				}
			}
		};

		if (!child.stdout || !child.stderr) {
			stop('runtime-error');
			return;
		}
		child.stdout.on('data', chunk => capture(chunk as Buffer, true));
		child.stderr.on('data', chunk => capture(chunk as Buffer, false));
		child.on('error', error => {
			if (requestedFailure) {
				finish({ ok: false, exitCode: null, failure: requestedFailure });
				return;
			}
			finish({
				ok: false,
				exitCode: null,
				failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'runtime-error'
			});
		});
		child.on('close', exitCode => {
			if (requestedFailure) {
				finish({ ok: false, exitCode, failure: requestedFailure });
				return;
			}
			if (exitCode === null || !acceptedExitCodes.includes(exitCode)) {
				finish({ ok: false, exitCode, failure: 'runtime-error' });
				return;
			}
			try {
				output += outputDecoder.decode();
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
			child.stdin.on('error', () => {
				if (cancellationRequested) {
					return;
				}
				stop('runtime-error');
			});
			child.stdin.end(stdinPayload, 'utf8');
		}

		timeout = setTimeout(() => {
			stop('timeout');
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
	const matchedComparison = record?.matchedComparison === null ? null : parseMatchedComparison(record?.matchedComparison);
	if (!record || record.ok !== true
		|| source !== 'local-runtime-sqlite'
		|| (measurement !== 'provider-reported-only' && measurement !== 'unavailable')
		|| !generatedAt || lastActivity === undefined
		|| !isBoundedInteger(record.sessions, 0, Number.MAX_SAFE_INTEGER)
		|| !isBoundedInteger(record.providerCalls, 0, Number.MAX_SAFE_INTEGER)
		|| !isBoundedInteger(record.measuredProviderCalls, 0, Number.MAX_SAFE_INTEGER)
		|| record.measuredProviderCalls > record.providerCalls
		|| inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined
		|| matchedComparison === undefined
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
		breakdown,
		matchedComparison
	};
}

function parseMatchedComparison(value: unknown): FikeyaMatchedComparison | undefined {
	const record = asRecord(value);
	const reportSha256 = strictBoundedString(record?.reportSha256, 71);
	if (!record || !hasExactRecordKeys(record, [
		'baselineBilledTokens',
		'baselineVerifiedSolveRate',
		'billedTokenReductionPercent',
		'fikeyaBilledTokens',
		'fikeyaVerifiedSolveRate',
		'pairCount',
		'reportSha256',
		'status'
	])
		|| record.status !== 'matched'
		|| !isBoundedInteger(record.pairCount, 1, 100_000)
		|| !isBoundedInteger(record.baselineBilledTokens, 1, Number.MAX_SAFE_INTEGER)
		|| !isBoundedInteger(record.fikeyaBilledTokens, 1, Number.MAX_SAFE_INTEGER)
		|| !isBoundedFiniteNumber(record.baselineVerifiedSolveRate, 0, 1)
		|| !isBoundedFiniteNumber(record.fikeyaVerifiedSolveRate, 0, 1)
		|| !isBoundedFiniteNumber(record.billedTokenReductionPercent, -1_000_000, 100)
		|| !reportSha256 || !/^sha256:[0-9a-f]{64}$/.test(reportSha256)) {
		return undefined;
	}
	return {
		status: 'matched',
		pairCount: record.pairCount,
		baselineBilledTokens: record.baselineBilledTokens,
		fikeyaBilledTokens: record.fikeyaBilledTokens,
		baselineVerifiedSolveRate: record.baselineVerifiedSolveRate,
		fikeyaVerifiedSolveRate: record.fikeyaVerifiedSolveRate,
		billedTokenReductionPercent: record.billedTokenReductionPercent,
		reportSha256
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

interface FikeyaProgressChannel {
	onProgress(handler: FikeyaRunProgressHandler): () => void;
	emit(progress: FikeyaRunProgress): void;
	close(): void;
}

function createProgressChannel(): FikeyaProgressChannel {
	const handlers = new Set<FikeyaRunProgressHandler>();
	let closed = false;
	let latest: FikeyaRunProgress | undefined;
	const notify = (handler: FikeyaRunProgressHandler, progress: FikeyaRunProgress): void => {
		try {
			handler(progress);
		} catch {
			// Observers cannot interrupt or alter the child-process result.
		}
	};
	return {
		onProgress: handler => {
			if (closed) {
				return () => undefined;
			}
			handlers.add(handler);
			if (latest) {
				notify(handler, latest);
			}
			return () => handlers.delete(handler);
		},
		emit: progress => {
			latest = progress;
			for (const handler of handlers) {
				notify(handler, progress);
			}
		},
		close: () => {
			closed = true;
			latest = undefined;
			handlers.clear();
		}
	};
}

function startPlanProtocolCli(
	args: readonly string[],
	workspacePath: string,
	timeoutMilliseconds: number,
	outputLimitBytes: number,
	invocation: FikeyaCliInvocation,
	environment: NodeJS.ProcessEnv,
	acceptedExitCodes: readonly number[]
): FikeyaPlanRunHandle {
	let cancelOperation = (): void => undefined;
	const progressChannel = createProgressChannel();
	const result = new Promise<FikeyaCliResult<FikeyaPlanView>>(resolve => {
		const child = spawn(invocation.executable, args, {
			cwd: workspacePath,
			env: environment,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		let buffered = Buffer.alloc(0);
		let outputBytes = 0;
		let finalValue: FikeyaPlanView | undefined;
		let settled = false;
		let requestedFailure: FikeyaRuntimeFailure | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let forcedFinish: NodeJS.Timeout | undefined;
		let processing = Promise.resolve();
		let progressCount = 0;
		let lastProgressSequence = -1;

		const finish = (operationResult: FikeyaCliResult<FikeyaPlanView>): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			if (forcedFinish) {
				clearTimeout(forcedFinish);
			}
			progressChannel.close();
			resolve(operationResult);
		};
		const stop = (failure: FikeyaRuntimeFailure): void => {
			if (settled || requestedFailure) {
				return;
			}
			requestedFailure = failure;
			terminateChildTree(child);
			forcedFinish = setTimeout(() => finish({ ok: false, exitCode: null, failure }), processTerminationGraceMilliseconds);
		};
		cancelOperation = (): void => stop('cancelled');

		if (!child.stdout || !child.stderr) {
			stop('runtime-error');
			return;
		}

		const processLine = (line: Buffer): void => {
			if (line.length === 0 || line.length > maximumProtocolLineBytes) {
				throw new Error('Fikeya plan protocol line is empty or exceeds its limit.');
			}
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
			} catch {
				throw new Error('Fikeya plan protocol emitted invalid JSON.');
			}
			const record = asRecord(value);
			if (record?.type === 'progress') {
				const progress = parseRunProgress(record);
				if (!progress
					|| progressCount >= maximumProgressEvents
					|| progress.sequence <= lastProgressSequence) {
					throw new Error('Fikeya plan progress did not match the bounded ordered schema.');
				}
				progressCount += 1;
				lastProgressSequence = progress.sequence;
				progressChannel.emit(progress);
				return;
			}
			if (finalValue) {
				throw new Error('Fikeya plan protocol emitted more than one result.');
			}
			finalValue = parsePlanView(value);
			if (!finalValue) {
				throw new Error('Fikeya plan result did not match the bounded schema.');
			}
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
		child.on('error', error => {
			if (requestedFailure) {
				finish({ ok: false, exitCode: null, failure: requestedFailure });
				return;
			}
			finish({
				ok: false,
				exitCode: null,
				failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'runtime-error'
			});
		});
		child.on('close', exitCode => {
			if (requestedFailure) {
				finish({ ok: false, exitCode, failure: requestedFailure });
				return;
			}
			if (buffered.length !== 0) {
				const finalLine = buffered;
				buffered = Buffer.alloc(0);
				processing = processing.then(() => processLine(finalLine));
			}
			void processing.then(() => {
				if (settled) {
					return;
				}
				if (exitCode === null || !acceptedExitCodes.includes(exitCode)) {
					finish({ ok: false, exitCode, failure: 'runtime-error' });
					return;
				}
				if (!finalValue) {
					finish({ ok: false, exitCode, failure: 'invalid-json' });
					return;
				}
				finish({ ok: true, exitCode, value: finalValue, failure: 'none' });
			}).catch(() => finish({ ok: false, exitCode, failure: 'invalid-json' }));
		});

		timeout = setTimeout(() => stop('timeout'), timeoutMilliseconds);
	});
	return { result, onProgress: progressChannel.onProgress, cancel: () => cancelOperation() };
}

function startAgentProtocolCli(
	args: readonly string[],
	workspacePath: string,
	prompt: string,
	history: readonly FikeyaProviderHistoryMessage[],
	approvalHandler: FikeyaAgentApprovalHandler,
	timeoutMilliseconds: number,
	outputLimitBytes: number,
	invocation: FikeyaCliInvocation,
	environment: NodeJS.ProcessEnv
): FikeyaAgentRunHandle {
	let cancelOperation = (): void => undefined;
	const progressChannel = createProgressChannel();
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
		let requestedFailure: FikeyaRuntimeFailure | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let forcedFinish: NodeJS.Timeout | undefined;
		let processing = Promise.resolve();
		let progressCount = 0;
		let lastProgressSequence = -1;

		const finish = (operationResult: FikeyaCliResult<FikeyaAgentTurn>): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			if (forcedFinish) {
				clearTimeout(forcedFinish);
			}
			progressChannel.close();
			resolve(operationResult);
		};
		const stop = (failure: FikeyaRuntimeFailure): void => {
			if (settled || requestedFailure) {
				return;
			}
			requestedFailure = failure;
			terminateChildTree(child);
			forcedFinish = setTimeout(() => finish({ ok: false, exitCode: null, failure }), processTerminationGraceMilliseconds);
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
				const progress = parseRunProgress(record);
				if (!progress
					|| progressCount >= maximumProgressEvents
					|| progress.sequence <= lastProgressSequence) {
					throw new Error('Fikeya coding progress did not match the bounded ordered schema.');
				}
				progressCount += 1;
				lastProgressSequence = progress.sequence;
				progressChannel.emit(progress);
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
			if (requestedFailure) {
				finish({ ok: false, exitCode: null, failure: requestedFailure });
				return;
			}
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
				if (requestedFailure) {
					finish({ ok: false, exitCode, failure: requestedFailure });
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

		void writeMessage({ type: 'start', prompt, history }).catch(() => stop('runtime-error'));
		timeout = setTimeout(() => stop('timeout'), timeoutMilliseconds);
	});
	return { result, onProgress: progressChannel.onProgress, cancel: () => cancelOperation() };
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

function parseRunProgress(record: Record<string, unknown>): FikeyaRunProgress | undefined {
	const event = strictBoundedString(record.event, 80);
	const stage = strictBoundedString(record.stage, 80);
	if (record.type !== 'progress'
		|| !hasExactRecordKeys(record, ['event', 'sequence', 'stage', 'type'])
		|| !event || !identifierPattern.test(event)
		|| !stage || !identifierPattern.test(stage)
		|| !isBoundedInteger(record.sequence, 0, 1_000_000_000)) {
		return undefined;
	}
	return { type: 'progress', event, stage, sequence: record.sequence };
}

function isValidProviderHistory(value: readonly FikeyaProviderHistoryMessage[]): boolean {
	if (!Array.isArray(value) || value.length > 12) {
		return false;
	}
	let totalCharacters = 0;
	for (const candidate of value as readonly unknown[]) {
		const record = asRecord(candidate);
		const role = record?.role;
		const content = strictBoundedString(record?.content, 16_000);
		if (!record
			|| !hasExactRecordKeys(record, ['content', 'role'])
			|| (role !== 'assistant' && role !== 'user')
			|| !content?.trim()) {
			return false;
		}
		totalCharacters += content.length;
		if (totalCharacters > 64_000) {
			return false;
		}
	}
	return value.length === 0 || value[0].role === 'user';
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

function strictBoundedUtf8String(value: unknown, maximumBytes: number): string | undefined {
	return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximumBytes ? value : undefined;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isBoundedFiniteNumber(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
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
