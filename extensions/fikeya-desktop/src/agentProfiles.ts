/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import type { FikeyaMemoryMode } from './runtime';

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const maximumAgentProfiles = 32;
const maximumDisplayNameCharacters = 80;
const maximumInstructionCharacters = 8_192;
const profileKeys = new Set([
	'schemaVersion',
	'id',
	'displayName',
	'providerName',
	'role',
	'instruction',
	'maxOutputTokens',
	'contextMaxCharacters',
	'memoryMode'
]);

export type FikeyaAgentRole = 'general' | 'planner' | 'researcher' | 'reviewer' | 'debugger' | 'custom';

export interface FikeyaAgentProfile {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly displayName: string;
	readonly providerName: string;
	readonly role: FikeyaAgentRole;
	readonly instruction: string;
	readonly maxOutputTokens: number;
	readonly contextMaxCharacters: number;
	readonly memoryMode: FikeyaMemoryMode;
}

export interface FikeyaAgentProfileState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

/** Stores validated agent profiles in a host-owned state backend such as VS Code workspace state. */
export class FikeyaAgentProfileStore {
	private static readonly storageKey = 'fikeya.agents.profiles.v1';

	constructor(private readonly state: FikeyaAgentProfileState) { }

	load(): readonly FikeyaAgentProfile[] {
		return parseFikeyaAgentProfiles(this.state.get<unknown>(FikeyaAgentProfileStore.storageKey));
	}

	async replace(profiles: readonly FikeyaAgentProfile[]): Promise<readonly FikeyaAgentProfile[]> {
		const validated = parseFikeyaAgentProfiles(profiles);
		if (validated.length !== profiles.length) {
			throw new Error('One or more Fikeya agent profiles are invalid.');
		}
		await this.state.update(FikeyaAgentProfileStore.storageKey, validated);
		return validated;
	}

	async upsert(profile: FikeyaAgentProfile): Promise<readonly FikeyaAgentProfile[]> {
		const validated = parseFikeyaAgentProfile(profile);
		if (!validated) {
			throw new Error('The Fikeya agent profile is invalid.');
		}
		const profiles = [...this.load()];
		const existingIndex = profiles.findIndex(candidate => candidate.id === validated.id);
		if (existingIndex >= 0) {
			profiles[existingIndex] = validated;
		} else {
			if (profiles.length >= maximumAgentProfiles) {
				throw new Error(`Fikeya supports at most ${maximumAgentProfiles} configured agents per workspace.`);
			}
			profiles.push(validated);
		}
		await this.state.update(FikeyaAgentProfileStore.storageKey, profiles);
		return profiles;
	}

	async remove(profileId: string): Promise<readonly FikeyaAgentProfile[]> {
		if (!identifierPattern.test(profileId)) {
			throw new Error('The Fikeya agent profile identifier is invalid.');
		}
		const profiles = this.load().filter(profile => profile.id !== profileId);
		await this.state.update(FikeyaAgentProfileStore.storageKey, profiles);
		return profiles;
	}
}

/** Parses bounded, versioned agent profiles without accepting credential or provider response data. */
export function parseFikeyaAgentProfiles(value: unknown): readonly FikeyaAgentProfile[] {
	if (!Array.isArray(value) || value.length > maximumAgentProfiles) {
		return [];
	}
	const profiles: FikeyaAgentProfile[] = [];
	const identifiers = new Set<string>();
	for (const candidate of value) {
		const profile = parseFikeyaAgentProfile(candidate);
		if (!profile || identifiers.has(profile.id)) {
			return [];
		}
		identifiers.add(profile.id);
		profiles.push(profile);
	}
	return profiles;
}

/** Parses one bounded agent profile. Credentials remain owned by its referenced provider profile. */
export function parseFikeyaAgentProfile(value: unknown): FikeyaAgentProfile | undefined {
	if (!isRecord(value)
		|| Object.keys(value).some(key => !profileKeys.has(key))
		|| value.schemaVersion !== 1
		|| typeof value.id !== 'string'
		|| !identifierPattern.test(value.id)
		|| typeof value.displayName !== 'string'
		|| !isBoundedText(value.displayName, maximumDisplayNameCharacters, false)
		|| typeof value.providerName !== 'string'
		|| !identifierPattern.test(value.providerName)
		|| !isAgentRole(value.role)
		|| typeof value.instruction !== 'string'
		|| !isBoundedText(value.instruction, maximumInstructionCharacters, true)
		|| !isBoundedInteger(value.maxOutputTokens, 1, 32_768)
		|| !isBoundedInteger(value.contextMaxCharacters, 512, 64_000)
		|| !isMemoryMode(value.memoryMode)) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		id: value.id,
		displayName: value.displayName.trim(),
		providerName: value.providerName,
		role: value.role,
		instruction: value.instruction.trim(),
		maxOutputTokens: value.maxOutputTokens,
		contextMaxCharacters: value.contextMaxCharacters,
		memoryMode: value.memoryMode
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentRole(value: unknown): value is FikeyaAgentRole {
	return typeof value === 'string' && ['general', 'planner', 'researcher', 'reviewer', 'debugger', 'custom'].includes(value);
}

function isMemoryMode(value: unknown): value is FikeyaMemoryMode {
	return typeof value === 'string' && ['auto', 'off', 'required'].includes(value);
}

function isBoundedText(value: string, maximumCharacters: number, allowEmpty: boolean): boolean {
	const trimmed = value.trim();
	return (allowEmpty || trimmed.length > 0) && trimmed.length <= maximumCharacters;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
