/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fikeya contributors. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
	appendEvent,
	approveWorkspaceTrust,
	buildDeveloperMemoryView,
	buildSessionContextReceipts,
	buildSymbolGraph,
	compileContext,
	initializeWorkspace,
	inspectWorkspacePolicy,
	listGitWorktrees,
	runCodingContextHarness,
	runProjectMemoryCycle,
	scanProjectStructure,
	searchSymbols,
	verifyStore
} from 'qarinah';

const qarinahKinds = new Set([
	'session.started',
	'prompt.submitted',
	'tool.requested',
	'tool.completed',
	'turn.completed',
	'compaction.started',
	'compaction.completed',
	'artifact',
	'source',
	'claim',
	'decision',
	'approval',
	'summary',
	'memory.scope.attached',
	'memory.scope.revoked',
	'context.pack.compiled'
]);

const eventKindMap = new Map([
	['session.started', 'session.started'],
	['prompt.submitted', 'prompt.submitted'],
	['plan.updated', 'summary'],
	['context.prepared', 'context.pack.compiled'],
	['model.requested', 'source'],
	['model.completed', 'source'],
	['tool.requested', 'tool.requested'],
	['approval.requested', 'approval'],
	['approval.decided', 'approval'],
	['tool.started', 'tool.requested'],
	['tool.completed', 'tool.completed'],
	['compaction.started', 'compaction.started'],
	['compaction.completed', 'compaction.completed'],
	['artifact.created', 'artifact'],
	['decision.recorded', 'decision'],
	['summary.recorded', 'summary'],
	['turn.completed', 'turn.completed'],
	['session.ended', 'turn.completed']
]);

export class MemoryPort {
	#root;
	#controllers = new Map();

	constructor(root) {
		if (typeof root !== 'string' || root.trim().length === 0) {
			throw new TypeError('A workspace root is required.');
		}

		const resolved = path.resolve(root);
		if (!path.isAbsolute(resolved)) {
			throw new TypeError('The workspace root must resolve to an absolute path.');
		}
		this.#root = resolved;
	}

	get root() {
		return this.#root;
	}

	cancel(requestId) {
		const controller = this.#controllers.get(requestId);
		if (!controller) {
			return false;
		}
		controller.abort();
		return true;
	}

	async dispatch(method, params = {}, requestId = '') {
		if (!isRecord(params)) {
			throw new TypeError('Request parameters must be an object.');
		}

		const controller = new AbortController();
		if (requestId) {
			this.#controllers.set(requestId, controller);
		}

		try {
			switch (method) {
				case 'memory.initialize':
					return this.#initialize(params);
				case 'memory.policy':
					return inspectWorkspacePolicy(this.#root);
				case 'memory.approve':
					return this.#approve(params);
				case 'memory.status':
					return this.#status();
				case 'memory.record':
					return this.#record(params, controller.signal);
				case 'memory.prepare':
					return this.#prepare(params, controller.signal);
				case 'memory.compact':
					return this.#compact(params, controller.signal);
				case 'memory.refresh':
					return this.#refresh(params, controller.signal);
				case 'memory.inspect':
					return this.#inspect(params);
				case 'memory.receipts':
					return this.#receipts(params);
				case 'memory.worktrees':
					return listGitWorktrees(this.#root);
				case 'memory.scan':
					return this.#scan(params, controller.signal);
				case 'memory.symbols':
					return this.#symbols(params, controller.signal);
				case 'memory.symbolGraph.summary':
					return this.#symbolGraphSummary(params, controller.signal);
				default:
					throw new MethodNotFoundError(method);
			}
		} finally {
			if (requestId) {
				this.#controllers.delete(requestId);
			}
		}
	}

	async #initialize(params) {
		const capture = optionalEnum(params.capture, ['metadata', 'content'], 'metadata');
		const workspace = await initializeWorkspace(this.#root, { capture });
		const policy = await inspectWorkspacePolicy(this.#root);
		return {
			root: workspace.root,
			workspaceId: workspace.config.workspaceId,
			enabled: workspace.config.enabled,
			capture: workspace.config.capture,
			policy
		};
	}

	async #approve(params) {
		const capture = requiredEnum(params.capture, ['metadata', 'content'], 'capture');
		const policyHash = requiredString(params.policyHash, 'policyHash');
		if (!policyHash.startsWith('sha256:')) {
			throw new TypeError('policyHash must be a sha256 reference.');
		}
		return approveWorkspaceTrust(this.#root, capture, policyHash);
	}

	async #status() {
		const policy = await inspectWorkspacePolicy(this.#root);
		try {
			const store = await verifyStore(this.#root, { includeRoot: false });
			return { policy, store };
		} catch (error) {
			return { policy, store: null, error: safeError(error) };
		}
	}

	async #record(params, signal) {
		const event = normalizeLifecycleEvent(params.event);
		const stored = await appendEvent(event, {
			cwd: this.#root,
			idempotent: true,
			signal
		});
		return { eventId: stored.eventId, hash: stored.hash };
	}

	async #prepare(params, signal) {
		const query = optionalString(params.query, '');
		const maxTokens = optionalPositiveInteger(params.maxTokens, 8_000);
		const limit = optionalPositiveInteger(params.limit, 24);
		return compileContext(query, {
			cwd: this.#root,
			maxTokens,
			limit,
			minimumCoverage: optionalEnum(params.minimumCoverage, ['any', 'partial', 'direct'], 'any'),
			minimumEvidence: optionalEnum(params.minimumEvidence, ['any', 'partial', 'direct'], 'any'),
			includeEvidenceSufficiency: true,
			rebuild: params.rebuild !== false,
			updateCheckpoint: true,
			signal
		});
	}

	async #compact(params, signal) {
		return runCodingContextHarness({
			cwd: this.#root,
			query: optionalString(params.query, ''),
			maxTokens: optionalPositiveInteger(params.maxTokens, 8_000),
			maxSummaryChars: optionalPositiveInteger(params.maxSummaryChars, 8_000),
			record: params.record === true,
			rebuild: params.rebuild !== false,
			updateCheckpoint: true,
			signal
		});
	}

	async #refresh(params, signal) {
		return runProjectMemoryCycle({
			cwd: this.#root,
			query: optionalString(params.query, ''),
			compact: params.compact !== false,
			symbols: params.symbols !== false,
			rebuild: false,
			signal
		});
	}

	async #inspect(params) {
		return buildDeveloperMemoryView({
			cwd: this.#root,
			query: optionalString(params.query, ''),
			includeWorktrees: params.includeWorktrees !== false,
			limit: optionalPositiveInteger(params.limit, 50)
		});
	}

	async #receipts(params) {
		return buildSessionContextReceipts({
			cwd: this.#root,
			query: optionalString(params.query, ''),
			sessionId: optionalString(params.sessionId, undefined),
			maxTokens: optionalPositiveInteger(params.maxTokens, 8_000),
			write: params.write === true
		});
	}

	async #scan(params, signal) {
		throwIfAborted(signal);
		return scanProjectStructure({
			cwd: this.#root,
			maxFiles: boundedPositiveInteger(params.maxFiles, 20_000, 50_000),
			maxFileBytes: boundedPositiveInteger(params.maxFileBytes, 1_048_576, 2_097_152),
			maxTotalBytes: boundedPositiveInteger(params.maxTotalBytes, 67_108_864, 134_217_728),
			maxDepth: boundedPositiveInteger(params.maxDepth, 32, 64)
		});
	}

	async #symbols(params, signal) {
		const query = boundedString(params.query, '', 4_096);
		return searchSymbols(query, {
			cwd: this.#root,
			rebuild: params.rebuild !== false,
			persist: true,
			signal,
			limit: boundedPositiveInteger(params.limit, 24, 100),
			kinds: optionalSymbolKinds(params.kinds)
		});
	}

	async #symbolGraphSummary(params, signal) {
		const graph = await buildSymbolGraph({
			cwd: this.#root,
			persist: params.persist !== false,
			signal
		});
		return {
			schemaVersion: graph.schemaVersion,
			workspaceId: graph.workspaceId,
			generatedAt: graph.generatedAt,
			source: graph.source,
			extractor: graph.extractor,
			coverage: graph.coverage,
			fileCount: graph.files.length,
			symbolCount: graph.symbols.length,
			edgeCount: graph.edges.length,
			manifestHash: graph.manifestHash
		};
	}
}

export class MethodNotFoundError extends Error {
	constructor(method) {
		super(`Unknown memory method: ${method}`);
		this.name = 'MethodNotFoundError';
	}
}

export function normalizeLifecycleEvent(value) {
	if (!isRecord(value)) {
		throw new TypeError('event must be an object.');
	}

	const fikeyaType = requiredString(value.type, 'event.type');
	const kind = eventKindMap.get(fikeyaType);
	if (!kind || !qarinahKinds.has(kind)) {
		throw new TypeError(`Unsupported lifecycle event: ${fikeyaType}`);
	}

	const payload = isRecord(value.payload) ? value.payload : {};
	const title = optionalString(payload.title, fikeyaType).slice(0, 240);
	const body = typeof payload.body === 'string' ? payload.body.slice(0, 16_000) : undefined;

	const fikeyaEventId = requiredString(value.id, 'event.id');
	return {
		eventId: toQarinahEventId(fikeyaEventId),
		timestamp: requiredString(value.occurredAt, 'event.occurredAt'),
		sessionId: requiredString(value.sessionId, 'event.sessionId'),
		turnId: optionalString(value.turnId, null),
		kind,
		actor: { type: 'agent', id: 'fikeya-runtime' },
		title,
		...(body === undefined ? {} : { body }),
		data: {
			fikeyaType,
			parentId: optionalString(value.parentId, null),
			evidence: Array.isArray(value.evidence) ? value.evidence : [],
			payload
		},
		provenance: {
			adapter: 'fikeya',
			sourceId: fikeyaEventId
		},
		retention: { class: 'project', expiresAt: null }
	};
}

export function toQarinahEventId(value) {
	if (/^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
		return value;
	}

	const digest = createHash('sha256').update(`fikeya-event:${value}`, 'utf8').digest('hex').slice(0, 32).split('');
	digest[12] = '4';
	digest[16] = ['8', '9', 'a', 'b'][Number.parseInt(digest[16], 16) % 4];
	const hex = digest.join('');
	return `evt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function safeError(error) {
	if (!(error instanceof Error)) {
		return { name: 'Error', message: 'Unknown memory error.' };
	}
	return {
		name: error.name,
		message: error.message.replaceAll(/(?:sk|nvapi)-[A-Za-z0-9_\\-]+/g, '[redacted]')
	};
}

function requiredString(value, name) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${name} must be a non-empty string.`);
	}
	return value;
}

function optionalString(value, fallback) {
	return typeof value === 'string' ? value : fallback;
}

function boundedString(value, fallback, maximumLength) {
	const result = optionalString(value, fallback);
	if (result.length > maximumLength) {
		throw new TypeError(`String value exceeds the ${maximumLength}-character limit.`);
	}
	return result;
}

function optionalPositiveInteger(value, fallback) {
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedPositiveInteger(value, fallback, maximum) {
	const result = optionalPositiveInteger(value, fallback);
	if (result > maximum) {
		throw new TypeError(`Integer value exceeds the maximum of ${maximum}.`);
	}
	return result;
}

function optionalSymbolKinds(value) {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new TypeError('kinds must be an array.');
	}
	const supported = new Set(['function', 'class', 'interface', 'type', 'enum', 'namespace', 'method', 'property', 'getter', 'setter', 'parameter', 'variable', 'import']);
	if (!value.every(kind => typeof kind === 'string' && supported.has(kind))) {
		throw new TypeError('kinds contains an unsupported symbol kind.');
	}
	return value;
}

function throwIfAborted(signal) {
	if (signal.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled.');
	}
}

function requiredEnum(value, values, name) {
	if (!values.includes(value)) {
		throw new TypeError(`${name} must be one of: ${values.join(', ')}.`);
	}
	return value;
}

function optionalEnum(value, values, fallback) {
	return values.includes(value) ? value : fallback;
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
