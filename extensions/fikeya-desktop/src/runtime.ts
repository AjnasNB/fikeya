/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';

const maximumOutputBytes = 1024 * 1024;
const runtimeTimeoutMilliseconds = 30_000;

export type FikeyaRuntimeCommand = 'doctor' | 'init';

export interface FikeyaRuntimeResult {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly report?: FikeyaRuntimeReport;
	readonly failure: 'none' | 'not-found' | 'timeout' | 'output-limit' | 'runtime-error' | 'invalid-json';
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
	return typeof value === 'string' ? value.slice(0, maximumLength) : undefined;
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
