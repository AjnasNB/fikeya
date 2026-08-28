/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

const maximumLeadPromptBytes = 250_000;
const maximumAdvisorOutputBytes = 32_000;
const reservedInstructionBytes = 1_200;

export interface FikeyaTeamAdvisorResult {
	readonly name: string;
	readonly role: string;
	readonly output: string;
}

/** Builds one bounded handoff from parallel read-only specialists to the approval-gated coding lead. */
export function buildTeamLeadPrompt(task: string, advisors: readonly FikeyaTeamAdvisorResult[]): string {
	const header = [
		'You are the lead coding agent for a Fikeya team run.',
		'Parallel specialists inspected the same workspace without write or process access.',
		'Use their findings as advisory input. Verify important claims yourself before editing or running commands.',
		'',
		'Original task:',
		truncateUtf8(task, maximumLeadPromptBytes - reservedInstructionBytes),
		'',
		'Specialist findings:'
	].join('\n');
	let prompt = header;
	for (const advisor of groupEquivalentAdvisorResults(advisors)) {
		const sectionHeader = `\n\n## ${advisor.names.join(' + ')} (${advisor.roles.join(', ')})\n`;
		const remaining = maximumLeadPromptBytes - reservedInstructionBytes - Buffer.byteLength(prompt + sectionHeader, 'utf8');
		if (remaining <= 0) {
			break;
		}
		prompt += sectionHeader + truncateUtf8(advisor.output, Math.min(maximumAdvisorOutputBytes, remaining));
	}
	const instruction = [
		'',
		'',
		'Lead responsibility:',
		'- Produce one coherent answer, not a transcript of specialist opinions.',
		'- Inspect the workspace and resolve conflicting findings.',
		'- Use the normal Fikeya tools for edits, commands, tests, and verification.',
		'- Every workspace or process action remains subject to an exact one-use approval.',
		'- State what changed, what was verified, and any remaining limitation.'
	].join('\n');
	return truncateUtf8(prompt, maximumLeadPromptBytes - Buffer.byteLength(instruction, 'utf8')) + instruction;
}

interface GroupedAdvisorResult {
	readonly names: string[];
	readonly roles: string[];
	readonly output: string;
}

/** Collapses equivalent specialist findings before they consume another lead-model token. */
function groupEquivalentAdvisorResults(advisors: readonly FikeyaTeamAdvisorResult[]): readonly GroupedAdvisorResult[] {
	const grouped: GroupedAdvisorResult[] = [];
	for (const advisor of advisors) {
		const output = advisor.output.replace(/\r\n/g, '\n').trim();
		const existing = grouped.find(candidate => candidate.output === output);
		if (existing) {
			if (!existing.names.includes(advisor.name)) {
				existing.names.push(advisor.name);
			}
			if (!existing.roles.includes(advisor.role)) {
				existing.roles.push(advisor.role);
			}
			continue;
		}
		grouped.push({ names: [advisor.name], roles: [advisor.role], output });
	}
	return grouped;
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
		return value;
	}
	let output = '';
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		if (bytes + characterBytes > Math.max(0, maximumBytes - 3)) {
			break;
		}
		output += character;
		bytes += characterBytes;
	}
	return `${output}...`;
}
