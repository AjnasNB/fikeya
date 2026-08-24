/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { escapeHtml, FikeyaLayout, FikeyaMode, fikeyaLayouts, fikeyaModes, parseWebviewMessage } from './messageValidation';
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

interface DashboardState {
	readonly layout: FikeyaLayout;
	readonly mode: FikeyaMode;
	readonly workspaceName: string;
	readonly providersStatus: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly providers: readonly FikeyaProviderProfile[];
	readonly providerHealth: Readonly<Record<string, ProviderHealth>>;
	readonly agent: AgentSurfaceState;
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
					break;
			}
		}));
		this.refresh();
		void this.refreshProviders(false);
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
		select, textarea, input[type="number"] { width: 100%; border: 1px solid var(--vscode-input-border, transparent); border-radius: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
		select, input[type="number"] { min-height: 30px; padding: 4px 7px; }
		textarea { min-height: 108px; resize: vertical; padding: 7px; line-height: 1.45; }
		select:focus-visible, textarea:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.consent { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; }
		.consent input { margin: 2px 0 0; }
		.agent-status { padding: 8px 9px; border-left: 2px solid var(--vscode-progressBar-background); background: var(--vscode-textBlockQuote-background); }
		.agent-status[data-tone="error"] { border-left-color: var(--vscode-errorForeground); }
		.agent-output { max-height: 360px; margin: 0; overflow: auto; padding: 10px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
		.agent-receipt { display: grid; gap: 8px; }
		.focus-only { display: none; }
		body[data-layout="agentFocus"] .studio-only { display: none; }
		body[data-layout="agentFocus"] .focus-only { display: grid; }
		.disclaimer { padding-left: 9px; border-left: 2px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
		@media (min-width: 520px) { .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
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
			</article>
		</section>
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
	</script>
</body>
</html>`;
	}
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
