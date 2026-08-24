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
	readonly measurement: 'provider' | 'tokenizer' | 'estimate';
	readonly provider: string;
	readonly model: string;
	readonly requestId?: string;
	readonly inputTokens: number;
	readonly cachedInputTokens?: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly cost?: {
		readonly amount: number;
		readonly currency: string;
	};
	readonly pricingRevision?: string;
	readonly startedAt: string;
	readonly completedAt: string;
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

