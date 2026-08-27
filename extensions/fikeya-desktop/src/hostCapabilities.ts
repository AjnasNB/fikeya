/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export interface FikeyaHostCapabilities {
	readonly isFikeyaProduct: boolean;
	readonly supportsDesktopWorkbench: boolean;
}

export function resolveFikeyaHostCapabilities(appName: string, desktopUi: boolean): FikeyaHostCapabilities {
	return {
		isFikeyaProduct: appName === 'Fikeya' || appName === 'Fikeya Dev',
		supportsDesktopWorkbench: desktopUi
	};
}
