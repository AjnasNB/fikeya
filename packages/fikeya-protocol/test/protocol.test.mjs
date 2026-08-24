/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fikeya contributors. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in this package for information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLifecycleEvent, isProtocolMessage, isUsageReceipt, protocolVersion } from '../dist/index.js';

test('accepts a valid request', () => {
	assert.equal(isProtocolMessage({
		jsonrpc: '2.0',
		id: 'req-1',
		method: 'workspace.initialize',
		params: { root: 'C:\\project' }
	}), true);
});

test('rejects an invalid protocol version', () => {
	assert.equal(isProtocolMessage({ jsonrpc: '1.0', id: 'req-1', method: 'run' }), false);
});

test('accepts a valid lifecycle event', () => {
	assert.equal(isLifecycleEvent({
		protocolVersion,
		id: 'evt-1',
		type: 'session.started',
		occurredAt: '2026-08-24T00:00:00.000Z',
		workspaceId: 'ws-1',
		sessionId: 'session-1',
		payload: {}
	}), true);
});

test('rejects an unsupported lifecycle event', () => {
	assert.equal(isLifecycleEvent({
		protocolVersion,
		id: 'evt-1',
		type: 'shell.exec.anything',
		occurredAt: '2026-08-24T00:00:00.000Z',
		workspaceId: 'ws-1',
		sessionId: 'session-1',
		payload: {}
	}), false);
});

const receipt = {
	usageMeasurement: 'provider-reported',
	provider: 'azure-openai',
	model: 'deployment-name',
	apiMode: 'responses',
	callId: 'call-1',
	requestId: 'provider-request-id',
	inputTokens: 12,
	cachedInputTokens: 0,
	outputTokens: 5,
	requestBytes: 240,
	responseBytes: 190,
	requestSha256: 'a'.repeat(64),
	responseSha256: 'b'.repeat(64),
	statusCode: 200,
	durationMs: 430,
	createdAt: '2026-08-24T00:00:00.000Z'
};

test('accepts the receipt shape emitted by the runtime', () => {
	assert.equal(isUsageReceipt(receipt), true);
});

test('requires null token fields when provider usage is unavailable', () => {
	assert.equal(isUsageReceipt({
		...receipt,
		usageMeasurement: 'unavailable',
		inputTokens: null,
		cachedInputTokens: null,
		outputTokens: null
	}), true);
	assert.equal(isUsageReceipt({ ...receipt, usageMeasurement: 'unavailable' }), false);
});
