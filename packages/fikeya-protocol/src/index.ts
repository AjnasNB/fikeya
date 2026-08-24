/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fikeya contributors. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in this package for information.
 *--------------------------------------------------------------------------------------------*/

export const protocolVersion = '1.0.0' as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type FikeyaMode = 'editor' | 'agent' | 'terminal' | 'review';
export type FikeyaLayout = 'studio' | 'agent-focus';

export type LifecycleEventType =
	| 'session.started'
	| 'prompt.submitted'
	| 'plan.updated'
	| 'context.prepared'
	| 'model.requested'
	| 'model.completed'
	| 'tool.requested'
	| 'approval.requested'
	| 'approval.decided'
	| 'tool.started'
	| 'tool.completed'
	| 'compaction.started'
	| 'compaction.completed'
	| 'artifact.created'
	| 'decision.recorded'
	| 'summary.recorded'
	| 'turn.completed'
	| 'session.ended';

export interface EvidenceReference {
	readonly algorithm: 'sha256';
	readonly digest: string;
	readonly mediaType?: string;
	readonly sizeBytes?: number;
}

export interface QarinahReference {
	readonly eventId: string;
	readonly eventHash: string;
}

export interface UsageReceipt {
	readonly usageMeasurement: 'provider-reported' | 'unavailable';
	readonly provider: string;
	readonly model: string;
	readonly apiMode: 'responses' | 'chat-completions';
	readonly callId: string;
	readonly requestId?: string;
	readonly inputTokens: number | null;
	readonly cachedInputTokens: number | null;
	readonly outputTokens: number | null;
	readonly requestBytes: number;
	readonly responseBytes: number;
	readonly requestSha256: string;
	readonly responseSha256: string;
	readonly statusCode: number;
	readonly durationMs: number;
	readonly createdAt: string;
}

export interface LifecycleEvent {
	readonly protocolVersion: typeof protocolVersion;
	readonly id: string;
	readonly type: LifecycleEventType;
	readonly occurredAt: string;
	readonly workspaceId: string;
	readonly sessionId: string;
	readonly turnId?: string;
	readonly parentId?: string;
	readonly payload: Readonly<Record<string, JsonValue>>;
	readonly evidence?: readonly EvidenceReference[];
	readonly qarinah?: QarinahReference;
}

export interface ClientCapabilities {
	readonly modes: readonly FikeyaMode[];
	readonly layouts: readonly FikeyaLayout[];
	readonly approvals: boolean;
	readonly cancellation: boolean;
	readonly resume: boolean;
	readonly fork: boolean;
	readonly acp: boolean;
	readonly mcp: boolean;
}

export interface RuntimeCapabilities {
	readonly providers: readonly string[];
	readonly tools: readonly string[];
	readonly memory: boolean;
	readonly worktrees: boolean;
	readonly browser: boolean;
	readonly crawler: boolean;
}

export interface InitializeParams {
	readonly protocolVersion: typeof protocolVersion;
	readonly workspaceRoot: string;
	readonly client: ClientCapabilities;
}

export interface InitializeResult {
	readonly protocolVersion: typeof protocolVersion;
	readonly workspaceId: string;
	readonly runtime: RuntimeCapabilities;
}

export interface ApprovalRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly tool: string;
	readonly permission: 'read' | 'write' | 'process' | 'destructive' | 'network';
	readonly summary: string;
	readonly operation: Readonly<Record<string, JsonValue>>;
	readonly expiresAt: string;
}

export interface ApprovalDecision {
	readonly requestId: string;
	readonly decision: 'allow-once' | 'deny';
	readonly decidedAt: string;
}

export interface RequestMessage {
	readonly jsonrpc: '2.0';
	readonly id: string;
	readonly method: string;
	readonly params?: JsonValue;
}

export interface NotificationMessage {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: JsonValue;
}

export interface ResponseMessage {
	readonly jsonrpc: '2.0';
	readonly id: string;
	readonly result?: JsonValue;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data?: JsonValue;
	};
}

export type ProtocolMessage = NotificationMessage | RequestMessage | ResponseMessage;

export function isProtocolMessage(value: unknown): value is ProtocolMessage {
	if (!isRecord(value) || value.jsonrpc !== '2.0') {
		return false;
	}

	if ('method' in value) {
		return typeof value.method === 'string' && (!('id' in value) || typeof value.id === 'string');
	}

	return typeof value.id === 'string' && ('result' in value || 'error' in value);
}

export function isLifecycleEvent(value: unknown): value is LifecycleEvent {
	if (!isRecord(value)) {
		return false;
	}

	return value.protocolVersion === protocolVersion
		&& typeof value.id === 'string'
		&& typeof value.type === 'string'
		&& lifecycleEventTypes.has(value.type)
		&& typeof value.occurredAt === 'string'
		&& typeof value.workspaceId === 'string'
		&& typeof value.sessionId === 'string'
		&& isRecord(value.payload);
}

export function isUsageReceipt(value: unknown): value is UsageReceipt {
	if (!isRecord(value)
		|| (value.usageMeasurement !== 'provider-reported' && value.usageMeasurement !== 'unavailable')
		|| typeof value.provider !== 'string'
		|| typeof value.model !== 'string'
		|| (value.apiMode !== 'responses' && value.apiMode !== 'chat-completions')
		|| typeof value.callId !== 'string'
		|| !isOptionalString(value.requestId)
		|| !isNullableNonNegativeInteger(value.inputTokens)
		|| !isNullableNonNegativeInteger(value.cachedInputTokens)
		|| !isNullableNonNegativeInteger(value.outputTokens)
		|| !isNonNegativeInteger(value.requestBytes)
		|| !isNonNegativeInteger(value.responseBytes)
		|| !isSha256(value.requestSha256)
		|| !isSha256(value.responseSha256)
		|| !Number.isInteger(value.statusCode)
		|| (value.statusCode as number) < 100
		|| (value.statusCode as number) > 599
		|| !isNonNegativeInteger(value.durationMs)
		|| typeof value.createdAt !== 'string') {
		return false;
	}

	const tokens = [value.inputTokens, value.cachedInputTokens, value.outputTokens];
	return value.usageMeasurement === 'provider-reported'
		? tokens.every(token => token !== null)
		: tokens.every(token => token === null);
}

const lifecycleEventTypes: ReadonlySet<string> = new Set<LifecycleEventType>([
	'session.started',
	'prompt.submitted',
	'plan.updated',
	'context.prepared',
	'model.requested',
	'model.completed',
	'tool.requested',
	'approval.requested',
	'approval.decided',
	'tool.started',
	'tool.completed',
	'compaction.started',
	'compaction.completed',
	'artifact.created',
	'decision.recorded',
	'summary.recorded',
	'turn.completed',
	'session.ended'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
	return value === null || isNonNegativeInteger(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

