/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, resolve } from 'node:path';

export const dangerousLocalModeDurationMs = 15 * 60 * 1_000;

export interface DangerousLocalModeEnvironment {
	readonly desktopUi: boolean;
	readonly remoteName: string | undefined;
	readonly trustedWorkspace: boolean;
	readonly workspaceScheme: string | undefined;
	readonly workspacePath: string | undefined;
}

export interface DangerousLocalModeGrant {
	readonly workspacePath: string;
	readonly enabledAt: number;
	readonly expiresAt: number;
}

/** Dangerous mode is deliberately unavailable in web, remote, virtual, or untrusted workspaces. */
export function canEnableDangerousLocalMode(environment: DangerousLocalModeEnvironment): boolean {
	return environment.desktopUi
		&& environment.remoteName === undefined
		&& environment.trustedWorkspace
		&& environment.workspaceScheme === 'file'
		&& typeof environment.workspacePath === 'string'
		&& isAbsolute(environment.workspacePath);
}

export function dangerousLocalModeConfirmation(workspaceName: string): string {
	return `FULL ACCESS ${workspaceName}`;
}

export function createDangerousLocalModeGrant(
	workspacePath: string,
	now = Date.now(),
	durationMs = dangerousLocalModeDurationMs
): DangerousLocalModeGrant {
	if (!isAbsolute(workspacePath) || !Number.isSafeInteger(now) || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > dangerousLocalModeDurationMs) {
		throw new Error('Dangerous local mode requires an absolute workspace path and a bounded expiry.');
	}
	return {
		workspacePath: resolve(workspacePath),
		enabledAt: now,
		expiresAt: now + durationMs
	};
}

export function dangerousLocalModeIsActive(
	grant: DangerousLocalModeGrant | undefined,
	workspacePath: string | undefined,
	now = Date.now()
): boolean {
	return grant !== undefined
		&& workspacePath !== undefined
		&& isAbsolute(workspacePath)
		&& resolve(workspacePath) === grant.workspacePath
		&& now >= grant.enabledAt
		&& now < grant.expiresAt;
}
