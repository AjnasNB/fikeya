/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fikeya contributors. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in this package for information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLifecycleEvent, isProtocolMessage, protocolVersion } from '../dist/index.js';

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
