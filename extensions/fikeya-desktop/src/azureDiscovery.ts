/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';

export interface AzureSubscription {
	readonly id: string;
	readonly name: string;
}

export interface AzureOpenAIResource {
	readonly name: string;
	readonly resourceGroup: string;
	readonly endpoint: string;
}

export interface AzureOpenAIDeployment {
	readonly name: string;
	readonly model: string;
	readonly version?: string;
}

const maximumAzureOutputBytes = 2 * 1024 * 1024;
const azureTimeoutMs = 30_000;

export async function listAzureSubscriptions(): Promise<readonly AzureSubscription[]> {
	const value = await runAzureJson([
		'account', 'list', '--only-show-errors', '--query', "[?state=='Enabled'].{id:id,name:name}", '--output', 'json'
	]);
	return parseAzureSubscriptions(value);
}

export async function listAzureOpenAIResources(subscriptionId: string): Promise<readonly AzureOpenAIResource[]> {
	assertAzureIdentifier(subscriptionId, 'subscription');
	const value = await runAzureJson([
		'cognitiveservices', 'account', 'list', '--subscription', subscriptionId, '--only-show-errors',
		'--query', "[?kind=='OpenAI'].{name:name,resourceGroup:resourceGroup,endpoint:properties.endpoint}", '--output', 'json'
	]);
	return parseAzureOpenAIResources(value);
}

export async function listAzureOpenAIDeployments(
	subscriptionId: string,
	resourceGroup: string,
	accountName: string
): Promise<readonly AzureOpenAIDeployment[]> {
	assertAzureIdentifier(subscriptionId, 'subscription');
	assertAzureIdentifier(resourceGroup, 'resource group');
	assertAzureIdentifier(accountName, 'account');
	const value = await runAzureJson([
		'cognitiveservices', 'account', 'deployment', 'list', '--subscription', subscriptionId,
		'--resource-group', resourceGroup, '--name', accountName, '--only-show-errors',
		'--query', '[].{name:name,model:properties.model.name,version:properties.model.version}', '--output', 'json'
	]);
	return parseAzureOpenAIDeployments(value);
}

export function parseAzureSubscriptions(value: unknown): readonly AzureSubscription[] {
	return parseArray(value, item => {
		const record = asRecord(item);
		return record && isBoundedString(record.id, 256) && isBoundedString(record.name, 256)
			? { id: record.id, name: record.name }
			: undefined;
	});
}

export function parseAzureOpenAIResources(value: unknown): readonly AzureOpenAIResource[] {
	return parseArray(value, item => {
		const record = asRecord(item);
		if (!record || !isBoundedString(record.name, 256) || !isBoundedString(record.resourceGroup, 256) || !isHttpsUrl(record.endpoint)) {
			return undefined;
		}
		return { name: record.name, resourceGroup: record.resourceGroup, endpoint: normalizeEndpoint(record.endpoint) };
	});
}

export function parseAzureOpenAIDeployments(value: unknown): readonly AzureOpenAIDeployment[] {
	return parseArray(value, item => {
		const record = asRecord(item);
		if (!record || !isBoundedString(record.name, 256) || !isBoundedString(record.model, 256)) {
			return undefined;
		}
		return {
			name: record.name,
			model: record.model,
			version: isBoundedString(record.version, 256) ? record.version : undefined
		};
	});
}

function runAzureJson(arguments_: readonly string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile('az', [...arguments_], {
			windowsHide: true,
			timeout: azureTimeoutMs,
			maxBuffer: maximumAzureOutputBytes,
			encoding: 'utf8',
			env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: 'true' }
		}, (error, stdout) => {
			if (error) {
				reject(new Error('Azure CLI discovery failed. Sign in with az login and verify access to the selected subscription.'));
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(new Error('Azure CLI returned an invalid discovery response.'));
			}
		});
	});
}

function parseArray<T>(value: unknown, parser: (item: unknown) => T | undefined): readonly T[] {
	if (!Array.isArray(value) || value.length > 1_000) {
		return [];
	}
	const parsed = value.map(parser);
	return parsed.every((item): item is T => item !== undefined) ? parsed : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value);
}

function isHttpsUrl(value: unknown): value is string {
	if (!isBoundedString(value, 2_048)) {
		return false;
	}
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

function normalizeEndpoint(value: string): string {
	return value.replace(/\/+$/, '');
}

function assertAzureIdentifier(value: string, label: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._()\-]{0,255}$/.test(value)) {
		throw new Error(`Azure ${label} identifier is invalid.`);
	}
}
