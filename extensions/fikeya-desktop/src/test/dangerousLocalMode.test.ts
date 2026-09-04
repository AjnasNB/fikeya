/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
	canEnableDangerousLocalMode,
	createDangerousLocalModeGrant,
	dangerousLocalModeConfirmation,
	dangerousLocalModeDurationMs,
	dangerousLocalModeIsActive
} from '../dangerousLocalMode';

describe('Fikeya dangerous local mode', () => {
	const workspacePath = resolve('safe-local-workspace');

	test('requires a trusted local desktop file workspace', () => {
		const allowed = {
			desktopUi: true,
			remoteName: undefined,
			trustedWorkspace: true,
			workspaceScheme: 'file',
			workspacePath
		};
		assert.equal(canEnableDangerousLocalMode(allowed), true);
		assert.equal(canEnableDangerousLocalMode({ ...allowed, desktopUi: false }), false);
		assert.equal(canEnableDangerousLocalMode({ ...allowed, remoteName: 'ssh-remote' }), false);
		assert.equal(canEnableDangerousLocalMode({ ...allowed, trustedWorkspace: false }), false);
		assert.equal(canEnableDangerousLocalMode({ ...allowed, workspaceScheme: 'vscode-vfs' }), false);
	});

	test('binds one expiring grant to one exact workspace', () => {
		const now = 10_000;
		const grant = createDangerousLocalModeGrant(workspacePath, now);
		assert.equal(grant.expiresAt, now + dangerousLocalModeDurationMs);
		assert.equal(dangerousLocalModeIsActive(grant, workspacePath, now), true);
		assert.equal(dangerousLocalModeIsActive(grant, resolve('another-workspace'), now), false);
		assert.equal(dangerousLocalModeIsActive(grant, workspacePath, grant.expiresAt), false);
	});

	test('uses an exact, workspace-specific typed confirmation', () => {
		assert.equal(dangerousLocalModeConfirmation('payments-api'), 'FULL ACCESS payments-api');
	});
});
