/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { escapeHtml, FikeyaLayout, FikeyaMode, fikeyaLayouts, fikeyaModes, parseWebviewMessage } from './messageValidation';
import { configureFikeyaProvider, FikeyaProviderConfiguration, FikeyaRuntimeResult, runFikeyaRuntime } from './runtime';

const layoutStorageKey = 'fikeya.layout';
const modeStorageKey = 'fikeya.mode';
const providerProfilesStorageKey = 'fikeya.providerProfiles';
const providerSecretPrefix = 'fikeya.providerSecret.';

interface ProviderDefinition {
	readonly id: string;
	readonly label: string;
	readonly detail: string;
	readonly runtimeKind: FikeyaProviderConfiguration['kind'];
	readonly credentialType: FikeyaProviderConfiguration['credentialType'];
	readonly defaultBaseUrl: string;
	readonly secretPrompt?: string;
}

interface ProviderProfile {
	readonly id: string;
	readonly runtimeName: string;
	readonly providerId: string;
	readonly label: string;
	readonly model?: string;
	readonly baseUrl?: string;
	readonly hasSecret: boolean;
}

interface DashboardState {
	readonly layout: FikeyaLayout;
	readonly mode: FikeyaMode;
	readonly workspaceName: string;
	readonly providerProfiles: readonly ProviderProfile[];
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

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.state = {
			layout: readStoredValue(context.globalState.get<string>(layoutStorageKey), fikeyaLayouts, 'studio'),
			mode: readStoredValue(context.globalState.get<string>(modeStorageKey), fikeyaModes, 'agent'),
			workspaceName: getWorkspaceName(),
			providerProfiles: readProviderProfiles(context.globalState.get<readonly ProviderProfile[]>(providerProfilesStorageKey)),
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
			}
		}));
		this.refresh();
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
		const profileId = runtimeName;
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
		const secretStorageKey = `${providerSecretPrefix}${profileId}`;
		if (secret !== undefined) {
			await this.context.secrets.store(secretStorageKey, secret);
		}
		const title = vscode.l10n.t('Configuring {0}', provider.definition.label);
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => configureFikeyaProvider(configuration, workspacePath, secret));
		secret = undefined;
		if (!result.ok) {
			await this.context.secrets.delete(secretStorageKey);
			void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
			return;
		}

		const profile: ProviderProfile = {
			id: profileId,
			runtimeName,
			providerId: provider.definition.id,
			label: profileLabel.trim(),
			model: model.trim() || undefined,
			baseUrl: baseUrl.trim() || undefined,
			hasSecret: result.report?.secretConfigured ?? false
		};
		const providerProfiles = [...this.state.providerProfiles, profile];
		await this.context.globalState.update(providerProfilesStorageKey, providerProfiles);
		this.state = { ...this.state, providerProfiles, runtimeProviderCount: undefined };
		this.refresh();
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} was configured in Fikeya Runtime.', profile.label));
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
		const providerCards = getProviderDefinitions().map(definition => {
			const matchingProfiles = this.state.providerProfiles.filter(profile => profile.providerId === definition.id);
			const status = matchingProfiles.length === 0 ? strings.notConfigured : vscode.l10n.t('{0} Configured', matchingProfiles.length);
			return `<article class="provider-card"><div><strong>${escapeHtml(definition.label)}</strong><p>${escapeHtml(definition.detail)}</p></div><span class="status">${escapeHtml(status)}</span></article>`;
		}).join('');
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
		.empty { padding: 10px; border: 1px dashed var(--vscode-widget-border); color: var(--vscode-descriptionForeground); }
		.receipt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 9px; margin: 0; }
		.receipt dt { color: var(--vscode-descriptionForeground); }
		.receipt dd { margin: 0; overflow-wrap: anywhere; }
		.focus-only { display: none; }
		body[data-layout="agentFocus"] .studio-only { display: none; }
		body[data-layout="agentFocus"] .focus-only { display: grid; }
		.disclaimer { padding-left: 9px; border-left: 2px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
		@media (min-width: 520px) { .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
		@media (max-width: 280px) { .switcher.modes { grid-template-columns: repeat(2, minmax(0, 1fr)); } .provider-card { grid-template-columns: 1fr; } }
	</style>
</head>
<body data-layout="${this.state.layout}">
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
			<div class="kpi"><span>${escapeHtml(strings.tokens)}</span><strong>${escapeHtml(strings.unavailable)}</strong></div>
			<div class="kpi"><span>${escapeHtml(strings.estimatedCost)}</span><strong>${escapeHtml(strings.unavailable)}</strong></div>
		</section>
		<p class="disclaimer">${escapeHtml(strings.metricsDisclaimer)}</p>
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
			<span class="badge">${escapeHtml(runtimeProviderSummary(this.state.runtimeProviderCount, strings))}</span>
			<p>${escapeHtml(strings.providersDescription)}</p>
			<div class="providers">${providerCards}</div>
			<div class="actions"><button data-command="fikeya.configureProvider" type="button">${escapeHtml(strings.configureProvider)}</button></div>
		</section>
		<section class="grid two studio-only">
			<article class="card">
				<h2>${escapeHtml(strings.approvalsQueue)}</h2>
				<p class="empty">${escapeHtml(strings.noApprovals)}</p>
			</article>
			<article class="card">
				<h2>${escapeHtml(strings.contextReceipt)}</h2>
				<dl class="receipt"><dt>${escapeHtml(strings.inputTokens)}</dt><dd>${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.outputTokens)}</dt><dd>${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.providerCost)}</dt><dd>${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.evidence)}</dt><dd>${escapeHtml(strings.noReceipt)}</dd></dl>
			</article>
		</section>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'openCommand', command: button.dataset.command })));
		document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'selectMode', mode: button.dataset.mode })));
		document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'switchLayout', layout: button.dataset.layout })));
	</script>
</body>
</html>`;
	}
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
		metricsDisclaimer: vscode.l10n.t('Metrics remain unavailable until a real provider response.'),
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

function readProviderProfiles(value: readonly ProviderProfile[] | undefined): readonly ProviderProfile[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(profile => typeof profile?.id === 'string' && typeof profile.providerId === 'string' && typeof profile.label === 'string').map(profile => ({
		id: profile.id.slice(0, 200),
		runtimeName: typeof profile.runtimeName === 'string' ? profile.runtimeName.slice(0, 128) : profile.id.slice(0, 128),
		providerId: profile.providerId.slice(0, 80),
		label: profile.label.slice(0, 80),
		model: typeof profile.model === 'string' ? profile.model.slice(0, 160) : undefined,
		baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl.slice(0, 2048) : undefined,
		hasSecret: profile.hasSecret === true
	}));
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

function runtimeProviderSummary(count: number | undefined, strings: WebviewStrings): string {
	if (count === undefined) {
		return strings.runtimeProvidersNotChecked;
	}
	return count === 1 ? vscode.l10n.t('1 Runtime Profile') : vscode.l10n.t('{0} Runtime Profiles', count);
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
