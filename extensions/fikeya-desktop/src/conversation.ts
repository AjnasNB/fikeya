/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export type FikeyaConversationRole = 'user' | 'assistant' | 'notice';

export interface FikeyaConversationAttachment {
	readonly kind?: 'image' | 'text';
	readonly name: string;
	readonly mimeType: string;
	readonly relativePath?: string;
	readonly sizeBytes: number;
	readonly sha256: string;
}

/** Content-minimal file identity retained with an opted-in local conversation. */
export interface FikeyaConversationChangedFileEvidence {
	readonly path: string;
	readonly operation: 'add' | 'edit' | 'delete';
	readonly beforeExists: boolean;
	readonly afterExists: boolean;
	readonly beforeSha256: string | null;
	readonly afterSha256: string | null;
	readonly beforeBytes: number | null;
	readonly afterBytes: number | null;
	readonly linesAdded: number | null;
	readonly linesDeleted: number | null;
	readonly lineDeltaStatus: 'exact' | 'binary' | 'too-large' | 'unavailable';
}

/**
 * Bounded terminal evidence attached to the answer that produced it. This deliberately retains
 * file metadata only: file contents, tool output, prompts, and provider receipts are excluded.
 */
export interface FikeyaConversationRunEvidence {
	readonly schemaVersion: 1;
	readonly status: 'completed' | 'cancelled' | 'failed';
	readonly changedFilesScope: 'regular-project-files-v1' | 'legacy-unspecified';
	readonly measuredChangedFileCount: number;
	readonly accountingIncomplete: boolean;
	readonly projectionTruncated: boolean;
	readonly changedFiles: readonly FikeyaConversationChangedFileEvidence[];
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
	/** Bounded changed-file metadata; never projected into provider history. */
	readonly runEvidence?: FikeyaConversationRunEvidence;
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
const maximumRunEvidenceChangedFiles = 32;
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
 * store. Conversation content and bounded changed-file metadata remain process-local unless the
 * developer explicitly enables workspace history; the longer-lived project ledger belongs to
 * Qarinah and authoritative execution metadata belongs to Fikeya Runtime.
 */
export function appendConversationMessage(
	messages: readonly FikeyaConversationMessage[],
	message: FikeyaConversationMessage
): readonly FikeyaConversationMessage[] {
	const { runEvidence: untrustedRunEvidence, ...messageWithoutRunEvidence } = message;
	const runEvidence = normalizeRunEvidence(untrustedRunEvidence, false);
	const boundedMessage = {
		...messageWithoutRunEvidence,
		content: boundMessageContent(message.content),
		...(runEvidence === undefined ? {} : { runEvidence })
	};
	if (boundedMessage.role === 'assistant' && hasAssistantDuplicateInCurrentTurn(messages, boundedMessage)) {
		return messages;
	}
	const retained = [...messages.slice(-(maximumMessages - 1)), boundedMessage];
	let totalCharacters = retained.reduce((total, item) => total + conversationMessageWeight(item), 0);
	while (retained.length > 1 && totalCharacters > maximumConversationCharacters) {
		const removed = retained.shift();
		totalCharacters -= removed ? conversationMessageWeight(removed) : 0;
	}
	return retained;
}

/**
 * Projects one validated runtime outcome into a small local-history attachment. The runtime may
 * report up to 1,000 measured entries; conversation history retains at most 32 and says so.
 */
export function projectConversationRunEvidence(input: {
	readonly status: FikeyaConversationRunEvidence['status'];
	readonly outcome: {
		readonly changedFilesScope: FikeyaConversationRunEvidence['changedFilesScope'];
		readonly changedFilesTruncated: boolean;
		readonly changedFiles: readonly FikeyaConversationChangedFileEvidence[];
	};
}): FikeyaConversationRunEvidence {
	const changedFiles = input.outcome.changedFiles.slice(0, maximumRunEvidenceChangedFiles).map(file => ({ ...file }));
	return {
		schemaVersion: 1,
		status: input.status,
		changedFilesScope: input.outcome.changedFilesScope,
		measuredChangedFileCount: input.outcome.changedFiles.length,
		accountingIncomplete: input.outcome.changedFilesTruncated,
		projectionTruncated: changedFiles.length !== input.outcome.changedFiles.length,
		changedFiles
	};
}

/** Applies the persistence toggle without receiving or mutating the process-local conversation. */
export async function clearPersistedConversationSnapshotIfDisabled(
	persistenceEnabled: boolean,
	clearSnapshot: () => PromiseLike<void>
): Promise<boolean> {
	if (persistenceEnabled) {
		return false;
	}
	await clearSnapshot();
	return true;
}

/** Prevents parallel providers or repeated completion events from rendering one answer twice. */
function hasAssistantDuplicateInCurrentTurn(messages: readonly FikeyaConversationMessage[], message: FikeyaConversationMessage): boolean {
	const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
	const comparableContent = normalizeComparableAnswer(message.content);
	const comparableEvidence = JSON.stringify(message.runEvidence ?? null);
	return messages.slice(lastUserIndex + 1).some(candidate =>
		candidate.role === 'assistant'
		&& normalizeComparableAnswer(candidate.content) === comparableContent
		&& JSON.stringify(candidate.runEvidence ?? null) === comparableEvidence
	);
}

function normalizeComparableAnswer(content: string): string {
	return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Serializes a bounded, versioned snapshot suitable for workspace-scoped persistence. Message
 * content and run-evidence paths receive best-effort known-pattern sanitization; attachment
 * metadata is not secret-scanned and unknown formats may remain.
 */
export function serializeConversationState(messages: readonly FikeyaConversationMessage[]): string {
	const retained = [...boundConversationMessages(messages.flatMap(message => {
		const normalized = normalizeConversationMessage(message, true);
		return normalized ? [normalized] : [];
	}))];
	let snapshot: FikeyaConversationSnapshot = {
		schemaVersion: 1,
		messages: retained
	};
	let serialized = JSON.stringify(snapshot);
	while (serialized.length > maximumSerializedCharacters && retained.length > 1) {
		retained.shift();
		snapshot = { schemaVersion: 1, messages: retained };
		serialized = JSON.stringify(snapshot);
	}
	return serialized;
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
	let totalCharacters = retained.reduce((total, item) => total + conversationMessageWeight(item), 0);
	while (retained.length > 1 && totalCharacters > maximumConversationCharacters) {
		const removed = retained.shift();
		totalCharacters -= removed ? conversationMessageWeight(removed) : 0;
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
	const runEvidence = normalizeRunEvidence(value.runEvidence, redact);
	if (attachments === undefined || (value.runEvidence !== undefined && runEvidence === undefined)) {
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
		...(attachments.length === 0 ? {} : { attachments }),
		...(runEvidence === undefined ? {} : { runEvidence })
	};
}

function normalizeRunEvidence(value: unknown, redact: boolean): FikeyaConversationRunEvidence | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)
		|| Object.keys(value).some(key => !['accountingIncomplete', 'changedFiles', 'changedFilesScope', 'measuredChangedFileCount', 'projectionTruncated', 'schemaVersion', 'status'].includes(key))
		|| value.schemaVersion !== 1
		|| (value.status !== 'completed' && value.status !== 'cancelled' && value.status !== 'failed')
		|| (value.changedFilesScope !== 'regular-project-files-v1' && value.changedFilesScope !== 'legacy-unspecified')
		|| !isBoundedInteger(value.measuredChangedFileCount, 0, 1_000)
		|| typeof value.accountingIncomplete !== 'boolean'
		|| typeof value.projectionTruncated !== 'boolean'
		|| !Array.isArray(value.changedFiles)
		|| value.changedFiles.length > maximumRunEvidenceChangedFiles
		|| (value.measuredChangedFileCount > 0 && value.changedFiles.length === 0)
		|| value.measuredChangedFileCount < value.changedFiles.length
		|| value.projectionTruncated !== (value.measuredChangedFileCount > value.changedFiles.length)) {
		return undefined;
	}
	const changedFiles: FikeyaConversationChangedFileEvidence[] = [];
	for (const candidate of value.changedFiles) {
		const file = normalizeChangedFileEvidence(candidate, redact);
		if (!file) {
			return undefined;
		}
		changedFiles.push(file);
	}
	if (new Set(changedFiles.map(file => file.path)).size !== changedFiles.length) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		status: value.status,
		changedFilesScope: value.changedFilesScope,
		measuredChangedFileCount: value.measuredChangedFileCount,
		accountingIncomplete: value.accountingIncomplete,
		projectionTruncated: value.projectionTruncated,
		changedFiles
	};
}

function normalizeChangedFileEvidence(value: unknown, redact: boolean): FikeyaConversationChangedFileEvidence | undefined {
	if (!isRecord(value)
		|| Object.keys(value).some(key => !['afterBytes', 'afterExists', 'afterSha256', 'beforeBytes', 'beforeExists', 'beforeSha256', 'lineDeltaStatus', 'linesAdded', 'linesDeleted', 'operation', 'path'].includes(key))) {
		return undefined;
	}
	const rawPath = typeof value.path === 'string' && value.path.length <= 4_096 ? value.path : undefined;
	const filePath = rawPath === undefined ? undefined : redact ? redactConversationContent(rawPath) : rawPath;
	const beforeSha256 = normalizeSha256(value.beforeSha256);
	const afterSha256 = normalizeSha256(value.afterSha256);
	const beforeBytes = normalizeNullableByteCount(value.beforeBytes);
	const afterBytes = normalizeNullableByteCount(value.afterBytes);
	const linesAdded = normalizeNullableLineCount(value.linesAdded);
	const linesDeleted = normalizeNullableLineCount(value.linesDeleted);
	const beforeExists = value.beforeExists;
	const afterExists = value.afterExists;
	const operation = value.operation;
	const lineDeltaStatus = value.lineDeltaStatus;
	const beforeIdentityPresent = beforeSha256 !== null && beforeSha256 !== undefined || beforeBytes !== null && beforeBytes !== undefined;
	const afterIdentityPresent = afterSha256 !== null && afterSha256 !== undefined || afterBytes !== null && afterBytes !== undefined;
	const inferredOperation = beforeExists === false && afterExists === true
		? 'add'
		: beforeExists === true && afterExists === false
			? 'delete'
			: beforeExists === true && afterExists === true
				? 'edit'
				: undefined;
	if (!filePath || filePath.includes('\\') || filePath.startsWith('/') || filePath.split('/').includes('..')
		|| (operation !== 'add' && operation !== 'edit' && operation !== 'delete')
		|| operation !== inferredOperation
		|| typeof beforeExists !== 'boolean' || typeof afterExists !== 'boolean'
		|| beforeSha256 === undefined || afterSha256 === undefined
		|| beforeBytes === undefined || afterBytes === undefined
		|| linesAdded === undefined || linesDeleted === undefined
		|| (!beforeExists && beforeIdentityPresent) || (!afterExists && afterIdentityPresent)
		|| (operation === 'edit' && !beforeIdentityPresent && !afterIdentityPresent)
		|| (lineDeltaStatus !== 'exact' && lineDeltaStatus !== 'binary' && lineDeltaStatus !== 'too-large' && lineDeltaStatus !== 'unavailable')
		|| (lineDeltaStatus === 'exact' && (linesAdded === null || linesDeleted === null))
		|| (lineDeltaStatus !== 'exact' && (linesAdded !== null || linesDeleted !== null))
		|| (operation === 'add' && linesDeleted !== null && linesDeleted !== 0)
		|| (operation === 'delete' && linesAdded !== null && linesAdded !== 0)
		|| (operation === 'edit' && beforeSha256 !== null && beforeSha256 === afterSha256)) {
		return undefined;
	}
	return {
		path: filePath,
		operation,
		beforeExists,
		afterExists,
		beforeSha256,
		afterSha256,
		beforeBytes,
		afterBytes,
		linesAdded,
		linesDeleted,
		lineDeltaStatus
	};
}

function normalizeSha256(value: unknown): string | null | undefined {
	return value === null
		? null
		: typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
			? value
			: undefined;
}

function normalizeNullableByteCount(value: unknown): number | null | undefined {
	return value === null ? null : isBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER) ? value : undefined;
}

function normalizeNullableLineCount(value: unknown): number | null | undefined {
	return value === null ? null : isBoundedInteger(value, 0, 1_000_000_000) ? value : undefined;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function conversationMessageWeight(message: FikeyaConversationMessage): number {
	return message.content.length + (message.runEvidence ? JSON.stringify(message.runEvidence).length : 0);
}

function normalizeAttachments(value: unknown): readonly FikeyaConversationAttachment[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 12) {
		return undefined;
	}
	const attachments: FikeyaConversationAttachment[] = [];
	for (const item of value) {
		if (!isRecord(item)
			|| Object.keys(item).some(key => !['kind', 'mimeType', 'name', 'relativePath', 'sha256', 'sizeBytes'].includes(key))
			|| typeof item.name !== 'string'
			|| item.name.length < 1
			|| item.name.length > 160
			|| (item.kind !== undefined && item.kind !== 'image' && item.kind !== 'text')
			|| typeof item.mimeType !== 'string'
			|| typeof item.sizeBytes !== 'number'
			|| !Number.isSafeInteger(item.sizeBytes)
			|| item.sizeBytes < 1
			|| typeof item.sha256 !== 'string'
			|| !/^sha256:[0-9a-f]{64}$/u.test(item.sha256)) {
			return undefined;
		}
		const kind = item.kind ?? (/^image\/(?:gif|jpeg|png|webp)$/u.test(item.mimeType) ? 'image' : undefined);
		const validImage = kind === 'image'
			&& /^image\/(?:gif|jpeg|png|webp)$/u.test(item.mimeType)
			&& item.sizeBytes <= 393_216
			&& item.relativePath === undefined;
		const validText = kind === 'text'
			&& /^(?:text\/[a-z0-9.+-]+|application\/(?:json|ld\+json|javascript|sql|toml|xml|x-httpd-php|x-powershell|x-sh|x-yaml))$/u.test(item.mimeType)
			&& item.sizeBytes <= 98_304
			&& typeof item.relativePath === 'string'
			&& item.relativePath.length >= 1
			&& item.relativePath.length <= 512
			&& !item.relativePath.includes('\\')
			&& !item.relativePath.startsWith('/')
			&& !item.relativePath.split('/').some(part => !part || part === '.' || part === '..');
		if (!validImage && !validText) {
			return undefined;
		}
		attachments.push({
			...(item.kind === undefined ? {} : { kind }),
			name: item.name,
			mimeType: item.mimeType,
			...(typeof item.relativePath === 'string' ? { relativePath: item.relativePath } : {}),
			sizeBytes: item.sizeBytes,
			sha256: item.sha256
		});
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
