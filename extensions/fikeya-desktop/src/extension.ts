/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { escapeHtml, FikeyaLayout, FikeyaMode, fikeyaLayouts, fikeyaModes, parseWebviewMessage } from './messageValidation';
import { FikeyaMemorySnapshot, loadQarinahMemory } from './memory';
import {
	configureFikeyaProvider,
	FikeyaAgentRunHandle,
	FikeyaAgentUsage,
	FikeyaProviderConfiguration,
	FikeyaProviderProfile,
	FikeyaProviderReceipt,
	FikeyaRuntimeResult,
	loadFikeyaAgentReceipts,
	listFikeyaProviders,
	removeFikeyaProvider,
	runFikeyaRuntime,
	startFikeyaAgentRun,
	testFikeyaProvider
} from './runtime';

const layoutStorageKey = 'fikeya.layout';
const modeStorageKey = 'fikeya.mode';

interface ProviderDefinition {
	readonly id: string;
	readonly label: string;
	readonly detail: string;
	readonly runtimeKind: FikeyaProviderConfiguration['kind'];
	readonly credentialType: FikeyaProviderConfiguration['credentialType'];
	readonly defaultBaseUrl: string;
	readonly secretPrompt?: string;
}

interface ProviderHealth {
	readonly status: 'testing' | 'ready' | 'attention';
	readonly detail: string;
}

interface AgentSurfaceState {
	readonly status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
	readonly providerName?: string;
	readonly output?: string;
	readonly sessionId?: string;
	readonly callId?: string;
	readonly usage?: FikeyaAgentUsage;
	readonly receiptsStatus: 'idle' | 'loading' | 'ready' | 'unavailable';
	readonly receipts: readonly FikeyaProviderReceipt[];
	readonly failure?: string;
}

interface MemorySurfaceState {
	readonly status: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly snapshot?: FikeyaMemorySnapshot;
}

interface DashboardState {
	readonly layout: FikeyaLayout;
	readonly mode: FikeyaMode;
	readonly workspaceName: string;
	readonly providersStatus: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly providers: readonly FikeyaProviderProfile[];
	readonly providerHealth: Readonly<Record<string, ProviderHealth>>;
	readonly agent: AgentSurfaceState;
	readonly memory: MemorySurfaceState;
	readonly runtime: 'not-checked' | 'checking' | 'ready' | 'attention';
	readonly workspaceInitialized: boolean;
	readonly runtimeProviderCount?: number;
	readonly qarinah: string;
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new FikeyaWebviewViewProvider(context);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(FikeyaWebviewViewProvider.viewType, provider));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.open', async () => {
		await vscode.commands.executeCommand('workbench.view.extension.fikeya');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.switchLayout', async () => {
		await provider.chooseLayout();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.selectMode', async () => {
		await provider.chooseMode();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.configureProvider', async () => {
		await provider.configureProvider();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.initializeWorkspace', async () => {
		await provider.runRuntimeCommand('init');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.runDoctor', async () => {
		await provider.runRuntimeCommand('doctor');
	}));
}

class FikeyaWebviewViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'fikeya.dashboard';
	private view: vscode.WebviewView | undefined;
	private state: DashboardState;
	private activeAgentRun: FikeyaAgentRunHandle | undefined;

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.state = {
			layout: readStoredValue(context.globalState.get<string>(layoutStorageKey), fikeyaLayouts, 'studio'),
			mode: readStoredValue(context.globalState.get<string>(modeStorageKey), fikeyaModes, 'agent'),
			workspaceName: getWorkspaceName(),
			providersStatus: 'not-loaded',
			providers: [],
			providerHealth: {},
			agent: { status: 'idle', receiptsStatus: 'idle', receipts: [] },
			memory: { status: 'not-loaded' },
			runtime: 'not-checked',
			workspaceInitialized: false,
			runtimeProviderCount: undefined,
			qarinah: vscode.l10n.t('Not checked')
		};
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.context.subscriptions.push(webviewView.webview.onDidReceiveMessage(async value => {
			const message = parseWebviewMessage(value);
			if (!message) {
				return;
			}

			switch (message.type) {
				case 'openCommand':
					await vscode.commands.executeCommand(message.command);
					break;
				case 'selectMode':
					await this.setMode(message.mode);
					break;
				case 'switchLayout':
					await this.setLayout(message.layout);
					break;
				case 'refreshProviders':
					await this.refreshProviders(true);
					break;
				case 'testProvider':
					await this.testProvider(message.providerName);
					break;
				case 'removeProvider':
					await this.removeProvider(message.providerName);
					break;
				case 'runAgent':
					await this.runAgent(message.providerName, message.prompt, message.maxOutputTokens);
					break;
				case 'cancelAgent':
					this.cancelAgent();
					break;
				case 'refreshReceipts':
					await this.refreshReceipts(true);
					break;
				case 'refreshMemory':
					await this.refreshMemory(true);
					break;
			}
		}));
		this.refresh();
		void this.refreshProviders(false);
		void this.refreshMemory(false);
	}

	public async chooseLayout(): Promise<void> {
		const selection = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Studio'), description: vscode.l10n.t('Show workspace, memory, approvals, and receipts.'), value: 'studio' as const },
			{ label: vscode.l10n.t('Agent Focus'), description: vscode.l10n.t('Keep the active agent controls in view.'), value: 'agentFocus' as const }
		], {
			placeHolder: vscode.l10n.t('Choose the Fikeya Layout')
		});
		if (selection) {
			await this.setLayout(selection.value);
		}
	}

	public async chooseMode(): Promise<void> {
		const items = [
			{ label: vscode.l10n.t('Editor'), value: 'editor' as const },
			{ label: vscode.l10n.t('Agent'), value: 'agent' as const },
			{ label: vscode.l10n.t('Terminal'), value: 'terminal' as const },
			{ label: vscode.l10n.t('Review'), value: 'review' as const }
		];
		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: vscode.l10n.t('Choose the Fikeya Mode')
		});
		if (selection) {
			await this.setMode(selection.value);
		}
	}

	public async configureProvider(): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open a trusted local folder before configuring a provider.'));
			return;
		}

		const provider = await vscode.window.showQuickPick(getProviderDefinitions().map(definition => ({
			label: definition.label,
			description: definition.detail,
			definition
		})), {
			placeHolder: vscode.l10n.t('Choose an AI Provider')
		});
		if (!provider) {
			return;
		}

		const profileLabel = await vscode.window.showInputBox({
			title: vscode.l10n.t('Configure {0}', provider.definition.label),
			prompt: vscode.l10n.t('Profile Name'),
			value: provider.definition.label,
			ignoreFocusOut: true,
			validateInput: value => value.trim().length > 0 && value.trim().length <= 80 ? undefined : vscode.l10n.t('Enter a name with 1 to 80 characters.')
		});
		if (!profileLabel) {
			return;
		}

		const baseUrl = await vscode.window.showInputBox({
			title: vscode.l10n.t('Configure {0}', provider.definition.label),
			prompt: vscode.l10n.t('Endpoint URL'),
			value: provider.definition.defaultBaseUrl,
			ignoreFocusOut: true,
			validateInput: value => validateProviderUrl(value, true)
		});
		if (baseUrl === undefined) {
			return;
		}

		const model = await vscode.window.showInputBox({
			title: vscode.l10n.t('Configure {0}', provider.definition.label),
			prompt: vscode.l10n.t('Model or Deployment Name'),
			ignoreFocusOut: true,
			validateInput: value => value.trim().length > 0 && value.trim().length <= 160 ? undefined : vscode.l10n.t('Enter a model or deployment name with 1 to 160 characters.')
		});
		if (model === undefined) {
			return;
		}

		const runtimeName = createProviderName(provider.definition.id, profileLabel);
		let secret: string | undefined;
		if (provider.definition.secretPrompt) {
			secret = await vscode.window.showInputBox({
				title: vscode.l10n.t('Configure {0}', provider.definition.label),
				prompt: provider.definition.secretPrompt,
				password: true,
				ignoreFocusOut: true,
				placeHolder: vscode.l10n.t('Stored in OS-backed credential stores'),
				validateInput: value => value.length > 0 && value.length <= 16_384 && value.trim() === value ? undefined : vscode.l10n.t('Enter a credential with 1 to 16384 characters and no outer spaces.')
			});
			if (secret === undefined) {
				return;
			}
		}

		const configuration: FikeyaProviderConfiguration = {
			name: runtimeName,
			kind: provider.definition.runtimeKind,
			model: model.trim(),
			baseUrl: baseUrl.trim(),
			credentialType: provider.definition.credentialType
		};
		const title = vscode.l10n.t('Configuring {0}', provider.definition.label);
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => configureFikeyaProvider(configuration, workspacePath, secret));
		secret = undefined;
		if (!result.ok) {
			void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
			return;
		}

		await this.refreshProviders(false);
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} was configured in Fikeya Runtime.', profileLabel.trim()));
	}

	public async runRuntimeCommand(command: 'doctor' | 'init'): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open a trusted local folder before running Fikeya.'));
			return;
		}

		this.state = { ...this.state, runtime: 'checking' };
		this.refresh();
		const title = command === 'doctor' ? vscode.l10n.t('Running Fikeya Doctor') : vscode.l10n.t('Initializing Fikeya Workspace');
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => runFikeyaRuntime(command, workspacePath));
		this.applyRuntimeResult(result, command);
		if (result.ok) {
			void this.refreshMemory(false);
		}
	}

	private async refreshProviders(showFailure: boolean): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			this.state = { ...this.state, providersStatus: 'unavailable', providers: [] };
			this.refresh();
			return;
		}

		this.state = { ...this.state, providersStatus: 'loading' };
		this.refresh();
		const result = await listFikeyaProviders(workspacePath);
		if (!result.ok || !result.value) {
			this.state = { ...this.state, providersStatus: 'unavailable', providers: [] };
			this.refresh();
			if (showFailure) {
				void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
			}
			return;
		}

		const names = new Set(result.value.map(profile => profile.name));
		const providerHealth = Object.fromEntries(Object.entries(this.state.providerHealth).filter(([name]) => names.has(name)));
		this.state = {
			...this.state,
			providersStatus: 'ready',
			providers: result.value,
			providerHealth,
			runtimeProviderCount: result.value.length
		};
		this.refresh();
	}

	private async testProvider(providerName: string): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath || !this.state.providers.some(provider => provider.name === providerName)) {
			return;
		}
		const confirm = vscode.l10n.t('Run Network Test');
		const accepted = await vscode.window.showWarningMessage(
			vscode.l10n.t('Test {0}? This makes one content-free network request to the configured endpoint.', providerName),
			{ modal: true },
			confirm
		);
		if (accepted !== confirm) {
			return;
		}

		this.state = {
			...this.state,
			providerHealth: {
				...this.state.providerHealth,
				[providerName]: { status: 'testing', detail: vscode.l10n.t('Testing') }
			}
		};
		this.refresh();
		const result = await testFikeyaProvider(providerName, workspacePath);
		const health: ProviderHealth = result.ok && result.value
			? { status: 'ready', detail: vscode.l10n.t('HTTP {0} in {1} ms', result.value.statusCode, result.value.latencyMs) }
			: { status: 'attention', detail: vscode.l10n.t('Connection test failed safely') };
		this.state = {
			...this.state,
			providerHealth: { ...this.state.providerHealth, [providerName]: health }
		};
		this.refresh();
	}

	private async removeProvider(providerName: string): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath || !this.state.providers.some(provider => provider.name === providerName)) {
			return;
		}
		if (this.activeAgentRun && this.state.agent.providerName === providerName) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Cancel the active run before removing its provider.'));
			return;
		}
		const confirm = vscode.l10n.t('Remove Provider');
		const accepted = await vscode.window.showWarningMessage(
			vscode.l10n.t('Remove {0} and its runtime-owned credential reference?', providerName),
			{ modal: true },
			confirm
		);
		if (accepted !== confirm) {
			return;
		}
		const result = await removeFikeyaProvider(providerName, workspacePath);
		if (!result.ok) {
			void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
			return;
		}
		await this.refreshProviders(false);
	}

	private async runAgent(providerName: string, prompt: string, maxOutputTokens: number): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath || this.activeAgentRun || !this.state.providers.some(provider => provider.name === providerName)) {
			return;
		}

		this.state = {
			...this.state,
			mode: 'agent',
			agent: {
				status: 'running',
				providerName,
				receiptsStatus: 'idle',
				receipts: []
			}
		};
		this.refresh();
		const operation = startFikeyaAgentRun(providerName, prompt, maxOutputTokens, workspacePath);
		this.activeAgentRun = operation;
		const result = await operation.result;
		if (this.activeAgentRun !== operation) {
			return;
		}
		this.activeAgentRun = undefined;
		if (!result.ok || !result.value) {
			const cancelled = result.failure === 'cancelled';
			this.state = {
				...this.state,
				agent: {
					status: cancelled ? 'cancelled' : 'failed',
					providerName,
					receiptsStatus: 'idle',
					receipts: [],
					failure: cancelled ? vscode.l10n.t('Run cancelled. No partial output was retained.') : runtimeFailureMessage(result.failure)
				}
			};
			this.refresh();
			return;
		}

		this.state = {
			...this.state,
			agent: {
				status: 'completed',
				providerName,
				output: result.value.output,
				sessionId: result.value.sessionId,
				callId: result.value.callId,
				usage: result.value.usage,
				receiptsStatus: 'loading',
				receipts: []
			}
		};
		this.refresh();
		await this.refreshReceipts(false);
	}

	private cancelAgent(): void {
		if (!this.activeAgentRun) {
			return;
		}
		this.activeAgentRun.cancel();
	}

	private async refreshReceipts(showFailure: boolean): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const sessionId = this.state.agent.sessionId;
		if (!workspacePath || !sessionId) {
			return;
		}
		this.state = { ...this.state, agent: { ...this.state.agent, receiptsStatus: 'loading' } };
		this.refresh();
		const result = await loadFikeyaAgentReceipts(sessionId, workspacePath);
		if (this.state.agent.sessionId !== sessionId) {
			return;
		}
		if (!result.ok || !result.value) {
			this.state = { ...this.state, agent: { ...this.state.agent, receiptsStatus: 'unavailable', receipts: [] } };
			this.refresh();
			if (showFailure) {
				void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
			}
			return;
		}
		this.state = { ...this.state, agent: { ...this.state.agent, receiptsStatus: 'ready', receipts: result.value } };
		this.refresh();
	}

	private async refreshMemory(showFailure: boolean): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			this.state = { ...this.state, memory: { status: 'unavailable' } };
			this.refresh();
			return;
		}
		this.state = { ...this.state, memory: { status: 'loading', snapshot: this.state.memory.snapshot } };
		this.refresh();
		const result = await loadQarinahMemory(this.context.extensionPath, workspacePath);
		if (!result.ok || !result.snapshot) {
			this.state = { ...this.state, memory: { status: 'unavailable' } };
			this.refresh();
			if (showFailure) {
				const message = result.failure === 'sidecar-not-found'
					? vscode.l10n.t('The pinned Qarinah sidecar is not available in this build.')
					: vscode.l10n.t('Qarinah memory is unavailable. Initialize the workspace and run doctor.');
				void vscode.window.showErrorMessage(message);
			}
			return;
		}
		this.state = {
			...this.state,
			memory: { status: 'ready', snapshot: result.snapshot },
			qarinah: vscode.l10n.t('{0} events, verified graph', result.snapshot.eventCount)
		};
		this.refresh();
	}

	private async setLayout(layout: FikeyaLayout): Promise<void> {
		await this.context.globalState.update(layoutStorageKey, layout);
		this.state = { ...this.state, layout };
		this.refresh();
	}

	private async setMode(mode: FikeyaMode): Promise<void> {
		await this.context.globalState.update(modeStorageKey, mode);
		this.state = { ...this.state, mode };
		this.refresh();
		await vscode.commands.executeCommand(modeWorkbenchCommand(mode));
	}

	private applyRuntimeResult(result: FikeyaRuntimeResult, command: 'doctor' | 'init'): void {
		if (!result.ok) {
			this.state = { ...this.state, runtime: 'attention' };
			this.refresh();
			const message = runtimeFailureMessage(result.failure);
			void vscode.window.showErrorMessage(message);
			return;
		}

		this.state = {
			...this.state,
			runtime: 'ready',
			workspaceInitialized: result.report?.initialized ?? (command === 'init' || this.state.workspaceInitialized),
			runtimeProviderCount: result.report?.providerCount ?? this.state.runtimeProviderCount,
			qarinah: result.report?.qarinah ?? this.state.qarinah
		};
		this.refresh();
		void vscode.window.showInformationMessage(command === 'doctor' ? vscode.l10n.t('Fikeya doctor completed.') : vscode.l10n.t('Fikeya workspace initialized.'));
	}

	private refresh(): void {
		if (this.view) {
			this.view.webview.html = this.getHtml(this.view.webview);
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const strings = getWebviewStrings();
		const providerCards = renderProviderCards(this.state, strings);
		const agentSurface = renderAgentSurface(this.state, strings);
		const memoryGraph = renderMemoryGraph(this.state, strings);
		const memoryGraphData = serializeForHtml(this.state.memory.snapshot ?? { nodes: [], edges: [] });
		const latestReceipt = this.state.agent.receipts.at(-1);
		const modeButtons = ([
			['editor', strings.editor],
			['agent', strings.agent],
			['terminal', strings.terminal],
			['review', strings.review]
		] as const).map(([mode, label]) => `<button class="mode-button${this.state.mode === mode ? ' active' : ''}" data-mode="${mode}" type="button" aria-pressed="${this.state.mode === mode}">${escapeHtml(label)}</button>`).join('');
		const layoutButtons = ([
			['studio', strings.studio],
			['agentFocus', strings.agentFocus]
		] as const).map(([layout, label]) => `<button class="layout-button${this.state.layout === layout ? ' active' : ''}" data-layout="${layout}" type="button" aria-pressed="${this.state.layout === layout}">${escapeHtml(label)}</button>`).join('');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>${escapeHtml(strings.fikeya)}</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		body { margin: 0; padding: 14px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
		button { min-height: 30px; padding: 5px 9px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		button:disabled { cursor: not-allowed; opacity: .58; }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
		.shell { display: grid; gap: 12px; }
		.masthead { display: grid; gap: 8px; }
		.eyebrow { margin: 0; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
		h1 { margin: 0; font-size: 24px; line-height: 1.15; }
		.subtitle, p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; }
		.switcher { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; padding: 2px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
		.switcher.modes { grid-template-columns: repeat(4, minmax(0, 1fr)); }
		.switcher button { min-width: 0; overflow: hidden; color: var(--vscode-foreground); background: transparent; border-color: transparent; text-overflow: ellipsis; }
		.switcher button.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.grid { display: grid; gap: 8px; }
		.card { display: grid; gap: 8px; padding: 11px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
		.card h2 { margin: 0; font-size: 13px; }
		.kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--vscode-widget-border); }
		.kpi { min-width: 0; padding: 10px; background: var(--vscode-editorWidget-background); }
		.kpi span { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; }
		.kpi strong { display: block; margin-top: 4px; overflow-wrap: anywhere; font-size: 14px; }
		.badge, .status { display: inline-flex; align-items: center; width: fit-content; min-height: 20px; padding: 2px 6px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
		.actions { display: flex; flex-wrap: wrap; gap: 6px; }
		.providers { display: grid; gap: 1px; background: var(--vscode-widget-border); }
		.provider-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 9px; background: var(--vscode-editorWidget-background); }
		.provider-card strong { display: block; }
		.provider-card p { margin-top: 3px; font-size: 11px; }
		.provider-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
		.provider-actions { display: flex; flex-wrap: wrap; justify-content: end; gap: 4px; }
		.provider-actions button { min-height: 26px; padding: 3px 7px; }
		.empty { padding: 10px; border: 1px dashed var(--vscode-widget-border); color: var(--vscode-descriptionForeground); }
		.receipt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 9px; margin: 0; }
		.receipt dt { color: var(--vscode-descriptionForeground); }
		.receipt dd { margin: 0; overflow-wrap: anywhere; }
		.agent-surface { display: grid; gap: 10px; }
		.agent-form { display: grid; gap: 9px; }
		.field { display: grid; gap: 4px; }
		.field > span { color: var(--vscode-foreground); font-weight: 600; }
		select, textarea, input[type="number"], input[type="search"] { width: 100%; border: 1px solid var(--vscode-input-border, transparent); border-radius: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
		select, input[type="number"], input[type="search"] { min-height: 30px; padding: 4px 7px; }
		textarea { min-height: 108px; resize: vertical; padding: 7px; line-height: 1.45; }
		select:focus-visible, textarea:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.consent { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; }
		.consent input { margin: 2px 0 0; }
		.agent-status { padding: 8px 9px; border-left: 2px solid var(--vscode-progressBar-background); background: var(--vscode-textBlockQuote-background); }
		.agent-status[data-tone="error"] { border-left-color: var(--vscode-errorForeground); }
		.agent-output { max-height: 360px; margin: 0; overflow: auto; padding: 10px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
		.agent-receipt { display: grid; gap: 8px; }
		.memory-graph { min-width: 0; }
		.graph-controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(110px, .4fr) auto; gap: 6px; }
		.graph-controls input { min-height: 30px; padding: 4px 7px; }
		.graph-viewport { position: relative; min-height: 360px; overflow: hidden; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); }
		.graph-canvas { display: block; width: 100%; min-height: 360px; touch-action: none; user-select: none; }
		.graph-hit { fill: transparent; cursor: grab; }
		.graph-hit[data-panning="true"] { cursor: grabbing; }
		.graph-edge { stroke: var(--vscode-editorWidget-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
		.graph-node { cursor: grab; }
		.graph-node:focus-visible .graph-halo, .graph-node[data-selected="true"] .graph-halo { stroke: var(--vscode-focusBorder); stroke-width: 3; }
		.graph-node[data-dragging="true"] { cursor: grabbing; }
		.graph-halo { fill: var(--vscode-editor-background); stroke: var(--vscode-widget-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
		.graph-dot { stroke: var(--vscode-editor-foreground); stroke-width: .6; vector-effect: non-scaling-stroke; }
		.graph-details { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
		.graph-details h3 { margin: 0; font-size: 13px; }
		.graph-details code { overflow-wrap: anywhere; }
		.graph-legend { display: flex; flex-wrap: wrap; gap: 5px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
		.graph-legend span { display: inline-flex; align-items: center; gap: 4px; }
		.graph-legend i { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
		.graph-legend i[data-type="worktree"] { background: var(--vscode-charts-red); }
		.graph-legend i[data-type="memory"] { background: var(--vscode-charts-green); }
		.graph-legend i[data-type="file"] { background: var(--vscode-charts-blue); }
		.graph-legend i[data-type="concept"] { background: var(--vscode-charts-purple); }
		.graph-legend i[data-type="directory"] { background: var(--vscode-charts-yellow); }
		.graph-summary { color: var(--vscode-descriptionForeground); font-size: 11px; }
		.focus-only { display: none; }
		body[data-layout="agentFocus"] .studio-only { display: none; }
		body[data-layout="agentFocus"] .focus-only { display: grid; }
		.disclaimer { padding-left: 9px; border-left: 2px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
		@media (min-width: 520px) { .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
		@media (max-width: 420px) { .graph-controls { grid-template-columns: 1fr; } }
		@media (max-width: 280px) { .switcher.modes { grid-template-columns: repeat(2, minmax(0, 1fr)); } .provider-card { grid-template-columns: 1fr; } }
	</style>
</head>
		<body data-layout="${this.state.layout}" data-mode="${this.state.mode}">
	<main class="shell">
		<header class="masthead">
			<p class="eyebrow">${escapeHtml(strings.localFirstWorkbench)}</p>
			<h1>${escapeHtml(strings.fikeya)}</h1>
			<p class="subtitle">${escapeHtml(strings.subtitle)}</p>
		</header>
		<nav class="switcher" aria-label="${escapeHtml(strings.layout)}">${layoutButtons}</nav>
		<nav class="switcher modes" aria-label="${escapeHtml(strings.mode)}">${modeButtons}</nav>
		<section class="card focus-only" aria-labelledby="active-mode-title">
			<h2 id="active-mode-title">${escapeHtml(strings.activeMode)}</h2>
			<strong>${escapeHtml(modeLabel(this.state.mode, strings))}</strong>
			<p>${escapeHtml(strings.agentFocusDescription)}</p>
			<div class="actions"><button data-command="fikeya.runDoctor" type="button">${escapeHtml(strings.runDoctor)}</button></div>
		</section>
		<section class="kpis" aria-label="${escapeHtml(strings.workspaceStatus)}">
			<div class="kpi"><span>${escapeHtml(strings.workspace)}</span><strong>${escapeHtml(this.state.workspaceName)}</strong></div>
			<div class="kpi"><span>${escapeHtml(strings.runtime)}</span><strong>${escapeHtml(runtimeLabel(this.state.runtime, strings))}</strong></div>
			<div class="kpi"><span>${escapeHtml(strings.inputTokens)}</span><strong>${escapeHtml(formatUsageValue(this.state.agent.usage?.inputTokens))}</strong></div>
			<div class="kpi"><span>${escapeHtml(strings.outputTokens)}</span><strong>${escapeHtml(formatUsageValue(this.state.agent.usage?.outputTokens))}</strong></div>
		</section>
		<p class="disclaimer">${escapeHtml(strings.metricsDisclaimer)}</p>
		${agentSurface}
		<section class="grid two studio-only">
			<article class="card">
				<h2>${escapeHtml(strings.getStarted)}</h2>
				<span class="badge">${escapeHtml(this.state.workspaceInitialized ? strings.initialized : strings.notInitialized)}</span>
				<p>${escapeHtml(strings.getStartedDescription)}</p>
				<div class="actions"><button data-command="fikeya.initializeWorkspace" type="button">${escapeHtml(strings.initializeWorkspace)}</button><button data-command="fikeya.runDoctor" type="button">${escapeHtml(strings.runDoctor)}</button></div>
			</article>
			<article class="card">
				<h2>${escapeHtml(strings.qarinahMemory)}</h2>
				<span class="badge">${escapeHtml(this.state.qarinah)}</span>
				<p>${escapeHtml(strings.qarinahDescription)}</p>
				<div class="actions"><button class="secondary" data-memory-refresh type="button">${escapeHtml(strings.refresh)}</button></div>
			</article>
		</section>
		${memoryGraph}
		<section class="card studio-only" aria-labelledby="providers-title">
			<h2 id="providers-title">${escapeHtml(strings.providers)}</h2>
			<span class="badge">${escapeHtml(providerStatusSummary(this.state, strings))}</span>
			<p>${escapeHtml(strings.providersDescription)}</p>
			<div class="providers">${providerCards}</div>
			<div class="actions"><button data-command="fikeya.configureProvider" type="button">${escapeHtml(strings.configureProvider)}</button><button data-action="refresh-providers" class="secondary" type="button">${escapeHtml(strings.refresh)}</button></div>
		</section>
		<section class="grid two studio-only">
			<article class="card">
				<h2>${escapeHtml(strings.approvalsQueue)}</h2>
				<p class="empty">${escapeHtml(strings.noApprovals)}</p>
			</article>
			<article class="card">
				<h2>${escapeHtml(strings.latestCallReceipt)}</h2>
				${renderReceipt(latestReceipt, this.state.agent, strings)}
			</article>
		</section>
	</main>
	<script id="fikeya-memory-graph-data" type="application/json" nonce="${nonce}">${memoryGraphData}</script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'openCommand', command: button.dataset.command })));
		document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'selectMode', mode: button.dataset.mode })));
		document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'switchLayout', layout: button.dataset.layout })));
		document.querySelector('[data-action="refresh-providers"]')?.addEventListener('click', () => vscode.postMessage({ type: 'refreshProviders' }));
		document.querySelectorAll('[data-provider-test]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'testProvider', providerName: button.dataset.providerTest })));
		document.querySelectorAll('[data-provider-remove]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'removeProvider', providerName: button.dataset.providerRemove })));
		document.querySelector('[data-agent-cancel]')?.addEventListener('click', () => vscode.postMessage({ type: 'cancelAgent' }));
		document.querySelector('[data-receipts-refresh]')?.addEventListener('click', () => vscode.postMessage({ type: 'refreshReceipts' }));
		const agentForm = document.querySelector('[data-agent-form]');
		const networkConsent = document.querySelector('[data-network-consent]');
		const runButton = document.querySelector('[data-agent-run]');
		if (agentForm && networkConsent && runButton) {
			const updateRunButton = () => { runButton.disabled = !networkConsent.checked; };
			networkConsent.addEventListener('change', updateRunButton);
			updateRunButton();
			agentForm.addEventListener('submit', event => {
				event.preventDefault();
				const providerName = agentForm.querySelector('[name="providerName"]')?.value;
				const prompt = agentForm.querySelector('[name="prompt"]')?.value;
				const maxOutputTokens = Number(agentForm.querySelector('[name="maxOutputTokens"]')?.value);
				if (!networkConsent.checked || !providerName || !prompt?.trim() || !Number.isSafeInteger(maxOutputTokens)) return;
				runButton.disabled = true;
				vscode.postMessage({ type: 'runAgent', providerName, prompt, maxOutputTokens, allowNetwork: true });
			});
		}
		document.querySelectorAll('[data-memory-refresh]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'refreshMemory' })));
		const graphDataElement = document.getElementById('fikeya-memory-graph-data');
		const graphSvg = document.querySelector('[data-memory-graph]');
		if (graphDataElement && graphSvg) {
			const graph = JSON.parse(graphDataElement.textContent);
			const scene = graphSvg.querySelector('[data-graph-scene]');
			const edgeLayer = graphSvg.querySelector('[data-graph-edges]');
			const nodeLayer = graphSvg.querySelector('[data-graph-nodes]');
			const hit = graphSvg.querySelector('[data-graph-hit]');
			const search = document.querySelector('[data-graph-search]');
			const typeFilter = document.querySelector('[data-graph-type]');
			const summary = document.querySelector('[data-graph-summary]');
			const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
			const neighbors = new Map(graph.nodes.map(node => [node.id, new Set()]));
			for (const edge of graph.edges) { neighbors.get(edge.source)?.add(edge.target); neighbors.get(edge.target)?.add(edge.source); }
			const colors = {
				worktree: 'var(--vscode-charts-red)',
				memory: 'var(--vscode-charts-green)',
				file: 'var(--vscode-charts-blue)',
				concept: 'var(--vscode-charts-purple)',
				directory: 'var(--vscode-charts-yellow)',
				reference: 'var(--vscode-descriptionForeground)'
			};
			const positions = new Map();
			let pan = { x: 0, y: 0 };
			let zoom = 1;
			let selectedId = null;
			let pointerState = null;
			const svgElement = name => document.createElementNS('http://www.w3.org/2000/svg', name);
			const applyScene = () => scene.setAttribute('transform', 'translate(' + pan.x + ' ' + pan.y + ') scale(' + zoom + ')');
			const pointFromEvent = event => {
				const rect = graphSvg.getBoundingClientRect();
				return { x: (event.clientX - rect.left) * 800 / Math.max(1, rect.width), y: (event.clientY - rect.top) * 480 / Math.max(1, rect.height) };
			};
			const worldPoint = event => { const point = pointFromEvent(event); return { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom }; };
			const showNode = node => {
				selectedId = node.id;
				document.querySelector('[data-graph-title]').textContent = node.label;
				document.querySelector('[data-graph-description]').textContent = node.path || node.kind;
				document.querySelector('[data-graph-detail="type"]').textContent = node.type + ' | ' + node.kind;
				document.querySelector('[data-graph-detail="status"]').textContent = node.status + (node.conflicted ? ' | conflict recorded' : '');
				document.querySelector('[data-graph-detail="connections"]').textContent = node.incoming + ' incoming | ' + node.outgoing + ' outgoing';
				document.querySelector('[data-graph-detail="source"]').textContent = node.sourceEventId || 'Derived node';
				document.querySelector('[data-graph-detail="evidence"]').textContent = node.evidenceHash || node.contentHash || 'No direct content hash';
				document.querySelectorAll('.graph-node').forEach(element => { element.dataset.selected = String(element.dataset.nodeId === node.id); });
			};
			const naturalPosition = (node, index, group, ring) => {
				const radius = group.length === 1 && graph.nodes.length === 1 ? 0 : 58 + ring * 46;
				const angle = -Math.PI / 2 + Math.PI * 2 * index / Math.max(1, group.length) + ring * .31;
				return { x: 400 + Math.cos(angle) * radius, y: 240 + Math.sin(angle) * radius };
			};
			const renderGraph = () => {
				const query = (search?.value || '').trim().toLowerCase();
				const wantedType = typeFilter?.value || 'all';
				const direct = new Set(graph.nodes.filter(node => {
					const text = [node.label, node.path, node.kind, ...node.terms].filter(Boolean).join(' ').toLowerCase();
					return (wantedType === 'all' || node.type === wantedType) && (!query || text.includes(query));
				}).map(node => node.id));
				const expanded = new Set(direct);
				if (query) { for (const id of direct) { for (const neighbor of neighbors.get(id) || []) { if (wantedType === 'all' || nodeById.get(neighbor)?.type === wantedType) expanded.add(neighbor); } } }
				const visible = graph.nodes.filter(node => expanded.has(node.id)).sort((left, right) => right.importance - left.importance || left.id.localeCompare(right.id)).slice(0, 100);
				const visibleIds = new Set(visible.map(node => node.id));
				const types = ['worktree', 'memory', 'file', 'concept', 'directory', 'reference'].filter(type => visible.some(node => node.type === type));
				types.forEach((type, ring) => {
					const group = visible.filter(node => node.type === type);
					group.forEach((node, index) => { if (!positions.has(node.id)) positions.set(node.id, naturalPosition(node, index, group, ring)); });
				});
				edgeLayer.textContent = '';
				for (const edge of graph.edges) {
					if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
					const source = positions.get(edge.source), target = positions.get(edge.target);
					const line = svgElement('line');
					line.classList.add('graph-edge');
					line.dataset.source = edge.source; line.dataset.target = edge.target;
					line.setAttribute('x1', source.x); line.setAttribute('y1', source.y); line.setAttribute('x2', target.x); line.setAttribute('y2', target.y);
					line.setAttribute('opacity', String(Math.max(.22, Math.min(.8, edge.weight))));
					const title = svgElement('title'); title.textContent = edge.type; line.append(title); edgeLayer.append(line);
				}
				nodeLayer.textContent = '';
				for (const node of visible) {
					const position = positions.get(node.id);
					const group = svgElement('g'); group.classList.add('graph-node'); group.dataset.nodeId = node.id; group.dataset.selected = String(node.id === selectedId); group.dataset.dragging = 'false';
					group.setAttribute('transform', 'translate(' + position.x + ' ' + position.y + ')'); group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button'); group.setAttribute('aria-label', node.type + ': ' + node.label);
					const halo = svgElement('circle'); halo.classList.add('graph-halo'); halo.setAttribute('r', '11');
					const dot = svgElement('circle'); dot.classList.add('graph-dot'); dot.setAttribute('r', String(5 + Math.min(7, node.importance * 6))); dot.setAttribute('fill', colors[node.type]);
					const title = svgElement('title'); title.textContent = node.label + ' | ' + node.type;
					group.append(halo, dot, title);
					group.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.stopPropagation(); pointerState = { type: 'node', id: node.id, pointerId: event.pointerId }; group.dataset.dragging = 'true'; graphSvg.setPointerCapture(event.pointerId); showNode(node); });
					group.addEventListener('click', () => showNode(node));
					group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showNode(node); } });
					nodeLayer.append(group);
				}
				summary.textContent = visible.length + ' of ' + graph.nodes.length + ' bounded nodes | ' + graph.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)).length + ' visible links';
				if (selectedId && visibleIds.has(selectedId)) showNode(nodeById.get(selectedId));
			};
			hit.addEventListener('pointerdown', event => { if (event.button !== 0) return; const point = pointFromEvent(event); pointerState = { type: 'pan', pointerId: event.pointerId, point, origin: { ...pan } }; hit.dataset.panning = 'true'; graphSvg.setPointerCapture(event.pointerId); });
			graphSvg.addEventListener('pointermove', event => {
				if (!pointerState || pointerState.pointerId !== event.pointerId) return;
				if (pointerState.type === 'pan') { const point = pointFromEvent(event); pan = { x: pointerState.origin.x + point.x - pointerState.point.x, y: pointerState.origin.y + point.y - pointerState.point.y }; applyScene(); return; }
				const position = worldPoint(event); positions.set(pointerState.id, position); const group = nodeLayer.querySelector('[data-node-id="' + CSS.escape(pointerState.id) + '"]'); if (group) group.setAttribute('transform', 'translate(' + position.x + ' ' + position.y + ')');
				for (const line of edgeLayer.querySelectorAll('line')) { if (line.dataset.source === pointerState.id) { line.setAttribute('x1', position.x); line.setAttribute('y1', position.y); } if (line.dataset.target === pointerState.id) { line.setAttribute('x2', position.x); line.setAttribute('y2', position.y); } }
			});
			const finishPointer = event => { if (!pointerState || pointerState.pointerId !== event.pointerId) return; hit.dataset.panning = 'false'; nodeLayer.querySelectorAll('.graph-node').forEach(node => { node.dataset.dragging = 'false'; }); try { graphSvg.releasePointerCapture(event.pointerId); } catch {} pointerState = null; };
			graphSvg.addEventListener('pointerup', finishPointer); graphSvg.addEventListener('pointercancel', finishPointer);
			graphSvg.addEventListener('wheel', event => { event.preventDefault(); const point = pointFromEvent(event); const next = Math.max(.55, Math.min(2.5, zoom * (event.deltaY < 0 ? 1.12 : .89))); const world = { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom }; zoom = next; pan = { x: point.x - world.x * zoom, y: point.y - world.y * zoom }; applyScene(); }, { passive: false });
			document.querySelector('[data-graph-zoom-in]')?.addEventListener('click', () => { zoom = Math.min(2.5, zoom * 1.2); applyScene(); });
			document.querySelector('[data-graph-zoom-out]')?.addEventListener('click', () => { zoom = Math.max(.55, zoom / 1.2); applyScene(); });
			document.querySelector('[data-graph-reset]')?.addEventListener('click', () => { positions.clear(); pan = { x: 0, y: 0 }; zoom = 1; selectedId = null; applyScene(); renderGraph(); });
			search?.addEventListener('input', renderGraph); typeFilter?.addEventListener('change', renderGraph); applyScene(); renderGraph();
		}
	</script>
</body>
</html>`;
	}
}

function renderMemoryGraph(state: DashboardState, strings: WebviewStrings): string {
	if (state.memory.status === 'loading' || state.memory.status === 'not-loaded') {
		return `<section class="card memory-graph studio-only"><h2>${escapeHtml(strings.memoryGraph)}</h2><p class="empty">${escapeHtml(strings.loadingMemory)}</p></section>`;
	}
	const snapshot = state.memory.snapshot;
	if (state.memory.status === 'unavailable' || !snapshot) {
		return `<section class="card memory-graph studio-only"><h2>${escapeHtml(strings.memoryGraph)}</h2><p class="empty">${escapeHtml(strings.memoryUnavailable)}</p><div class="actions"><button class="secondary" data-memory-refresh type="button">${escapeHtml(strings.refresh)}</button></div></section>`;
	}
	if (snapshot.nodes.length === 0) {
		return `<section class="card memory-graph studio-only"><h2>${escapeHtml(strings.memoryGraph)}</h2><p>${escapeHtml(strings.memoryGraphDescription)}</p><p class="empty">${escapeHtml(strings.memoryEmpty)}</p><p class="graph-summary">${escapeHtml(strings.graphManifest)} <code>${escapeHtml(snapshot.graphManifestHash)}</code></p></section>`;
	}
	return `<section class="card memory-graph studio-only" aria-labelledby="memory-graph-title">
		<h2 id="memory-graph-title">${escapeHtml(strings.memoryGraph)}</h2>
		<p>${escapeHtml(strings.memoryGraphDescription)}</p>
		<div class="graph-controls">
			<label class="field"><span>${escapeHtml(strings.searchNodes)}</span><input data-graph-search type="search" maxlength="160" placeholder="${escapeHtml(strings.searchNodesPlaceholder)}"></label>
			<label class="field"><span>${escapeHtml(strings.nodeType)}</span><select data-graph-type><option value="all">${escapeHtml(strings.allTypes)}</option><option value="worktree">${escapeHtml(strings.worktrees)}</option><option value="memory">${escapeHtml(strings.memories)}</option><option value="file">${escapeHtml(strings.files)}</option><option value="concept">${escapeHtml(strings.concepts)}</option><option value="directory">${escapeHtml(strings.directories)}</option><option value="reference">${escapeHtml(strings.references)}</option></select></label>
			<div class="actions"><button class="secondary" data-graph-zoom-in type="button" aria-label="${escapeHtml(strings.zoomIn)}">+</button><button class="secondary" data-graph-zoom-out type="button" aria-label="${escapeHtml(strings.zoomOut)}">-</button><button class="secondary" data-graph-reset type="button">${escapeHtml(strings.reset)}</button></div>
		</div>
		<div class="graph-viewport"><svg class="graph-canvas" data-memory-graph viewBox="0 0 800 480" role="img" aria-label="${escapeHtml(strings.memoryGraphAria)}"><rect class="graph-hit" data-graph-hit x="0" y="0" width="800" height="480"></rect><g data-graph-scene><g data-graph-edges></g><g data-graph-nodes></g></g></svg></div>
		<output class="graph-summary" data-graph-summary aria-live="polite"></output>
		<div class="graph-legend"><span><i data-type="worktree"></i>${escapeHtml(strings.worktrees)}</span><span><i data-type="memory"></i>${escapeHtml(strings.memories)}</span><span><i data-type="file"></i>${escapeHtml(strings.files)}</span><span><i data-type="concept"></i>${escapeHtml(strings.concepts)}</span><span><i data-type="directory"></i>${escapeHtml(strings.directories)}</span><span><i data-type="reference"></i>${escapeHtml(strings.references)}</span></div>
		<aside class="graph-details" aria-live="polite"><h3 data-graph-title>${escapeHtml(strings.chooseNode)}</h3><p data-graph-description>${escapeHtml(strings.chooseNodeDescription)}</p><dl class="receipt"><dt>${escapeHtml(strings.nodeType)}</dt><dd data-graph-detail="type">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.status)}</dt><dd data-graph-detail="status">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.connections)}</dt><dd data-graph-detail="connections">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.sourceEvent)}</dt><dd><code data-graph-detail="source">${escapeHtml(strings.unavailable)}</code></dd><dt>${escapeHtml(strings.evidence)}</dt><dd><code data-graph-detail="evidence">${escapeHtml(strings.unavailable)}</code></dd></dl></aside>
		<p class="graph-summary">${escapeHtml(strings.graphManifest)} <code>${escapeHtml(snapshot.graphManifestHash)}</code><br>${escapeHtml(strings.ledgerHead)} <code>${escapeHtml(snapshot.ledgerHeadHash ?? strings.unavailable)}</code></p>
	</section>`;
}

function serializeForHtml(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll('<', '\\u003c')
		.replaceAll('\u2028', '\\u2028')
		.replaceAll('\u2029', '\\u2029');
}

function renderProviderCards(state: DashboardState, strings: WebviewStrings): string {
	if (state.providersStatus === 'loading' || state.providersStatus === 'not-loaded') {
		return `<p class="empty">${escapeHtml(strings.loadingProviders)}</p>`;
	}
	if (state.providersStatus === 'unavailable') {
		return `<p class="empty">${escapeHtml(strings.providersUnavailable)}</p>`;
	}
	if (state.providers.length === 0) {
		return `<p class="empty">${escapeHtml(strings.noProviders)}</p>`;
	}
	return state.providers.map(provider => {
		const health = state.providerHealth[provider.name];
		const healthLabel = health?.detail ?? strings.notTested;
		return `<article class="provider-card">
			<div>
				<strong>${escapeHtml(provider.name)}</strong>
				<p>${escapeHtml(provider.model)}</p>
				<div class="provider-meta"><span>${escapeHtml(provider.kind)}</span><span>${escapeHtml(provider.credentialType)}</span><span>${escapeHtml(healthLabel)}</span></div>
			</div>
			<div class="provider-actions"><button class="secondary" data-provider-test="${escapeHtml(provider.name)}" type="button"${health?.status === 'testing' ? ' disabled' : ''}>${escapeHtml(strings.test)}</button><button class="secondary" data-provider-remove="${escapeHtml(provider.name)}" type="button">${escapeHtml(strings.remove)}</button></div>
		</article>`;
	}).join('');
}

function renderAgentSurface(state: DashboardState, strings: WebviewStrings): string {
	const running = state.agent.status === 'running';
	const providerOptions = state.providers.length === 0
		? `<option value="">${escapeHtml(strings.noProviders)}</option>`
		: state.providers.map(provider => `<option value="${escapeHtml(provider.name)}"${state.agent.providerName === provider.name ? ' selected' : ''}>${escapeHtml(`${provider.name} | ${provider.model}`)}</option>`).join('');
	const statusTone = state.agent.status === 'failed' || state.agent.status === 'cancelled' ? 'error' : 'normal';
	const output = state.agent.output === undefined
		? ''
		: `<div class="agent-receipt"><h2>${escapeHtml(strings.providerOutput)}</h2><pre class="agent-output" tabindex="0">${escapeHtml(state.agent.output)}</pre></div>`;
	const identity = state.agent.sessionId
		? `<dl class="receipt"><dt>${escapeHtml(strings.session)}</dt><dd><code>${escapeHtml(state.agent.sessionId)}</code></dd><dt>${escapeHtml(strings.call)}</dt><dd><code>${escapeHtml(state.agent.callId ?? strings.unavailable)}</code></dd><dt>${escapeHtml(strings.usageBasis)}</dt><dd>${escapeHtml(state.agent.usage?.measurement ?? strings.unavailable)}</dd></dl>`
		: '';
	return `<section class="card agent-surface" aria-labelledby="agent-run-title">
		<h2 id="agent-run-title">${escapeHtml(strings.agentRun)}</h2>
		<p>${escapeHtml(strings.agentRunDescription)}</p>
		<form class="agent-form" data-agent-form autocomplete="off">
			<label class="field"><span>${escapeHtml(strings.provider)}</span><select name="providerName"${running || state.providers.length === 0 ? ' disabled' : ''}>${providerOptions}</select></label>
			<label class="field"><span>${escapeHtml(strings.prompt)}</span><textarea name="prompt" maxlength="65536" placeholder="${escapeHtml(strings.promptPlaceholder)}"${running || state.providers.length === 0 ? ' disabled' : ''} required></textarea></label>
			<label class="field"><span>${escapeHtml(strings.maximumOutputTokens)}</span><input name="maxOutputTokens" type="number" min="1" max="32768" step="1" value="1024"${running || state.providers.length === 0 ? ' disabled' : ''}></label>
			<label class="consent"><input data-network-consent type="checkbox"${running || state.providers.length === 0 ? ' disabled' : ''}><span>${escapeHtml(strings.networkConsent)}</span></label>
			<div class="actions"><button data-agent-run type="submit"${running || state.providers.length === 0 ? ' disabled' : ''}>${escapeHtml(strings.runAgent)}</button>${running ? `<button class="secondary" data-agent-cancel type="button">${escapeHtml(strings.cancel)}</button>` : ''}</div>
		</form>
		<div class="agent-status" data-tone="${statusTone}" role="status">${escapeHtml(agentStatusLabel(state.agent, strings))}</div>
		${output}${identity}
		${state.agent.sessionId ? `<div class="actions"><button class="secondary" data-receipts-refresh type="button"${state.agent.receiptsStatus === 'loading' ? ' disabled' : ''}>${escapeHtml(strings.refreshReceipts)}</button></div>` : ''}
	</section>`;
}

function renderReceipt(receipt: FikeyaProviderReceipt | undefined, agent: AgentSurfaceState, strings: WebviewStrings): string {
	if (!receipt) {
		const status = agent.receiptsStatus === 'loading' ? strings.loadingReceipts : agent.receiptsStatus === 'unavailable' ? strings.receiptsUnavailable : strings.noReceipt;
		return `<p class="empty">${escapeHtml(status)}</p>`;
	}
	return `<dl class="receipt">
		<dt>${escapeHtml(strings.provider)}</dt><dd>${escapeHtml(receipt.provider)}</dd>
		<dt>${escapeHtml(strings.model)}</dt><dd>${escapeHtml(receipt.model)}</dd>
		<dt>${escapeHtml(strings.apiMode)}</dt><dd>${escapeHtml(receipt.apiMode)}</dd>
		<dt>${escapeHtml(strings.httpStatus)}</dt><dd>${receipt.statusCode}</dd>
		<dt>${escapeHtml(strings.duration)}</dt><dd>${receipt.durationMs.toLocaleString()} ms</dd>
		<dt>${escapeHtml(strings.inputTokens)}</dt><dd>${escapeHtml(formatUsageValue(receipt.inputTokens))}</dd>
		<dt>${escapeHtml(strings.outputTokens)}</dt><dd>${escapeHtml(formatUsageValue(receipt.outputTokens))}</dd>
		<dt>${escapeHtml(strings.cachedInputTokens)}</dt><dd>${escapeHtml(formatUsageValue(receipt.cachedInputTokens))}</dd>
		<dt>${escapeHtml(strings.requestEvidence)}</dt><dd><code>${escapeHtml(receipt.requestSha256)}</code><br>${receipt.requestBytes.toLocaleString()} bytes</dd>
		<dt>${escapeHtml(strings.responseEvidence)}</dt><dd><code>${escapeHtml(receipt.responseSha256)}</code><br>${receipt.responseBytes.toLocaleString()} bytes</dd>
	</dl>`;
}

function agentStatusLabel(agent: AgentSurfaceState, strings: WebviewStrings): string {
	switch (agent.status) {
		case 'running':
			return strings.waitingForProvider;
		case 'completed':
			return strings.runCompleted;
		case 'cancelled':
		case 'failed':
			return agent.failure ?? strings.runFailed;
		default:
			return strings.agentIdle;
	}
}

function formatUsageValue(value: number | null | undefined): string {
	return typeof value === 'number' ? value.toLocaleString() : vscode.l10n.t('Unavailable');
}

function providerStatusSummary(state: DashboardState, strings: WebviewStrings): string {
	if (state.providersStatus === 'loading' || state.providersStatus === 'not-loaded') {
		return strings.loading;
	}
	if (state.providersStatus === 'unavailable') {
		return strings.unavailable;
	}
	return state.providers.length === 1 ? vscode.l10n.t('1 Runtime Profile') : vscode.l10n.t('{0} Runtime Profiles', state.providers.length);
}

interface WebviewStrings {
	readonly fikeya: string;
	readonly localFirstWorkbench: string;
	readonly subtitle: string;
	readonly layout: string;
	readonly mode: string;
	readonly studio: string;
	readonly agentFocus: string;
	readonly editor: string;
	readonly agent: string;
	readonly terminal: string;
	readonly review: string;
	readonly activeMode: string;
	readonly agentFocusDescription: string;
	readonly workspaceStatus: string;
	readonly workspace: string;
	readonly runtime: string;
	readonly tokens: string;
	readonly estimatedCost: string;
	readonly unavailable: string;
	readonly metricsDisclaimer: string;
	readonly getStarted: string;
	readonly initialized: string;
	readonly notInitialized: string;
	readonly getStartedDescription: string;
	readonly initializeWorkspace: string;
	readonly runDoctor: string;
	readonly qarinahMemory: string;
	readonly qarinahDescription: string;
	readonly memoryGraph: string;
	readonly loadingMemory: string;
	readonly memoryUnavailable: string;
	readonly memoryGraphDescription: string;
	readonly memoryEmpty: string;
	readonly graphManifest: string;
	readonly ledgerHead: string;
	readonly searchNodes: string;
	readonly searchNodesPlaceholder: string;
	readonly nodeType: string;
	readonly allTypes: string;
	readonly worktrees: string;
	readonly memories: string;
	readonly files: string;
	readonly concepts: string;
	readonly directories: string;
	readonly references: string;
	readonly zoomIn: string;
	readonly zoomOut: string;
	readonly reset: string;
	readonly memoryGraphAria: string;
	readonly chooseNode: string;
	readonly chooseNodeDescription: string;
	readonly status: string;
	readonly connections: string;
	readonly sourceEvent: string;
	readonly providers: string;
	readonly providersDescription: string;
	readonly runtimeProvidersNotChecked: string;
	readonly notConfigured: string;
	readonly configureProvider: string;
	readonly refresh: string;
	readonly loading: string;
	readonly loadingProviders: string;
	readonly providersUnavailable: string;
	readonly noProviders: string;
	readonly notTested: string;
	readonly test: string;
	readonly remove: string;
	readonly agentRun: string;
	readonly agentRunDescription: string;
	readonly provider: string;
	readonly prompt: string;
	readonly promptPlaceholder: string;
	readonly maximumOutputTokens: string;
	readonly networkConsent: string;
	readonly runAgent: string;
	readonly cancel: string;
	readonly agentIdle: string;
	readonly waitingForProvider: string;
	readonly runCompleted: string;
	readonly runFailed: string;
	readonly providerOutput: string;
	readonly session: string;
	readonly call: string;
	readonly usageBasis: string;
	readonly refreshReceipts: string;
	readonly loadingReceipts: string;
	readonly receiptsUnavailable: string;
	readonly latestCallReceipt: string;
	readonly model: string;
	readonly apiMode: string;
	readonly httpStatus: string;
	readonly duration: string;
	readonly cachedInputTokens: string;
	readonly requestEvidence: string;
	readonly responseEvidence: string;
	readonly approvalsQueue: string;
	readonly noApprovals: string;
	readonly contextReceipt: string;
	readonly inputTokens: string;
	readonly outputTokens: string;
	readonly providerCost: string;
	readonly evidence: string;
	readonly noReceipt: string;
	readonly notChecked: string;
	readonly checking: string;
	readonly ready: string;
	readonly needsAttention: string;
}

function getWebviewStrings(): WebviewStrings {
	return {
		fikeya: vscode.l10n.t('Fikeya'),
		localFirstWorkbench: vscode.l10n.t('Local-First Coding Agent Workbench'),
		subtitle: vscode.l10n.t('Choose a mode, connect your provider, and keep verified project context close to the work.'),
		layout: vscode.l10n.t('Layout'),
		mode: vscode.l10n.t('Mode'),
		studio: vscode.l10n.t('Studio'),
		agentFocus: vscode.l10n.t('Agent Focus'),
		editor: vscode.l10n.t('Editor'),
		agent: vscode.l10n.t('Agent'),
		terminal: vscode.l10n.t('Terminal'),
		review: vscode.l10n.t('Review'),
		activeMode: vscode.l10n.t('Active Mode'),
		agentFocusDescription: vscode.l10n.t('The focused layout keeps the current mode and its controls visible.'),
		workspaceStatus: vscode.l10n.t('Workspace Status'),
		workspace: vscode.l10n.t('Workspace'),
		runtime: vscode.l10n.t('Runtime'),
		tokens: vscode.l10n.t('Tokens'),
		estimatedCost: vscode.l10n.t('Estimated Cost'),
		unavailable: vscode.l10n.t('Unavailable'),
		metricsDisclaimer: vscode.l10n.t('Token counts are shown only when the provider reports them. Fikeya does not estimate provider billing here.'),
		getStarted: vscode.l10n.t('Get Started'),
		initialized: vscode.l10n.t('Initialized'),
		notInitialized: vscode.l10n.t('Not Initialized'),
		getStartedDescription: vscode.l10n.t('Initialize the local workspace, then run doctor to verify the runtime and memory connection.'),
		initializeWorkspace: vscode.l10n.t('Initialize Workspace'),
		runDoctor: vscode.l10n.t('Run Doctor'),
		qarinahMemory: vscode.l10n.t('Qarinah Memory'),
		qarinahDescription: vscode.l10n.t('Qarinah supplies evidence-linked memory and context receipts for this workspace.'),
		memoryGraph: vscode.l10n.t('Verified Project Memory Graph'),
		loadingMemory: vscode.l10n.t('Loading the bounded local graph from Qarinah.'),
		memoryUnavailable: vscode.l10n.t('No verified graph is available. Initialize this workspace and make sure the pinned Qarinah sidecar is installed.'),
		memoryGraphDescription: vscode.l10n.t('Search and inspect the real bounded project graph. Drag nodes, pan the canvas, and zoom without sending graph data to a network service.'),
		memoryEmpty: vscode.l10n.t('The verified graph currently contains no displayable nodes. No demo data was substituted.'),
		graphManifest: vscode.l10n.t('Graph manifest:'),
		ledgerHead: vscode.l10n.t('Ledger head:'),
		searchNodes: vscode.l10n.t('Search Nodes'),
		searchNodesPlaceholder: vscode.l10n.t('Decision, file, concept, or path'),
		nodeType: vscode.l10n.t('Node Type'),
		allTypes: vscode.l10n.t('All Types'),
		worktrees: vscode.l10n.t('Worktrees'),
		memories: vscode.l10n.t('Memories'),
		files: vscode.l10n.t('Files'),
		concepts: vscode.l10n.t('Concepts'),
		directories: vscode.l10n.t('Directories'),
		references: vscode.l10n.t('References'),
		zoomIn: vscode.l10n.t('Zoom In'),
		zoomOut: vscode.l10n.t('Zoom Out'),
		reset: vscode.l10n.t('Reset'),
		memoryGraphAria: vscode.l10n.t('Interactive bounded Qarinah project-memory graph'),
		chooseNode: vscode.l10n.t('Choose a Node'),
		chooseNodeDescription: vscode.l10n.t('Select a node to inspect its local provenance and evidence identity.'),
		status: vscode.l10n.t('Status'),
		connections: vscode.l10n.t('Connections'),
		sourceEvent: vscode.l10n.t('Source Event'),
		providers: vscode.l10n.t('Provider Profiles'),
		providersDescription: vscode.l10n.t('Provider metadata stays in Fikeya state. API credentials remain in OS-backed secret stores.'),
		runtimeProvidersNotChecked: vscode.l10n.t('Run doctor to reconcile runtime profiles'),
		notConfigured: vscode.l10n.t('Not Configured'),
		configureProvider: vscode.l10n.t('Configure Provider'),
		refresh: vscode.l10n.t('Refresh'),
		loading: vscode.l10n.t('Loading'),
		loadingProviders: vscode.l10n.t('Loading provider profiles from Fikeya Runtime.'),
		providersUnavailable: vscode.l10n.t('Provider profiles are unavailable. Install the CLI or run doctor for details.'),
		noProviders: vscode.l10n.t('No runtime provider profiles are configured.'),
		notTested: vscode.l10n.t('Not tested'),
		test: vscode.l10n.t('Test'),
		remove: vscode.l10n.t('Remove'),
		agentRun: vscode.l10n.t('Agent Run'),
		agentRunDescription: vscode.l10n.t('Send one bounded prompt to a live runtime provider. Prompt and output content stay ephemeral in this view.'),
		provider: vscode.l10n.t('Provider'),
		prompt: vscode.l10n.t('Prompt'),
		promptPlaceholder: vscode.l10n.t('Describe the coding task or question.'),
		maximumOutputTokens: vscode.l10n.t('Maximum Output Tokens'),
		networkConsent: vscode.l10n.t('Allow this run to make one provider network request. Consent resets after every run.'),
		runAgent: vscode.l10n.t('Run Agent'),
		cancel: vscode.l10n.t('Cancel'),
		agentIdle: vscode.l10n.t('Choose a provider and enter a prompt. No network request occurs until you confirm it for this run.'),
		waitingForProvider: vscode.l10n.t('Waiting for the completed provider response. This alpha does not claim token streaming.'),
		runCompleted: vscode.l10n.t('Provider response completed. Usage and evidence below come from the durable runtime receipt.'),
		runFailed: vscode.l10n.t('The provider run failed safely. Provider response bodies were not retained.'),
		providerOutput: vscode.l10n.t('Ephemeral Provider Output'),
		session: vscode.l10n.t('Session'),
		call: vscode.l10n.t('Call'),
		usageBasis: vscode.l10n.t('Usage Basis'),
		refreshReceipts: vscode.l10n.t('Refresh Receipts'),
		loadingReceipts: vscode.l10n.t('Loading the durable call receipt.'),
		receiptsUnavailable: vscode.l10n.t('The call receipt is unavailable.'),
		latestCallReceipt: vscode.l10n.t('Latest Call Receipt'),
		model: vscode.l10n.t('Model'),
		apiMode: vscode.l10n.t('API Mode'),
		httpStatus: vscode.l10n.t('HTTP Status'),
		duration: vscode.l10n.t('Duration'),
		cachedInputTokens: vscode.l10n.t('Cached Input Tokens'),
		requestEvidence: vscode.l10n.t('Request Evidence'),
		responseEvidence: vscode.l10n.t('Response Evidence'),
		approvalsQueue: vscode.l10n.t('Approvals Queue'),
		noApprovals: vscode.l10n.t('No approvals are waiting.'),
		contextReceipt: vscode.l10n.t('Context Receipt'),
		inputTokens: vscode.l10n.t('Input Tokens'),
		outputTokens: vscode.l10n.t('Output Tokens'),
		providerCost: vscode.l10n.t('Provider Cost'),
		evidence: vscode.l10n.t('Evidence'),
		noReceipt: vscode.l10n.t('No provider receipt yet'),
		notChecked: vscode.l10n.t('Not Checked'),
		checking: vscode.l10n.t('Checking'),
		ready: vscode.l10n.t('Ready'),
		needsAttention: vscode.l10n.t('Needs Attention')
	};
}

function getProviderDefinitions(): readonly ProviderDefinition[] {
	return [
		{
			id: 'azure-openai',
			label: vscode.l10n.t('Azure with Entra ID'),
			detail: vscode.l10n.t('Use the local Azure identity without storing a provider secret.'),
			runtimeKind: 'azure-openai',
			credentialType: 'entra-id',
			defaultBaseUrl: ''
		},
		{
			id: 'openai',
			label: vscode.l10n.t('OpenAI'),
			detail: vscode.l10n.t('Connect with a user-owned API credential.'),
			runtimeKind: 'openai',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.openai.com/v1',
			secretPrompt: vscode.l10n.t('Enter the OpenAI API Key')
		},
		{
			id: 'anthropic',
			label: vscode.l10n.t('Anthropic'),
			detail: vscode.l10n.t('Connect with a user-owned API credential.'),
			runtimeKind: 'anthropic',
			credentialType: 'api-key',
			defaultBaseUrl: 'https://api.anthropic.com/v1',
			secretPrompt: vscode.l10n.t('Enter the Anthropic API Key')
		},
		{
			id: 'openrouter',
			label: vscode.l10n.t('OpenRouter'),
			detail: vscode.l10n.t('Route to compatible models with a local secret.'),
			runtimeKind: 'openrouter',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://openrouter.ai/api/v1',
			secretPrompt: vscode.l10n.t('Enter the OpenRouter API Key')
		},
		{
			id: 'nvidia-nim',
			label: vscode.l10n.t('NVIDIA NIM'),
			detail: vscode.l10n.t('Connect to hosted or self-hosted NIM endpoints.'),
			runtimeKind: 'nvidia-nim',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
			secretPrompt: vscode.l10n.t('Enter the NVIDIA NIM API Key')
		},
		{
			id: 'ollama',
			label: vscode.l10n.t('Ollama'),
			detail: vscode.l10n.t('Use a model running on this device.'),
			runtimeKind: 'ollama',
			credentialType: 'none',
			defaultBaseUrl: 'http://127.0.0.1:11434/v1'
		},
		{
			id: 'openai-compatible',
			label: vscode.l10n.t('OpenAI-Compatible'),
			detail: vscode.l10n.t('Connect to a custom compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: '',
			secretPrompt: vscode.l10n.t('Enter the Endpoint API Secret')
		}
	];
}

function getWorkspaceName(): string {
	return vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.l10n.t('No Local Workspace');
}

function getLocalWorkspacePath(): string | undefined {
	if (!vscode.workspace.isTrusted) {
		return undefined;
	}
	const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.scheme === 'file');
	return folder?.uri.fsPath;
}

function readStoredValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
	return value && allowed.includes(value as T) ? value as T : fallback;
}

function validateProviderUrl(value: string, required = false): string | undefined {
	if (!value.trim()) {
		return required ? vscode.l10n.t('Enter the provider endpoint URL.') : undefined;
	}
	try {
		const url = new URL(value);
		const localHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
		return url.protocol === 'https:' || localHttp ? undefined : vscode.l10n.t('Use HTTPS, or HTTP only for a localhost endpoint.');
	} catch {
		return vscode.l10n.t('Enter a valid URL.');
	}
}

function createProviderName(providerId: string, label: string): string {
	const normalized = label
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9._:-]+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
		.slice(0, 80);
	const prefix = normalized || providerId;
	return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function runtimeFailureMessage(failure: FikeyaRuntimeResult['failure']): string {
	switch (failure) {
		case 'not-found':
			return vscode.l10n.t('Fikeya CLI was not found. Install it, then run doctor again.');
		case 'timeout':
			return vscode.l10n.t('Fikeya CLI did not respond within 30 seconds.');
		case 'output-limit':
			return vscode.l10n.t('Fikeya CLI returned more output than the safe limit.');
		case 'invalid-json':
			return vscode.l10n.t('Fikeya CLI returned an invalid JSON report.');
		default:
			return vscode.l10n.t('Fikeya CLI reported a problem.');
	}
}

function runtimeLabel(runtime: DashboardState['runtime'], strings: WebviewStrings): string {
	switch (runtime) {
		case 'checking':
			return strings.checking;
		case 'ready':
			return strings.ready;
		case 'attention':
			return strings.needsAttention;
		default:
			return strings.notChecked;
	}
}

function modeLabel(mode: FikeyaMode, strings: WebviewStrings): string {
	switch (mode) {
		case 'editor':
			return strings.editor;
		case 'terminal':
			return strings.terminal;
		case 'review':
			return strings.review;
		default:
			return strings.agent;
	}
}

function modeWorkbenchCommand(mode: FikeyaMode): string {
	switch (mode) {
		case 'editor':
			return 'workbench.action.focusActiveEditorGroup';
		case 'terminal':
			return 'workbench.action.terminal.focus';
		case 'review':
			return 'workbench.view.scm';
		default:
			return 'workbench.view.extension.fikeya';
	}
}
