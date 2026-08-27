/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export type FikeyaConversationRole = 'user' | 'assistant' | 'notice';

export interface FikeyaConversationAttachment {
	readonly name: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly sha256: string;
}

export interface FikeyaConversationMessage {
	readonly id: string;
	readonly role: FikeyaConversationRole;
	readonly content: string;
	readonly createdAt: string;
	readonly providerName?: string;
	readonly tone?: 'normal' | 'error';
	/** Content-free metadata only. Raw attachment bytes are intentionally never persisted. */
	readonly attachments?: readonly FikeyaConversationAttachment[];
}

/** Roles that are safe to send through a provider conversation protocol. */
export type FikeyaProviderHistoryRole = Exclude<FikeyaConversationRole, 'notice'>;

/** One bounded provider-neutral turn projected from the local conversation. */
export interface FikeyaProviderHistoryMessage {
	readonly role: FikeyaProviderHistoryRole;
	readonly content: string;
}

/** Versioned durable representation owned by the Fikeya workspace. */
interface FikeyaConversationSnapshot {
	readonly schemaVersion: 1;
	readonly messages: readonly FikeyaConversationMessage[];
}

const maximumMessages = 48;
const maximumMessageCharacters = 240_000;
const maximumConversationCharacters = 960_000;
const maximumSerializedCharacters = 1_100_000;
const maximumIncomingMessages = maximumMessages * 4;
const maximumProviderHistoryMessages = 12;
const maximumProviderHistoryMessageCharacters = 16_000;
const maximumProviderHistoryCharacters = 64_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const providerIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hiddenControlCharactersPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const obviousCredentialPatterns: readonly RegExp[] = [
	/\b(?:sk-(?:or-v1-|ant-)?|nvapi-)[A-Za-z0-9_-]{16,}\b/gi,
	/\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];
const redactedCredential = '[REDACTED CREDENTIAL]';

/**
 * Keeps the live chat useful without turning the extension host into an unbounded transcript
 * store. Conversation content remains process-local unless the developer explicitly enables
 * workspace history; durable project evidence belongs to Qarinah and content-free execution
 * metadata belongs to Fikeya Runtime.
 */
export function appendConversationMessage(
	messages: readonly FikeyaConversationMessage[],
	message: FikeyaConversationMessage
): readonly FikeyaConversationMessage[] {
	const boundedMessage = {
		...message,
		content: boundMessageContent(message.content)
	};
	const retained = [...messages.slice(-(maximumMessages - 1)), boundedMessage];
	let totalCharacters = retained.reduce((total, item) => total + item.content.length, 0);
	while (retained.length > 1 && totalCharacters > maximumConversationCharacters) {
		const removed = retained.shift();
		totalCharacters -= removed?.content.length ?? 0;
	}
	return retained;
}

/**
 * Serializes a bounded, versioned snapshot suitable for workspace-scoped persistence. Obvious
 * credentials and control characters are removed before content crosses the durable boundary.
 */
export function serializeConversationState(messages: readonly FikeyaConversationMessage[]): string {
	const snapshot: FikeyaConversationSnapshot = {
		schemaVersion: 1,
		messages: boundConversationMessages(messages.flatMap(message => {
			const normalized = normalizeConversationMessage(message, true);
			return normalized ? [normalized] : [];
		}))
	};
	return JSON.stringify(snapshot);
}

/**
 * Parses a workspace snapshot without trusting its shape or prototypes. Corrupt, oversized, or
 * partially invalid snapshots fail closed instead of leaking unvalidated content into Chat.
 */
export function parseConversationState(serialized: string): readonly FikeyaConversationMessage[] {
	if (!serialized || serialized.length > maximumSerializedCharacters) {
		return [];
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return [];
	}
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.messages) || value.messages.length > maximumIncomingMessages) {
		return [];
	}
	const messages: FikeyaConversationMessage[] = [];
	for (const candidate of value.messages) {
		const message = normalizeConversationMessage(candidate, true);
		if (!message) {
			return [];
		}
		messages.push(message);
	}
	return boundConversationMessages(messages);
}

/**
 * Projects only user and assistant turns into a small provider-neutral history. Notices, local
 * status text, credentials, and control characters never enter the provider request history.
 */
export function projectProviderHistory(messages: readonly FikeyaConversationMessage[]): readonly FikeyaProviderHistoryMessage[] {
	const candidates = messages.flatMap(message => {
		if (message.role === 'notice') {
			return [];
		}
		const normalized = normalizeConversationMessage(message, true);
		if (!normalized || normalized.role === 'notice') {
			return [];
		}
		return [{
			role: normalized.role,
			content: boundProviderHistoryContent(normalized.content)
		} satisfies FikeyaProviderHistoryMessage];
	}).slice(-maximumProviderHistoryMessages);

	const retained: FikeyaProviderHistoryMessage[] = [];
	let totalCharacters = 0;
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (retained.length > 0 && totalCharacters + candidate.content.length > maximumProviderHistoryCharacters) {
			break;
		}
		retained.unshift(candidate);
		totalCharacters += candidate.content.length;
	}
	while (retained[0]?.role === 'assistant') {
		retained.shift();
	}
	return retained;
}

function boundConversationMessages(messages: readonly FikeyaConversationMessage[]): readonly FikeyaConversationMessage[] {
	const retained = messages.slice(-maximumMessages).map(message => ({
		...message,
		content: boundMessageContent(message.content)
	}));
	let totalCharacters = retained.reduce((total, item) => total + item.content.length, 0);
	while (retained.length > 1 && totalCharacters > maximumConversationCharacters) {
		const removed = retained.shift();
		totalCharacters -= removed?.content.length ?? 0;
	}
	return retained;
}

function normalizeConversationMessage(value: unknown, redact: boolean): FikeyaConversationMessage | undefined {
	if (!isRecord(value)
		|| typeof value.id !== 'string'
		|| !identifierPattern.test(value.id)
		|| !isConversationRole(value.role)
		|| typeof value.content !== 'string'
		|| value.content.trim().length === 0
		|| typeof value.createdAt !== 'string'
		|| !isIsoTimestamp(value.createdAt)
		|| (value.providerName !== undefined && (typeof value.providerName !== 'string' || !providerIdentifierPattern.test(value.providerName)))
		|| (value.tone !== undefined && value.tone !== 'normal' && value.tone !== 'error')) {
		return undefined;
	}
	const attachments = normalizeAttachments(value.attachments);
	if (attachments === undefined) {
		return undefined;
	}
	const redactedContent = redact ? redactConversationContent(value.content) : value.content;
	if (redactedContent.trim().length === 0) {
		return undefined;
	}
	const content = boundMessageContent(redactedContent);
	const providerName = typeof value.providerName === 'string' ? value.providerName : undefined;
	const tone = value.tone === 'normal' || value.tone === 'error' ? value.tone : undefined;
	return {
		id: value.id,
		role: value.role,
		content,
		createdAt: value.createdAt,
		...(providerName === undefined ? {} : { providerName }),
		...(tone === undefined ? {} : { tone }),
		...(attachments.length === 0 ? {} : { attachments })
	};
}

function normalizeAttachments(value: unknown): readonly FikeyaConversationAttachment[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 4) {
		return undefined;
	}
	const attachments: FikeyaConversationAttachment[] = [];
	for (const item of value) {
		if (!isRecord(item)
			|| Object.keys(item).some(key => !['mimeType', 'name', 'sha256', 'sizeBytes'].includes(key))
			|| typeof item.name !== 'string'
			|| item.name.length < 1
			|| item.name.length > 160
			|| typeof item.mimeType !== 'string'
			|| !/^image\/(?:gif|jpeg|png|webp)$/u.test(item.mimeType)
			|| typeof item.sizeBytes !== 'number'
			|| !Number.isSafeInteger(item.sizeBytes)
			|| item.sizeBytes < 1
			|| item.sizeBytes > 393_216
			|| typeof item.sha256 !== 'string'
			|| !/^sha256:[0-9a-f]{64}$/u.test(item.sha256)) {
			return undefined;
		}
		attachments.push({ name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256 });
	}
	return attachments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConversationRole(value: unknown): value is FikeyaConversationRole {
	return value === 'user' || value === 'assistant' || value === 'notice';
}

function isIsoTimestamp(value: string): boolean {
	if (value.length > 32) {
		return false;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function redactConversationContent(content: string): string {
	let redacted = content.replace(hiddenControlCharactersPattern, '');
	for (const pattern of obviousCredentialPatterns) {
		redacted = redacted.replace(pattern, redactedCredential);
	}
	return redacted;
}

function boundProviderHistoryContent(content: string): string {
	if (content.length <= maximumProviderHistoryMessageCharacters) {
		return content;
	}
	const marker = '\n\n[Earlier provider-history content truncated.]\n\n';
	const tailCharacters = 4_000;
	const headCharacters = maximumProviderHistoryMessageCharacters - marker.length - tailCharacters;
	return `${content.slice(0, headCharacters)}${marker}${content.slice(-tailCharacters)}`;
}

function boundMessageContent(content: string): string {
	if (content.length <= maximumMessageCharacters) {
		return content;
	}
	const marker = '\n\n[Conversation preview truncated. The execution receipt remains available.]';
	return `${content.slice(0, maximumMessageCharacters - marker.length)}${marker}`;
}
