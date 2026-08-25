/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { appendConversationMessage, FikeyaConversationMessage } from './conversation';
import { escapeHtml, parseWebviewMessage } from './messageValidation';
import { FikeyaMemorySnapshot, initializeQarinahMemory, loadQarinahMemory } from './memory';
import { captureCompletedFikeyaRun } from './sessionCapture';
import {
	configureFikeyaProvider,
	FikeyaAgentApproval,
	FikeyaAgentApprovalDecision,
	FikeyaAgentMemory,
	FikeyaAgentRunHandle,
	FikeyaAgentUsage,
	FikeyaCodingOutcome,
	FikeyaMemoryMode,
	FikeyaProviderConfiguration,
	FikeyaProviderProfile,
	FikeyaProviderReceipt,
	FikeyaRuntimeResult,
	FikeyaStatistics,
	loadFikeyaAgentReceipts,
	loadFikeyaStatistics,
	listFikeyaProviders,
	removeFikeyaProvider,
	runFikeyaRuntime,
	startFikeyaAgentRun,
	testFikeyaProvider
} from './runtime';

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
	readonly memory?: FikeyaAgentMemory;
	readonly outcome?: FikeyaCodingOutcome;
	readonly receiptsStatus: 'idle' | 'loading' | 'ready' | 'unavailable';
	readonly receipts: readonly FikeyaProviderReceipt[];
	readonly failure?: string;
}

interface MemorySurfaceState {
	readonly status: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly snapshot?: FikeyaMemorySnapshot;
}

interface StatisticsSurfaceState {
	readonly status: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly snapshot?: FikeyaStatistics;
}

type FikeyaWorkspaceMode = 'chat' | 'research' | 'context' | 'usage' | 'setup';

interface DashboardState {
	readonly isDesktop: boolean;
	readonly activeMode: FikeyaWorkspaceMode;
	readonly conversation: readonly FikeyaConversationMessage[];
	readonly workspaceName: string;
	readonly providersStatus: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly providers: readonly FikeyaProviderProfile[];
	readonly providerHealth: Readonly<Record<string, ProviderHealth>>;
	readonly agent: AgentSurfaceState;
	readonly memory: MemorySurfaceState;
	readonly statistics: StatisticsSurfaceState;
	readonly runtime: 'not-checked' | 'checking' | 'ready' | 'attention';
	readonly workspaceInitialized: boolean;
	readonly runtimeProviderCount?: number;
	readonly qarinah: string;
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new FikeyaWebviewViewProvider(context);
	const isFikeyaDesktop = vscode.env.appName === 'Fikeya' || vscode.env.appName === 'Fikeya Dev';
	void vscode.commands.executeCommand('setContext', 'fikeya.isDesktop', isFikeyaDesktop);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(FikeyaWebviewViewProvider.viewType, provider));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.open', () => provider.openWorkspacePanel('chat')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.configureProvider', async () => {
		await provider.configureProvider();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.initializeWorkspace', async () => {
		await provider.runRuntimeCommand('init');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.runDoctor', async () => {
		await provider.runRuntimeCommand('doctor');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.editor', async () => {
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.agent', () => provider.openWorkspacePanel('chat')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.terminal', async () => {
		await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.review', async () => {
		await vscode.commands.executeCommand('workbench.view.scm');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.research', () => provider.openWorkspacePanel('research')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.lab', () => provider.openWorkspacePanel('context')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.view.usage', () => provider.openWorkspacePanel('usage')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.view.setup', () => provider.openWorkspacePanel('setup')));
	if (isFikeyaDesktop) {
		void runDesktopOnboarding(context, provider);
	}
}

async function runDesktopOnboarding(context: vscode.ExtensionContext, provider: FikeyaWebviewViewProvider): Promise<void> {
	const onboardingKey = 'fikeya.desktop.onboarding.v1';
	if (context.globalState.get<boolean>(onboardingKey)) {
		return;
	}
	await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Fikeya Dark', vscode.ConfigurationTarget.Global);
	const selection = await vscode.window.showQuickPick([
		{
			label: vscode.l10n.t('Agent workspace'),
			description: vscode.l10n.t('Start with Fikeya Agent, providers, Qarinah memory, and local usage statistics.'),
			mode: 'chat'
		},
		{
			label: vscode.l10n.t('Code workspace'),
			description: vscode.l10n.t('Start with the familiar editor, Explorer, source control, and terminal.'),
			mode: 'editor'
		}
	], {
		title: vscode.l10n.t('Choose your Fikeya workspace'),
		placeHolder: vscode.l10n.t('You can switch modes later from the Command Palette.'),
		ignoreFocusOut: true
	});
	if (!selection) {
		return;
	}
	await context.globalState.update(onboardingKey, true);
	if (selection.mode === 'chat') {
		provider.openWorkspacePanel();
		await provider.configureProvider();
	} else {
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	}
}

class FikeyaWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'fikeya.dashboard';
	private static readonly panelViewType = 'fikeya.workspace';
	private view: vscode.WebviewView | undefined;
	private viewBinding: vscode.Disposable | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private panelBinding: vscode.Disposable | undefined;
	private state: DashboardState;
	private activeAgentRun: FikeyaAgentRunHandle | undefined;

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.state = {
			isDesktop: vscode.env.appName === 'Fikeya' || vscode.env.appName === 'Fikeya Dev',
			activeMode: 'chat',
			conversation: [],
			workspaceName: getWorkspaceName(),
			providersStatus: 'not-loaded',
			providers: [],
			providerHealth: {},
			agent: { status: 'idle', receiptsStatus: 'idle', receipts: [] },
			memory: { status: 'not-loaded' },
			statistics: { status: 'not-loaded' },
			runtime: 'not-checked',
			workspaceInitialized: false,
			runtimeProviderCount: undefined,
			qarinah: vscode.l10n.t('Not checked')
		};
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewBinding?.dispose();
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri]
		};
		const messageSubscription = this.bindWebview(webviewView.webview);
		const disposeSubscription = webviewView.onDidDispose(() => {
			if (this.view !== webviewView) {
				return;
			}
			this.view = undefined;
			const binding = this.viewBinding;
			this.viewBinding = undefined;
			binding?.dispose();
		});
		this.viewBinding = vscode.Disposable.from(messageSubscription, disposeSubscription);
		this.initializeSurface();
	}

	public openWorkspacePanel(mode: FikeyaWorkspaceMode = 'chat'): void {
		this.state = { ...this.state, activeMode: mode };
		if (this.panel) {
			this.refresh();
			this.panel.reveal(vscode.ViewColumn.Beside, false);
			return;
		}

		this.panelBinding?.dispose();
		const panel = vscode.window.createWebviewPanel(
			FikeyaWebviewViewProvider.panelViewType,
			vscode.l10n.t('Fikeya Chat'),
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [this.context.extensionUri],
				retainContextWhenHidden: true
			}
		);
		this.panel = panel;
		const messageSubscription = this.bindWebview(panel.webview);
		const disposeSubscription = panel.onDidDispose(() => {
			if (this.panel !== panel) {
				return;
			}
			this.panel = undefined;
			const binding = this.panelBinding;
			this.panelBinding = undefined;
			binding?.dispose();
		});
		this.panelBinding = vscode.Disposable.from(messageSubscription, disposeSubscription);
		this.initializeSurface();
	}

	public dispose(): void {
		this.activeAgentRun?.cancel();
		this.activeAgentRun = undefined;
		this.viewBinding?.dispose();
		this.viewBinding = undefined;
		this.view = undefined;
		const panel = this.panel;
		this.panel = undefined;
		this.panelBinding?.dispose();
		this.panelBinding = undefined;
		panel?.dispose();
	}

	private bindWebview(webview: vscode.Webview): vscode.Disposable {
		return webview.onDidReceiveMessage(value => {
			void this.handleWebviewMessage(value).catch(() => {
				void vscode.window.showErrorMessage(vscode.l10n.t('Fikeya could not process that action. Try again or run doctor.'));
			});
		});
	}

	private initializeSurface(): void {
		this.refresh();
		if (this.state.providersStatus === 'not-loaded') {
			void this.refreshProviders(false);
		}
		if (this.state.memory.status === 'not-loaded') {
			void this.refreshMemory(false);
		}
		if (this.state.statistics.status === 'not-loaded') {
			void this.refreshStatistics(false);
		}
	}

	private async handleWebviewMessage(value: unknown): Promise<void> {
		const message = parseWebviewMessage(value);
		if (!message) {
			return;
		}

		switch (message.type) {
			case 'openCommand':
				await vscode.commands.executeCommand(message.command);
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
				await this.runAgent(message.providerName, message.prompt, message.maxOutputTokens, message.contextMaxCharacters, message.memoryMode);
				break;
			case 'cancelAgent':
				this.cancelAgent();
				break;
			case 'clearConversation':
				if (this.state.agent.status !== 'running') {
					this.state = { ...this.state, conversation: [] };
					this.refresh();
				}
				break;
			case 'refreshReceipts':
				await this.refreshReceipts(true);
				break;
			case 'refreshStatistics':
				await this.refreshStatistics(true);
				break;
			case 'refreshMemory':
				await this.refreshMemory(true);
				break;
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
		const memoryInitialization = result.ok && command === 'init'
			? await initializeQarinahMemory(this.context.extensionPath, workspacePath)
			: undefined;
		this.applyRuntimeResult(result, command);
		if (result.ok) {
			if (memoryInitialization && !memoryInitialization.ok) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Fikeya initialized, but its pinned Qarinah memory could not be initialized.'));
			}
			await this.refreshMemory(false);
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

	private async runAgent(
		providerName: string,
		prompt: string,
		maxOutputTokens: number,
		contextMaxCharacters: number,
		memoryMode: FikeyaMemoryMode,
		attemptedProviderNames: ReadonlySet<string> = new Set()
	): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const profile = this.state.providers.find(provider => provider.name === providerName);
		if (!workspacePath || this.activeAgentRun || !profile) {
			return;
		}

		const conversation = attemptedProviderNames.size === 0
			? appendConversationMessage(this.state.conversation, createConversationMessage('user', prompt))
			: this.state.conversation;
		this.state = {
			...this.state,
			conversation,
			agent: {
				status: 'running',
				providerName,
				receiptsStatus: 'idle',
				receipts: []
			}
		};
		this.refresh();
		const operation = startFikeyaAgentRun(
			providerName,
			prompt,
			maxOutputTokens,
			contextMaxCharacters,
			memoryMode,
			workspacePath,
			request => this.approveAgentTool(request)
		);
		this.activeAgentRun = operation;
		const result = await operation.result;
		if (this.activeAgentRun !== operation) {
			return;
		}
		this.activeAgentRun = undefined;
		if (!result.ok || !result.value) {
			const cancelled = result.failure === 'cancelled';
			const attempted = new Set(attemptedProviderNames).add(providerName);
			const failure = cancelled
				? vscode.l10n.t('Run cancelled. No partial output was retained.')
				: runtimeFailureMessage(result.failure);
			this.state = {
				...this.state,
				conversation: appendConversationMessage(this.state.conversation, createConversationMessage('notice', failure, providerName, cancelled ? 'normal' : 'error')),
				agent: {
					status: cancelled ? 'cancelled' : 'failed',
					providerName,
					receiptsStatus: 'idle',
					receipts: [],
					failure
				}
			};
			this.refresh();
			if (result.failure === 'quota') {
				await this.offerProviderHandoff(prompt, maxOutputTokens, contextMaxCharacters, memoryMode, attempted);
			}
			return;
		}

		const completed = result.value.status === 'completed';
		this.state = {
			...this.state,
			conversation: appendConversationMessage(
				this.state.conversation,
				createConversationMessage(
					'assistant',
					result.value.output,
					providerName,
					completed ? 'normal' : 'error'
				)
			),
			agent: {
				status: completed ? 'completed' : 'cancelled',
				providerName,
				output: result.value.output,
				sessionId: result.value.sessionId,
				callId: result.value.callId,
				usage: result.value.usage,
				memory: result.value.memory,
				outcome: result.value.outcome,
				receiptsStatus: 'loading',
				receipts: [],
				failure: completed ? undefined : vscode.l10n.t('Run cancelled at an approval boundary. Completed tool receipts remain available below.')
			}
		};
		this.refresh();
		await this.refreshReceipts(false);
		await this.refreshStatistics(false);
		if (!completed) {
			return;
		}
		const capture = await captureCompletedFikeyaRun({
			extensionPath: this.context.extensionPath,
			workspacePath,
			prompt,
			profile,
			turn: result.value,
			receipts: this.state.agent.receipts
		});
		if (capture.ok) {
			await this.refreshMemory(false);
		}
	}

	private async offerProviderHandoff(
		prompt: string,
		maxOutputTokens: number,
		contextMaxCharacters: number,
		memoryMode: FikeyaMemoryMode,
		attemptedProviderNames: ReadonlySet<string>
	): Promise<void> {
		const alternatives = this.state.providers.filter(provider => !attemptedProviderNames.has(provider.name));
		if (alternatives.length === 0) {
			const configure = vscode.l10n.t('Configure Provider');
			const selected = await vscode.window.showWarningMessage(
				vscode.l10n.t('The provider reported that its current quota or rate limit is exhausted. Configure another model to continue with the same Qarinah project context.'),
				configure
			);
			if (selected === configure) {
				await this.configureProvider();
			}
			return;
		}
		const automaticKey = 'fikeya.agent.alwaysSwitchOnQuota.v1';
		let shouldSwitch = this.context.globalState.get<boolean>(automaticKey) === true;
		if (!shouldSwitch) {
			const choose = vscode.l10n.t('Choose Another Model');
			const always = vscode.l10n.t('Always Switch');
			const selected = await vscode.window.showWarningMessage(
				vscode.l10n.t('This model has reached a quota or rate limit. Continue with another configured model and retrieve the same Qarinah project context?'),
				{ modal: true },
				choose,
				always
			);
			if (selected !== choose && selected !== always) {
				return;
			}
			shouldSwitch = true;
			if (selected === always) {
				await this.context.globalState.update(automaticKey, true);
			}
		}
		if (!shouldSwitch) {
			return;
		}
		const target = alternatives.length === 1
			? alternatives[0]
			: (await vscode.window.showQuickPick(alternatives.map(provider => ({
				label: provider.name,
				description: `${provider.kind} · ${provider.model}`,
				provider
			})), {
				title: vscode.l10n.t('Continue with another configured model'),
				placeHolder: vscode.l10n.t('Fikeya will recompile the same task-relevant Qarinah context for this model.')
			}))?.provider;
		if (!target) {
			return;
		}
		void vscode.window.showInformationMessage(vscode.l10n.t('Continuing with {0} ({1}).', target.name, target.model));
		await this.runAgent(target.name, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, attemptedProviderNames);
	}

	private async approveAgentTool(request: FikeyaAgentApproval): Promise<FikeyaAgentApprovalDecision> {
		const allow = vscode.l10n.t('Allow Once');
		const deny = vscode.l10n.t('Deny Once');
		const cancel = vscode.l10n.t('Cancel Run');
		const exactArguments = JSON.stringify(request.arguments, null, 2);
		const selected = await vscode.window.showWarningMessage(
			vscode.l10n.t('Fikeya requests {0}', request.toolName),
			{
				modal: true,
				detail: `${request.summary}\n\n${vscode.l10n.t('Exact arguments')} (${request.argumentsSha256}):\n${exactArguments}`
			},
			allow,
			deny,
			cancel
		);
		if (selected === allow) {
			return 'allow_once';
		}
		if (selected === deny) {
			return 'deny_once';
		}
		return 'cancel';
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

	private async refreshStatistics(showFailure: boolean): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			this.state = { ...this.state, statistics: { status: 'unavailable', snapshot: this.state.statistics.snapshot } };
			this.refresh();
			return;
		}
		this.state = { ...this.state, statistics: { status: 'loading', snapshot: this.state.statistics.snapshot } };
		this.refresh();
		const result = await loadFikeyaStatistics(workspacePath);
		if (!result.ok || !result.value) {
			this.state = { ...this.state, statistics: { status: 'unavailable', snapshot: this.state.statistics.snapshot } };
			this.refresh();
			if (showFailure) {
				void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
			}
			return;
		}
		this.state = { ...this.state, statistics: { status: 'ready', snapshot: result.value } };
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
			this.view.webview.html = this.getHtml(this.view.webview, 'sidebar');
		}
		if (this.panel) {
			this.panel.webview.html = this.getHtml(this.panel.webview, 'editor');
		}
	}

	private getHtml(webview: vscode.Webview, surface: 'sidebar' | 'editor'): string {
		const nonce = randomBytes(16).toString('base64');
		const strings = getWebviewStrings();
		const providerCards = renderProviderCards(this.state, strings);
		const agentSurface = renderAgentSurface(this.state, strings, this.state.activeMode === 'research');
		const statisticsSurface = renderStatistics(this.state.statistics, strings);
		const memoryGraph = renderMemoryGraph(this.state, strings);
		const memoryGraphData = serializeForHtml(this.state.memory.snapshot ?? { nodes: [], edges: [] });
		const latestReceipt = this.state.agent.receipts.at(-1);
		const selectedProvider = this.state.providers.find(provider => provider.name === this.state.agent.providerName) ?? this.state.providers.at(0);
		const providerSummary = selectedProvider ? `${selectedProvider.name} / ${selectedProvider.model}` : strings.noProviderSelected;
		const usageBasis = this.state.agent.usage?.measurement ?? strings.noUsageRecorded;
		const contextStatus = formatContextStatus(this.state.agent.memory, strings);
		const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fikeya.svg'));
		const desktopNavigation = `<div class="workspace-navigation"><nav class="mode-switcher" aria-label="${escapeHtml(strings.workspaceModes)}">
			<button data-command="fikeya.mode.agent" data-active="${this.state.activeMode === 'chat'}" type="button">${escapeHtml(vscode.l10n.t('Chat'))}</button>
			<button data-command="fikeya.mode.research" data-active="${this.state.activeMode === 'research'}" type="button">${escapeHtml(vscode.l10n.t('Research'))}</button>
			<button data-command="fikeya.mode.lab" data-active="${this.state.activeMode === 'context'}" type="button">${escapeHtml(vscode.l10n.t('Context'))}</button>
			<button data-command="fikeya.view.usage" data-active="${this.state.activeMode === 'usage'}" type="button">${escapeHtml(vscode.l10n.t('Usage'))}</button>
			<button data-command="fikeya.view.setup" data-active="${this.state.activeMode === 'setup'}" type="button">${escapeHtml(vscode.l10n.t('Setup'))}</button>
		</nav><nav class="native-actions" aria-label="${escapeHtml(vscode.l10n.t('Workbench destinations'))}"><button class="quiet" data-command="fikeya.mode.editor" type="button">${escapeHtml(vscode.l10n.t('Code'))}</button><button class="quiet" data-command="fikeya.mode.terminal" type="button">${escapeHtml(strings.terminalMode)}</button><button class="quiet" data-command="fikeya.mode.review" type="button">${escapeHtml(strings.reviewMode)}</button></nav></div>`;
		const setupCards = `<section class="grid two compact-grid">
			<article class="card">
				<div class="card-heading"><h2>${escapeHtml(strings.getStarted)}</h2><span class="badge">${escapeHtml(this.state.workspaceInitialized ? strings.initialized : strings.notInitialized)}</span></div>
				<p>${escapeHtml(strings.getStartedDescription)}</p>
				<div class="actions"><button data-command="fikeya.initializeWorkspace" type="button">${escapeHtml(strings.initializeWorkspace)}</button><button data-command="fikeya.runDoctor" class="secondary" type="button">${escapeHtml(strings.runDoctor)}</button></div>
			</article>
			<article class="card">
				<div class="card-heading"><h2>${escapeHtml(strings.providers)}</h2><span class="badge">${escapeHtml(providerStatusSummary(this.state, strings))}</span></div>
				<div class="providers">${providerCards}</div>
				<div class="actions"><button data-command="fikeya.configureProvider" type="button">${escapeHtml(strings.configureProvider)}</button><button data-action="refresh-providers" class="secondary" type="button">${escapeHtml(strings.refresh)}</button></div>
			</article>
		</section>`;
		const activeContent = this.state.activeMode === 'context'
			? memoryGraph
			: this.state.activeMode === 'usage'
				? `${statisticsSurface}${this.state.agent.sessionId ? `<section class="card"><h2>${escapeHtml(strings.latestCallReceipt)}</h2>${renderReceipt(latestReceipt, this.state.agent, strings)}</section>` : ''}`
				: this.state.activeMode === 'setup'
					? setupCards
					: agentSurface;
		const sidebarContent = `<section class="sidebar-launch card">
			<h2>${escapeHtml(vscode.l10n.t('Chat beside your code'))}</h2>
			<p>${escapeHtml(vscode.l10n.t('Open the conversation in a right editor group, or jump directly to the verified Qarinah graph and local usage.'))}</p>
			<div class="sidebar-destinations"><button data-command="fikeya.mode.agent" type="button">${escapeHtml(vscode.l10n.t('Open Chat'))}</button><button data-command="fikeya.mode.lab" class="secondary" type="button">${escapeHtml(vscode.l10n.t('Open Context Graph'))}</button><button data-command="fikeya.view.usage" class="secondary" type="button">${escapeHtml(vscode.l10n.t('Open Usage'))}</button></div>
			<dl class="receipt compact-receipt"><dt>${escapeHtml(strings.providerAndModel)}</dt><dd>${escapeHtml(providerSummary)}</dd><dt>${escapeHtml(strings.runtime)}</dt><dd>${escapeHtml(runtimeLabel(this.state.runtime, strings))}</dd><dt>${escapeHtml(strings.context)}</dt><dd>${escapeHtml(contextStatus)}</dd></dl>
		</section>`;
		const editorContent = `${desktopNavigation}
		<section class="run-strip" aria-label="${escapeHtml(strings.runContext)}">
			<div class="run-metric provider"><span>${escapeHtml(strings.providerAndModel)}</span><strong>${escapeHtml(providerSummary)}</strong></div>
			<div class="run-metric"><span>${escapeHtml(strings.runtime)}</span><strong>${escapeHtml(runtimeLabel(this.state.runtime, strings))}</strong></div>
			<div class="run-metric"><span>${escapeHtml(strings.inputTokens)}</span><strong>${escapeHtml(formatUsageValue(this.state.agent.usage?.inputTokens, strings.waitingForFirstRun))}</strong></div>
			<div class="run-metric"><span>${escapeHtml(strings.cachedInputTokens)}</span><strong>${escapeHtml(formatUsageValue(this.state.agent.usage?.cachedInputTokens, strings.waitingForFirstRun))}</strong></div>
			<div class="run-metric"><span>${escapeHtml(strings.outputTokens)}</span><strong>${escapeHtml(formatUsageValue(this.state.agent.usage?.outputTokens, strings.waitingForFirstRun))}</strong></div>
			<div class="run-metric"><span>${escapeHtml(strings.context)}</span><strong>${escapeHtml(contextStatus)}</strong></div>
		</section>
		<p class="usage-basis">${escapeHtml(strings.usageSource)} ${escapeHtml(usageBasis)}. ${escapeHtml(strings.metricsDisclaimer)}</p>
		<div class="active-surface">${activeContent}</div>`;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>${escapeHtml(strings.fikeya)}</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
		body[data-surface="editor"] { background: var(--vscode-editor-background); }
		button { min-height: 30px; padding: 5px 9px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		button:disabled { cursor: not-allowed; opacity: .58; }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
		.shell { display: grid; max-width: 960px; gap: 12px; margin: 0 auto; padding: 12px; }
		body[data-surface="editor"] .shell { max-width: 1080px; gap: 10px; padding: 12px 16px 28px; }
		body[data-surface="editor"] .masthead { padding: 10px 12px; }
		body[data-surface="editor"] .masthead .subtitle { display: none; }
		body[data-surface="editor"] h1 { font-size: 18px; }
		.masthead { display: grid; gap: 7px; padding: 12px; border-top: 2px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); }
		.product-heading { display: flex; align-items: center; gap: 9px; }
		.product-mark { display: block; width: 32px; height: 32px; object-fit: contain; }
		.workspace-label { min-width: 0; margin-left: auto; overflow: hidden; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
		.eyebrow { margin: 0; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
		h1 { margin: 1px 0 0; font-size: 18px; line-height: 1.1; }
		.subtitle, p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; }
		.subtitle { max-width: 72ch; }
		.run-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--vscode-widget-border); }
		.run-metric { min-width: 0; padding: 8px 9px; background: var(--vscode-editorWidget-background); }
		.run-metric.provider { grid-column: 1 / -1; }
		.run-metric span { display: block; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.run-metric strong { display: block; margin-top: 3px; overflow-wrap: anywhere; font-size: 12px; font-variant-numeric: tabular-nums; }
		.usage-basis { color: var(--vscode-descriptionForeground); font-size: 10px; }
		.workspace-navigation { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
		.mode-switcher { display: grid; min-width: min(100%, 520px); grid-template-columns: repeat(5, minmax(0, 1fr)); border: 1px solid var(--vscode-widget-border); background: var(--vscode-widget-border); gap: 1px; }
		.mode-switcher button { min-width: 0; border: 0; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); font-size: 11px; }
		.mode-switcher button:hover { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.mode-switcher button[data-active="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
		.native-actions { display: flex; flex: 0 0 auto; gap: 3px; }
		button.quiet { min-height: 28px; border-color: var(--vscode-widget-border); color: var(--vscode-foreground); background: transparent; }
		button.quiet:hover { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.active-surface { display: grid; min-width: 0; gap: 10px; }
		.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
		.sidebar-launch { border-top: 2px solid var(--vscode-focusBorder); }
		.sidebar-destinations { display: grid; gap: 6px; }
		.compact-receipt { margin-top: 3px; }
			.statistics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--vscode-widget-border); }
			.statistics-metric { min-width: 0; padding: 9px; background: var(--vscode-editorWidget-background); }
			.statistics-metric span { display: block; color: var(--vscode-descriptionForeground); font-size: 10px; }
			.statistics-metric strong { display: block; margin-top: 3px; overflow-wrap: anywhere; font-size: 14px; font-variant-numeric: tabular-nums; }
			.statistics-status { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px; }
			.statistics-status dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; margin: 0; font-size: 11px; }
			.statistics-status dt { color: var(--vscode-descriptionForeground); }
			.statistics-status dd { margin: 0; overflow-wrap: anywhere; }
			.table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--vscode-widget-border); }
			table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
			th, td { padding: 7px 8px; border-bottom: 1px solid var(--vscode-widget-border); text-align: left; vertical-align: top; }
			th { color: var(--vscode-descriptionForeground); font-weight: 600; }
			tbody tr:last-child td { border-bottom: 0; }
			.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
		.grid { display: grid; gap: 8px; }
		.card { display: grid; gap: 8px; padding: 11px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
		.card h2 { margin: 0; font-size: 13px; }
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
		.agent-surface { display: grid; gap: 10px; padding: 0; overflow: hidden; }
		.agent-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
		.agent-heading-actions { display: flex; align-items: center; gap: 6px; }
		.agent-heading { padding: 12px 14px 0; }
		.agent-heading h2 { margin: 0; font-size: 16px; }
		.agent-heading p { margin-top: 3px; font-size: 11px; }
		.chat-thread { display: flex; min-height: 340px; max-height: min(62vh, 720px); flex-direction: column; gap: 16px; overflow: auto; padding: 20px 16px; border-block: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); scroll-behavior: smooth; }
		.chat-empty { display: grid; place-content: center; max-width: 54ch; min-height: 290px; margin: auto; text-align: left; }
		.chat-empty strong { font-size: 18px; }
		.chat-empty p { margin-top: 7px; }
		.prompt-suggestions { display: grid; gap: 6px; margin-top: 18px; }
		.prompt-suggestions button { width: 100%; text-align: left; }
		.chat-message { display: grid; max-width: min(86%, 760px); gap: 7px; }
		.chat-message.user-message { align-self: end; padding: 10px 12px; background: var(--vscode-editorWidget-background); }
		.chat-message.assistant-message { align-self: start; width: 100%; }
		.chat-message.notice-message { align-self: stretch; max-width: none; padding: 8px 10px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); }
		.chat-message[data-tone="error"] { color: var(--vscode-errorForeground); }
		.message-meta { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.message-meta strong { color: var(--vscode-foreground); font-size: 11px; }
		.message-meta time { margin-left: auto; }
		.message-content { color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
		.thinking-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-progressBar-background); animation: fikeya-pulse 1.2s ease-in-out infinite; }
		@keyframes fikeya-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
		.agent-form { display: grid; gap: 8px; padding: 0 14px; }
		.agent-form .composer textarea { min-height: 88px; border-color: var(--vscode-focusBorder); }
		.composer-bar { display: grid; grid-template-columns: minmax(180px, .8fr) auto auto; align-items: start; gap: 8px; }
		.inline-field select { max-width: 340px; }
		.run-controls { position: relative; }
		.run-controls summary { min-height: 30px; padding: 6px 9px; border: 1px solid var(--vscode-widget-border); cursor: pointer; list-style: none; }
		.run-controls summary::-webkit-details-marker { display: none; }
		.run-controls[open] .control-grid { display: grid; }
		.control-grid { position: absolute; z-index: 2; right: 0; display: none; width: min(480px, 78vw); grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 5px; padding: 12px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-menu-background); box-shadow: 0 8px 24px rgba(0, 0, 0, .28); }
		.control-grid .field:first-child { grid-column: 1 / -1; }
		.composer-actions { justify-content: end; }
		.field { display: grid; gap: 4px; }
		.field > span { color: var(--vscode-foreground); font-weight: 600; }
		select, textarea, input[type="number"], input[type="search"] { width: 100%; border: 1px solid var(--vscode-input-border, transparent); border-radius: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
		select, input[type="number"], input[type="search"] { min-height: 30px; padding: 4px 7px; }
		textarea { min-height: 108px; resize: vertical; padding: 7px; line-height: 1.45; }
		select:focus-visible, textarea:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.composer-foot { display: flex; align-items: start; justify-content: space-between; gap: 10px; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.consent { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.4; }
		.consent input { margin: 2px 0 0; }
		.agent-status { margin: 0 14px; padding: 8px 9px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-textBlockQuote-background); }
		.agent-status[data-tone="error"] { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
		.run-details { margin: 0 14px 14px; border: 1px solid var(--vscode-widget-border); }
		.run-details > summary { padding: 8px 10px; cursor: pointer; }
		.run-details-body { display: grid; gap: 12px; padding: 10px; border-top: 1px solid var(--vscode-widget-border); }
		.agent-output { max-height: 360px; margin: 0; overflow: auto; padding: 10px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
		.agent-receipt { display: grid; gap: 8px; }
		.memory-graph { min-width: 0; }
		.graph-controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(105px, .4fr) minmax(120px, .48fr) auto; gap: 6px; }
		.graph-controls input { min-height: 30px; padding: 4px 7px; }
		.graph-workspace { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(180px, .55fr); gap: 8px; }
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
		.graph-label { fill: var(--vscode-editor-foreground); stroke: var(--vscode-editor-background); stroke-width: 3px; paint-order: stroke; font-family: var(--vscode-editor-font-family); font-size: 9px; pointer-events: none; }
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
		.disclaimer { padding-left: 9px; border-left: 2px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
		@media (min-width: 620px) { .run-strip { grid-template-columns: minmax(190px, 2fr) repeat(4, minmax(82px, 1fr)); } .run-metric.provider { grid-column: auto; } }
			@media (min-width: 520px) { .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .statistics-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
		@media (max-width: 780px) { .workspace-navigation { align-items: stretch; flex-direction: column; } .mode-switcher { min-width: 0; width: 100%; } .native-actions { justify-content: end; } }
		@media (max-width: 720px) { .graph-workspace { grid-template-columns: 1fr; } .composer-bar { grid-template-columns: 1fr; } .inline-field select { max-width: none; } .control-grid { position: static; width: 100%; grid-template-columns: 1fr; } .control-grid .field:first-child { grid-column: auto; } .composer-actions { justify-content: start; } .composer-foot { flex-direction: column; } }
			@media (max-width: 520px) { .graph-controls { grid-template-columns: 1fr 1fr; } .graph-controls .actions { grid-column: 1 / -1; } .statistics-status { grid-template-columns: 1fr; } }
		@media (max-width: 420px) { .graph-controls { grid-template-columns: 1fr; } .graph-controls .actions { grid-column: 1; } }
		@media (max-width: 280px) { .provider-card { grid-template-columns: 1fr; } }
		@media (prefers-reduced-motion: reduce) { .chat-thread { scroll-behavior: auto; } .thinking-dot { animation: none; opacity: 1; } }
	</style>
</head>
		<body data-surface="${surface}">
	<main class="shell">
		<header class="masthead">
			<div class="product-heading"><img class="product-mark" src="${logoUri}" alt=""><div><p class="eyebrow">${escapeHtml(strings.providerNeutralEditor)}</p><h1>${escapeHtml(strings.fikeya)}</h1></div><span class="workspace-label" title="${escapeHtml(strings.workspace)}">${escapeHtml(this.state.workspaceName)}</span></div>
			<p class="subtitle">${escapeHtml(strings.subtitle)}</p>
		</header>
		${surface === 'sidebar' ? sidebarContent : editorContent}
	</main>
	<script id="fikeya-memory-graph-data" type="application/json" nonce="${nonce}">${memoryGraphData}</script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'openCommand', command: button.dataset.command })));
		document.querySelector('[data-action="refresh-providers"]')?.addEventListener('click', () => vscode.postMessage({ type: 'refreshProviders' }));
		document.querySelectorAll('[data-provider-test]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'testProvider', providerName: button.dataset.providerTest })));
		document.querySelectorAll('[data-provider-remove]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'removeProvider', providerName: button.dataset.providerRemove })));
		document.querySelector('[data-agent-cancel]')?.addEventListener('click', () => vscode.postMessage({ type: 'cancelAgent' }));
		document.querySelector('[data-conversation-clear]')?.addEventListener('click', () => vscode.postMessage({ type: 'clearConversation' }));
			document.querySelector('[data-receipts-refresh]')?.addEventListener('click', () => vscode.postMessage({ type: 'refreshReceipts' }));
			document.querySelector('[data-statistics-refresh]')?.addEventListener('click', () => vscode.postMessage({ type: 'refreshStatistics' }));
		const agentForm = document.querySelector('[data-agent-form]');
		const networkConsent = document.querySelector('[data-network-consent]');
		const runButton = document.querySelector('[data-agent-run]');
		const promptField = agentForm?.querySelector('[name="prompt"]');
		document.querySelectorAll('[data-prompt-value]').forEach(button => button.addEventListener('click', () => {
			if (!promptField) return;
			promptField.value = button.dataset.promptValue ?? '';
			promptField.focus();
		}));
		if (agentForm && networkConsent && runButton) {
			const updateRunButton = () => { runButton.disabled = !networkConsent.checked; };
			networkConsent.addEventListener('change', updateRunButton);
			updateRunButton();
			agentForm.addEventListener('submit', event => {
				event.preventDefault();
				const providerName = agentForm.querySelector('[name="providerName"]')?.value;
				const prompt = agentForm.querySelector('[name="prompt"]')?.value;
				const maxOutputTokens = Number(agentForm.querySelector('[name="maxOutputTokens"]')?.value);
				const contextMaxCharacters = Number(agentForm.querySelector('[name="contextMaxCharacters"]')?.value);
				const memoryMode = agentForm.querySelector('[name="memoryMode"]')?.value;
				if (!networkConsent.checked || !providerName || !prompt?.trim() || !Number.isSafeInteger(maxOutputTokens) || !Number.isSafeInteger(contextMaxCharacters) || !['auto', 'off', 'required'].includes(memoryMode)) return;
				runButton.disabled = true;
				vscode.postMessage({ type: 'runAgent', providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, allowNetwork: true });
			});
			promptField?.addEventListener('keydown', event => {
				if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
				event.preventDefault();
				agentForm.requestSubmit();
			});
		}
		const chatThread = document.querySelector('[data-chat-thread]');
		if (chatThread) chatThread.scrollTop = chatThread.scrollHeight;
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
			const relationFilter = document.querySelector('[data-graph-relation]');
			const summary = document.querySelector('[data-graph-summary]');
			const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
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
				const wantedRelation = relationFilter?.value || 'all';
				const filteredEdges = graph.edges.filter(edge => wantedRelation === 'all' || edge.type === wantedRelation);
				const neighbors = new Map(graph.nodes.map(node => [node.id, new Set()]));
				const relatedIds = new Set();
				for (const edge of filteredEdges) { neighbors.get(edge.source)?.add(edge.target); neighbors.get(edge.target)?.add(edge.source); relatedIds.add(edge.source); relatedIds.add(edge.target); }
				const direct = new Set(graph.nodes.filter(node => {
					const text = [node.label, node.path, node.kind, ...node.terms].filter(Boolean).join(' ').toLowerCase();
					return (wantedType === 'all' || node.type === wantedType) && (wantedRelation === 'all' || relatedIds.has(node.id)) && (!query || text.includes(query));
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
				for (const edge of filteredEdges) {
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
				for (const [nodeIndex, node] of visible.entries()) {
					const position = positions.get(node.id);
					const group = svgElement('g'); group.classList.add('graph-node'); group.dataset.nodeId = node.id; group.dataset.selected = String(node.id === selectedId); group.dataset.dragging = 'false';
					group.setAttribute('transform', 'translate(' + position.x + ' ' + position.y + ')'); group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button'); group.setAttribute('aria-label', node.type + ': ' + node.label);
					const halo = svgElement('circle'); halo.classList.add('graph-halo'); halo.setAttribute('r', '11');
					const dot = svgElement('circle'); dot.classList.add('graph-dot'); dot.setAttribute('r', String(5 + Math.min(7, node.importance * 6))); dot.setAttribute('fill', colors[node.type]);
					const title = svgElement('title'); title.textContent = node.label + ' | ' + node.type;
					group.append(halo, dot, title);
					if (query || nodeIndex < 12) { const label = svgElement('text'); label.classList.add('graph-label'); label.setAttribute('x', '14'); label.setAttribute('y', '3'); label.textContent = node.label.length > 28 ? node.label.slice(0, 27) + '…' : node.label; group.append(label); }
					group.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.stopPropagation(); pointerState = { type: 'node', id: node.id, pointerId: event.pointerId }; group.dataset.dragging = 'true'; graphSvg.setPointerCapture(event.pointerId); showNode(node); });
					group.addEventListener('click', () => showNode(node));
					group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showNode(node); } });
					nodeLayer.append(group);
				}
				summary.textContent = visible.length + ' of ' + graph.nodes.length + ' bounded nodes | ' + filteredEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)).length + ' visible links';
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
			search?.addEventListener('input', renderGraph); typeFilter?.addEventListener('change', renderGraph); relationFilter?.addEventListener('change', renderGraph); applyScene(); renderGraph();
		}
	</script>
</body>
</html>`;
	}
}

function renderMemoryGraph(state: DashboardState, strings: WebviewStrings): string {
	if (state.memory.status === 'loading' || state.memory.status === 'not-loaded') {
		return `<section class="card memory-graph"><h2>${escapeHtml(strings.memoryGraph)}</h2><p class="empty">${escapeHtml(strings.loadingMemory)}</p></section>`;
	}
	const snapshot = state.memory.snapshot;
	if (state.memory.status === 'unavailable' || !snapshot) {
		return `<section class="card memory-graph"><h2>${escapeHtml(strings.memoryGraph)}</h2><p class="empty">${escapeHtml(strings.memoryUnavailable)}</p><div class="actions"><button class="secondary" data-memory-refresh type="button">${escapeHtml(strings.refresh)}</button></div></section>`;
	}
	if (snapshot.nodes.length === 0) {
		return `<section class="card memory-graph"><h2>${escapeHtml(strings.memoryGraph)}</h2><p>${escapeHtml(strings.memoryGraphDescription)}</p><p class="empty">${escapeHtml(strings.memoryEmpty)}</p><p class="graph-summary">${escapeHtml(strings.graphManifest)} <code>${escapeHtml(snapshot.graphManifestHash)}</code></p></section>`;
	}
	const relationshipOptions = Array.from(new Set(snapshot.edges.map(edge => edge.type)))
		.sort((left, right) => left.localeCompare(right))
		.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)
		.join('');
	return `<section class="card memory-graph" aria-labelledby="memory-graph-title">
		<h2 id="memory-graph-title">${escapeHtml(strings.memoryGraph)}</h2>
		<p>${escapeHtml(strings.memoryGraphDescription)}</p>
		<div class="graph-controls">
			<label class="field"><span>${escapeHtml(strings.searchNodes)}</span><input data-graph-search type="search" maxlength="160" placeholder="${escapeHtml(strings.searchNodesPlaceholder)}"></label>
			<label class="field"><span>${escapeHtml(strings.nodeType)}</span><select data-graph-type><option value="all">${escapeHtml(strings.allTypes)}</option><option value="worktree">${escapeHtml(strings.worktrees)}</option><option value="memory">${escapeHtml(strings.memories)}</option><option value="file">${escapeHtml(strings.files)}</option><option value="concept">${escapeHtml(strings.concepts)}</option><option value="directory">${escapeHtml(strings.directories)}</option><option value="reference">${escapeHtml(strings.references)}</option></select></label>
			<label class="field"><span>${escapeHtml(strings.relationType)}</span><select data-graph-relation><option value="all">${escapeHtml(strings.allRelationships)}</option>${relationshipOptions}</select></label>
			<div class="actions"><button class="secondary" data-graph-zoom-in type="button" aria-label="${escapeHtml(strings.zoomIn)}">+</button><button class="secondary" data-graph-zoom-out type="button" aria-label="${escapeHtml(strings.zoomOut)}">-</button><button class="secondary" data-graph-reset type="button">${escapeHtml(strings.reset)}</button></div>
		</div>
		<div class="graph-workspace"><div class="graph-viewport"><svg class="graph-canvas" data-memory-graph viewBox="0 0 800 480" role="img" aria-label="${escapeHtml(strings.memoryGraphAria)}"><rect class="graph-hit" data-graph-hit x="0" y="0" width="800" height="480"></rect><g data-graph-scene><g data-graph-edges></g><g data-graph-nodes></g></g></svg></div>
		<aside class="graph-details" aria-live="polite"><h3 data-graph-title>${escapeHtml(strings.chooseNode)}</h3><p data-graph-description>${escapeHtml(strings.chooseNodeDescription)}</p><dl class="receipt"><dt>${escapeHtml(strings.nodeType)}</dt><dd data-graph-detail="type">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.status)}</dt><dd data-graph-detail="status">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.connections)}</dt><dd data-graph-detail="connections">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.sourceEvent)}</dt><dd><code data-graph-detail="source">${escapeHtml(strings.unavailable)}</code></dd><dt>${escapeHtml(strings.evidence)}</dt><dd><code data-graph-detail="evidence">${escapeHtml(strings.unavailable)}</code></dd></dl></aside></div>
		<output class="graph-summary" data-graph-summary aria-live="polite"></output>
		<div class="graph-legend"><span><i data-type="worktree"></i>${escapeHtml(strings.worktrees)}</span><span><i data-type="memory"></i>${escapeHtml(strings.memories)}</span><span><i data-type="file"></i>${escapeHtml(strings.files)}</span><span><i data-type="concept"></i>${escapeHtml(strings.concepts)}</span><span><i data-type="directory"></i>${escapeHtml(strings.directories)}</span><span><i data-type="reference"></i>${escapeHtml(strings.references)}</span></div>
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

function renderStatistics(state: StatisticsSurfaceState, strings: WebviewStrings): string {
	const snapshot = state.snapshot;
	const statusLabel = state.status === 'loading'
		? strings.statisticsLoading
		: state.status === 'ready'
			? (snapshot?.measurement === 'provider-reported-only' ? strings.statisticsMeasured : strings.statisticsMeasurementUnavailable)
			: state.status === 'unavailable' && snapshot
				? strings.statisticsRefreshFailed
				: state.status === 'unavailable'
					? strings.statisticsUnavailable
					: strings.notChecked;
	const runtimeApiStatus = state.status === 'unavailable' && !snapshot
		? strings.runtimeStatisticsUnavailable
		: state.status === 'not-loaded'
			? strings.notChecked
			: state.status === 'loading' && !snapshot
				? strings.checking
				: strings.runtimeStatisticsAvailable;
	const breakdown = snapshot?.breakdown.length
		? `<div class="table-scroll"><table>
			<caption class="sr-only">${escapeHtml(strings.providerModelBreakdown)}</caption>
			<thead><tr><th scope="col">${escapeHtml(strings.provider)}</th><th scope="col">${escapeHtml(strings.model)}</th><th scope="col">${escapeHtml(strings.calls)}</th><th scope="col">${escapeHtml(strings.measuredCalls)}</th><th scope="col">${escapeHtml(strings.inputTokens)}</th><th scope="col">${escapeHtml(strings.cachedInputTokens)}</th><th scope="col">${escapeHtml(strings.outputTokens)}</th><th scope="col">${escapeHtml(strings.lastActivity)}</th></tr></thead>
			<tbody>${snapshot.breakdown.map(item => `<tr><td>${escapeHtml(item.provider)}</td><td>${escapeHtml(item.model)}</td><td>${item.calls.toLocaleString()}</td><td>${item.measuredCalls.toLocaleString()}</td><td>${escapeHtml(formatUsageValue(item.inputTokens))}</td><td>${escapeHtml(formatUsageValue(item.cachedInputTokens))}</td><td>${escapeHtml(formatUsageValue(item.outputTokens))}</td><td>${escapeHtml(item.lastActivity ?? strings.noRecordedActivity)}</td></tr>`).join('')}</tbody>
		</table></div>`
		: `<p class="empty">${escapeHtml(strings.noStatisticsBreakdown)}</p>`;

	return `<section class="card" aria-labelledby="statistics-title">
		<div class="statistics-status">
			<div><h2 id="statistics-title">${escapeHtml(strings.localStatistics)}</h2><p>${escapeHtml(strings.statisticsDescription)}</p></div>
			<div class="actions"><button class="secondary" data-statistics-refresh type="button"${state.status === 'loading' ? ' disabled' : ''}>${escapeHtml(strings.refresh)}</button></div>
		</div>
		<span class="badge">${escapeHtml(statusLabel)}</span>
		<div class="statistics-grid">
			<div class="statistics-metric"><span>${escapeHtml(strings.sessions)}</span><strong>${snapshot ? snapshot.sessions.toLocaleString() : escapeHtml(strings.noRecordedActivity)}</strong></div>
			<div class="statistics-metric"><span>${escapeHtml(strings.providerCalls)}</span><strong>${snapshot ? snapshot.providerCalls.toLocaleString() : escapeHtml(strings.noRecordedActivity)}</strong></div>
			<div class="statistics-metric"><span>${escapeHtml(strings.measuredCalls)}</span><strong>${snapshot ? snapshot.measuredProviderCalls.toLocaleString() : escapeHtml(strings.noRecordedActivity)}</strong></div>
			<div class="statistics-metric"><span>${escapeHtml(strings.qarinahContextReceipts)}</span><strong>${snapshot ? snapshot.qarinahContextReceipts.toLocaleString() : escapeHtml(strings.noRecordedActivity)}</strong></div>
			<div class="statistics-metric"><span>${escapeHtml(strings.inputTokens)}</span><strong>${escapeHtml(formatUsageValue(snapshot?.inputTokens))}</strong></div>
			<div class="statistics-metric"><span>${escapeHtml(strings.cachedInputTokens)}</span><strong>${escapeHtml(formatUsageValue(snapshot?.cachedInputTokens))}</strong></div>
			<div class="statistics-metric"><span>${escapeHtml(strings.outputTokens)}</span><strong>${escapeHtml(formatUsageValue(snapshot?.outputTokens))}</strong></div>
		</div>
		<dl class="receipt">
			<dt>${escapeHtml(strings.measurement)}</dt><dd>${escapeHtml(snapshot?.measurement ?? strings.unavailable)}</dd>
			<dt>${escapeHtml(strings.dataUpdated)}</dt><dd>${escapeHtml(snapshot?.generatedAt ?? strings.notChecked)}</dd>
			<dt>${escapeHtml(strings.lastActivity)}</dt><dd>${escapeHtml(snapshot?.lastActivity ?? strings.noRecordedActivity)}</dd>
			<dt>${escapeHtml(strings.runtimeStatisticsApi)}</dt><dd>${escapeHtml(runtimeApiStatus)}</dd>
			<dt>${escapeHtml(strings.extensionUpdateStatus)}</dt><dd>${escapeHtml(strings.extensionUpdateManual)}</dd>
		</dl>
		<h2>${escapeHtml(strings.providerModelBreakdown)}</h2>
		${breakdown}
	</section>`;
}

function renderAgentSurface(state: DashboardState, strings: WebviewStrings, researchMode: boolean): string {
	const running = state.agent.status === 'running';
	const providerOptions = state.providers.length === 0
		? `<option value="">${escapeHtml(strings.noProviders)}</option>`
		: state.providers.map(provider => `<option value="${escapeHtml(provider.name)}"${state.agent.providerName === provider.name ? ' selected' : ''}>${escapeHtml(`${provider.name} | ${provider.model}`)}</option>`).join('');
	const statusTone = state.agent.status === 'failed' || state.agent.status === 'cancelled' ? 'error' : 'normal';
	const conversation = state.conversation.length === 0
		? `<div class="chat-empty"><strong>${escapeHtml(researchMode ? vscode.l10n.t('Research the codebase') : vscode.l10n.t('Ask Fikeya about this project'))}</strong><p>${escapeHtml(researchMode ? vscode.l10n.t('Request a cited technical investigation using the configured model and approved tools.') : vscode.l10n.t('Chat, edit, run, or review. Fikeya retrieves bounded Qarinah evidence for each turn and asks before a tool runs.'))}</p><div class="prompt-suggestions"><button class="quiet" data-prompt-value="Explain this project and cite the files that matter." type="button">${escapeHtml(vscode.l10n.t('Explain this project'))}</button><button class="quiet" data-prompt-value="Inspect the current changes and identify the highest-risk issue." type="button">${escapeHtml(vscode.l10n.t('Review current changes'))}</button><button class="quiet" data-prompt-value="Run the relevant tests, diagnose any failure, and propose the smallest fix." type="button">${escapeHtml(vscode.l10n.t('Diagnose failing tests'))}</button></div></div>`
		: state.conversation.map(renderConversationMessage).join('');
	const progress = running
		? `<article class="chat-message assistant-message" aria-label="${escapeHtml(vscode.l10n.t('Fikeya is working'))}"><div class="message-meta"><strong>${escapeHtml(vscode.l10n.t('Fikeya'))}</strong><span class="thinking-dot" aria-hidden="true"></span><span>${escapeHtml(vscode.l10n.t('Planning and checking the workspace'))}</span></div></article>`
		: '';
	const outcome = state.agent.outcome ? renderCodingOutcome(state.agent.outcome, strings) : '';
	const runDetails = state.agent.sessionId
		? `<details class="run-details"><summary>${escapeHtml(vscode.l10n.t('Inspect latest run'))}</summary><div class="run-details-body">${outcome}<dl class="receipt"><dt>${escapeHtml(strings.session)}</dt><dd><code>${escapeHtml(state.agent.sessionId)}</code></dd><dt>${escapeHtml(strings.call)}</dt><dd><code>${escapeHtml(state.agent.callId ?? strings.unavailable)}</code></dd><dt>${escapeHtml(strings.usageBasis)}</dt><dd>${escapeHtml(state.agent.usage?.measurement ?? strings.unavailable)}</dd><dt>${escapeHtml(strings.context)}</dt><dd>${escapeHtml(formatContextStatus(state.agent.memory, strings))}</dd>${state.agent.memory?.receiptId ? `<dt>${escapeHtml(strings.contextReceipt)}</dt><dd><code>${escapeHtml(state.agent.memory.receiptId)}</code></dd>` : ''}${state.agent.memory?.responseSha256 ? `<dt>${escapeHtml(strings.contextEvidence)}</dt><dd><code>${escapeHtml(state.agent.memory.responseSha256)}</code></dd>` : ''}</dl></div></details>`
		: '';
	return `<section class="card agent-surface" aria-labelledby="agent-run-title">
		<div class="agent-heading"><div><h2 id="agent-run-title">${escapeHtml(researchMode ? vscode.l10n.t('Research') : vscode.l10n.t('Chat'))}</h2><p>${escapeHtml(researchMode ? vscode.l10n.t('Cited investigation with the same project and permission boundary.') : vscode.l10n.t('A live conversation beside the editor. Messages stay in this extension-host session.'))}</p></div><div class="agent-heading-actions"><button class="quiet" data-conversation-clear type="button"${running || state.conversation.length === 0 ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('New chat'))}</button><span class="badge">${escapeHtml(agentStatusLabel(state.agent, strings))}</span></div></div>
		<div class="chat-thread" data-chat-thread aria-live="polite">${conversation}${progress}</div>
		<form class="agent-form" data-agent-form autocomplete="off">
			<label class="field composer"><span class="sr-only">${escapeHtml(strings.prompt)}</span><textarea name="prompt" maxlength="65536" placeholder="${escapeHtml(researchMode ? vscode.l10n.t('Research a technical question and ask for cited findings...') : vscode.l10n.t('Ask Fikeya to inspect, edit, run, or review this project...'))}"${running || state.providers.length === 0 ? ' disabled' : ''} required></textarea></label>
			<div class="composer-bar"><label class="field inline-field"><span class="sr-only">${escapeHtml(strings.provider)}</span><select name="providerName" aria-label="${escapeHtml(strings.provider)}"${running || state.providers.length === 0 ? ' disabled' : ''}>${providerOptions}</select></label><details class="run-controls"><summary>${escapeHtml(vscode.l10n.t('Model and context'))}</summary><div class="control-grid"><label class="field"><span>${escapeHtml(strings.contextMode)}</span><select name="memoryMode"${running || state.providers.length === 0 ? ' disabled' : ''}><option value="auto">${escapeHtml(strings.contextAuto)}</option><option value="required">${escapeHtml(strings.contextRequired)}</option><option value="off">${escapeHtml(strings.contextOff)}</option></select></label><label class="field"><span>${escapeHtml(strings.contextBudget)}</span><input name="contextMaxCharacters" type="number" min="512" max="64000" step="256" value="12000"${running || state.providers.length === 0 ? ' disabled' : ''}></label><label class="field"><span>${escapeHtml(strings.maximumOutputTokens)}</span><input name="maxOutputTokens" type="number" min="1" max="32768" step="1" value="1024"${running || state.providers.length === 0 ? ' disabled' : ''}></label></div></details><div class="actions composer-actions"><button data-agent-run type="submit"${running || state.providers.length === 0 ? ' disabled' : ''}>${escapeHtml(researchMode ? vscode.l10n.t('Research') : vscode.l10n.t('Send'))}</button>${running ? `<button class="secondary" data-agent-cancel type="button">${escapeHtml(strings.cancel)}</button>` : ''}</div></div>
			<div class="composer-foot"><label class="consent"><input data-network-consent type="checkbox"${running || state.providers.length === 0 ? ' disabled' : ''}><span>${escapeHtml(vscode.l10n.t('Allow provider network for this turn'))}</span></label><span>${escapeHtml(vscode.l10n.t('Enter to send, Shift+Enter for a new line'))}</span></div>
		</form>
		<div class="agent-status" data-tone="${statusTone}" role="status">${escapeHtml(state.providers.length === 0 ? vscode.l10n.t('Add a model in Fikeya Settings to begin.') : agentStatusLabel(state.agent, strings))}</div>
		${runDetails}
		${state.agent.sessionId ? `<div class="actions"><button class="secondary" data-receipts-refresh type="button"${state.agent.receiptsStatus === 'loading' ? ' disabled' : ''}>${escapeHtml(strings.refreshReceipts)}</button></div>` : ''}
	</section>`;
}

function renderConversationMessage(message: FikeyaConversationMessage): string {
	const roleLabel = message.role === 'user'
		? vscode.l10n.t('You')
		: message.role === 'assistant'
			? vscode.l10n.t('Fikeya')
			: vscode.l10n.t('Run status');
	const provider = message.providerName ? `<span>${escapeHtml(message.providerName)}</span>` : '';
	const className = message.role === 'user' ? 'user-message' : message.role === 'assistant' ? 'assistant-message' : 'notice-message';
	return `<article class="chat-message ${className}" data-tone="${message.tone ?? 'normal'}"><div class="message-meta"><strong>${escapeHtml(roleLabel)}</strong>${provider}<time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(formatConversationTime(message.createdAt))}</time></div><div class="message-content">${escapeHtml(message.content)}</div></article>`;
}

function formatConversationTime(value: string): string {
	const match = /T(\d{2}):(\d{2})/.exec(value);
	return match ? `${match[1]}:${match[2]}` : value;
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

function renderCodingOutcome(outcome: FikeyaCodingOutcome, strings: WebviewStrings): string {
	const changedFiles = outcome.changedFiles.length === 0
		? `<p class="empty">${escapeHtml(strings.noChangedFiles)}</p>`
		: `<ul>${outcome.changedFiles.slice(0, 100).map(file => `<li><code>${escapeHtml(file.path)}</code></li>`).join('')}</ul>`;
	const tools = outcome.toolCalls.length === 0
		? `<p class="empty">${escapeHtml(strings.noToolCalls)}</p>`
		: `<ul>${outcome.toolCalls.slice(0, 100).map(tool => `<li><code>${escapeHtml(tool.name)}</code> - ${escapeHtml(tool.status)}${tool.test ? ` - ${escapeHtml(strings.test)}` : ''}${tool.exitCode === null ? '' : ` - ${escapeHtml(vscode.l10n.t('exit {0}', tool.exitCode))}`}</li>`).join('')}</ul>`;
	return `<div class="agent-receipt">
		<h2>${escapeHtml(strings.executionOutcome)}</h2>
		<h3>${escapeHtml(strings.codingPlan)}</h3>
		<pre class="agent-output" tabindex="0">${escapeHtml(outcome.plan)}</pre>
		<p>${escapeHtml(vscode.l10n.t('{0} reviewed steps', outcome.steps))}</p>
		<h3>${escapeHtml(strings.changedFiles)}</h3>${changedFiles}
		<h3>${escapeHtml(strings.toolActivity)}</h3>${tools}
	</div>`;
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

function formatUsageValue(value: number | null | undefined, emptyLabel = vscode.l10n.t('Unavailable')): string {
	return typeof value === 'number' ? value.toLocaleString() : emptyLabel;
}

function formatContextStatus(memory: FikeyaAgentMemory | undefined, strings: WebviewStrings): string {
	if (!memory) {
		return strings.waitingForFirstRun;
	}
	if (memory.status === 'off') {
		return strings.contextDisabled;
	}
	if (memory.status === 'unavailable') {
		return strings.contextUnavailable;
	}
	return vscode.l10n.t('{0} cited items / {1} coverage', memory.evidenceCount ?? 0, memory.coverage ?? strings.unavailable);
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
	readonly providerNeutralEditor: string;
	readonly workspaceModes: string;
	readonly editorMode: string;
	readonly agentMode: string;
	readonly terminalMode: string;
	readonly reviewMode: string;
	readonly labMode: string;
	readonly subtitle: string;
	readonly runContext: string;
	readonly providerAndModel: string;
	readonly noProviderSelected: string;
	readonly noUsageRecorded: string;
	readonly usageSource: string;
	readonly workspace: string;
	readonly runtime: string;
	readonly unavailable: string;
	readonly waitingForFirstRun: string;
	readonly metricsDisclaimer: string;
	readonly localStatistics: string;
	readonly statisticsDescription: string;
	readonly statisticsLoading: string;
	readonly statisticsMeasured: string;
	readonly statisticsMeasurementUnavailable: string;
	readonly statisticsRefreshFailed: string;
	readonly statisticsUnavailable: string;
	readonly sessions: string;
	readonly providerCalls: string;
	readonly calls: string;
	readonly measuredCalls: string;
	readonly qarinahContextReceipts: string;
	readonly measurement: string;
	readonly dataUpdated: string;
	readonly lastActivity: string;
	readonly noRecordedActivity: string;
	readonly runtimeStatisticsApi: string;
	readonly runtimeStatisticsAvailable: string;
	readonly runtimeStatisticsUnavailable: string;
	readonly extensionUpdateStatus: string;
	readonly extensionUpdateManual: string;
	readonly providerModelBreakdown: string;
	readonly noStatisticsBreakdown: string;
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
	readonly relationType: string;
	readonly allRelationships: string;
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
	readonly context: string;
	readonly contextMode: string;
	readonly contextBudget: string;
	readonly contextAuto: string;
	readonly contextRequired: string;
	readonly contextOff: string;
	readonly contextReceipt: string;
	readonly contextEvidence: string;
	readonly noContextReceipt: string;
	readonly contextDisabled: string;
	readonly contextUnavailable: string;
	readonly maximumOutputTokens: string;
	readonly networkConsent: string;
	readonly runAgent: string;
	readonly cancel: string;
	readonly agentIdle: string;
	readonly waitingForProvider: string;
	readonly runCompleted: string;
	readonly runFailed: string;
	readonly providerOutput: string;
	readonly executionOutcome: string;
	readonly codingPlan: string;
	readonly changedFiles: string;
	readonly noChangedFiles: string;
	readonly toolActivity: string;
	readonly noToolCalls: string;
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
	readonly inputTokens: string;
	readonly outputTokens: string;
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
		providerNeutralEditor: vscode.l10n.t('AI Coding-Agent Workspace'),
		workspaceModes: vscode.l10n.t('Fikeya workspace modes'),
		editorMode: vscode.l10n.t('Editor'),
		agentMode: vscode.l10n.t('Agent'),
		terminalMode: vscode.l10n.t('Terminal'),
		reviewMode: vscode.l10n.t('Review'),
		labMode: vscode.l10n.t('Lab'),
		subtitle: vscode.l10n.t('Configure the model you choose, run reviewed coding work, inspect the Qarinah graph, and verify exact provider usage from one workspace.'),
		runContext: vscode.l10n.t('Active Run Context'),
		providerAndModel: vscode.l10n.t('Provider / Model'),
		noProviderSelected: vscode.l10n.t('Configure a provider to begin'),
		noUsageRecorded: vscode.l10n.t('No usage recorded'),
		usageSource: vscode.l10n.t('Usage source:'),
		workspace: vscode.l10n.t('Workspace'),
		runtime: vscode.l10n.t('Runtime'),
		unavailable: vscode.l10n.t('Unavailable'),
		waitingForFirstRun: vscode.l10n.t('Waiting for first run'),
		metricsDisclaimer: vscode.l10n.t('Token counts are shown only when the provider reports them. Fikeya does not estimate provider billing here.'),
		localStatistics: vscode.l10n.t('Local Usage & Statistics'),
		statisticsDescription: vscode.l10n.t('Content-free aggregates read from this workspace\'s local Fikeya SQLite database. This view does not send an analytics event to Fikeya or another service.'),
		statisticsLoading: vscode.l10n.t('Refreshing local statistics'),
		statisticsMeasured: vscode.l10n.t('Provider-reported token measurements'),
		statisticsMeasurementUnavailable: vscode.l10n.t('Token measurement unavailable'),
		statisticsRefreshFailed: vscode.l10n.t('Refresh failed; showing the last local snapshot'),
		statisticsUnavailable: vscode.l10n.t('Local statistics are unavailable in the installed runtime'),
		sessions: vscode.l10n.t('Sessions'),
		providerCalls: vscode.l10n.t('Provider Calls'),
		calls: vscode.l10n.t('Calls'),
		measuredCalls: vscode.l10n.t('Measured Calls'),
		qarinahContextReceipts: vscode.l10n.t('Qarinah Context Receipts'),
		measurement: vscode.l10n.t('Measurement'),
		dataUpdated: vscode.l10n.t('Data Updated'),
		lastActivity: vscode.l10n.t('Last Local Activity'),
		noRecordedActivity: vscode.l10n.t('No recorded activity'),
		runtimeStatisticsApi: vscode.l10n.t('Runtime Statistics API'),
		runtimeStatisticsAvailable: vscode.l10n.t('Available in the installed local runtime'),
		runtimeStatisticsUnavailable: vscode.l10n.t('Unavailable in the installed local runtime'),
		extensionUpdateStatus: vscode.l10n.t('Extension Update Status'),
		extensionUpdateManual: vscode.l10n.t('Managed by the current VSIX host. This view does not claim Marketplace or native auto-update.'),
		providerModelBreakdown: vscode.l10n.t('Provider and Model Breakdown'),
		noStatisticsBreakdown: vscode.l10n.t('No provider or model usage has been recorded in this local workspace.'),
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
		relationType: vscode.l10n.t('Relationship'),
		allRelationships: vscode.l10n.t('All Relationships'),
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
		agentRunDescription: vscode.l10n.t('Run a reviewed coding loop that can inspect files, apply exact approved edits, invoke allowlisted tools, and verify tests. Prompt and tool content stay ephemeral in this view.'),
		provider: vscode.l10n.t('Provider'),
		prompt: vscode.l10n.t('Prompt'),
		promptPlaceholder: vscode.l10n.t('Describe the coding task or question.'),
		context: vscode.l10n.t('Project Context'),
		contextMode: vscode.l10n.t('Qarinah Context Mode'),
		contextBudget: vscode.l10n.t('Maximum Context Characters'),
		contextAuto: vscode.l10n.t('Auto - continue safely if unavailable'),
		contextRequired: vscode.l10n.t('Required - stop if cited context is unavailable'),
		contextOff: vscode.l10n.t('Off - send no Qarinah project context'),
		contextReceipt: vscode.l10n.t('Context Receipt'),
		contextEvidence: vscode.l10n.t('Context Evidence'),
		noContextReceipt: vscode.l10n.t('No context receipt yet'),
		contextDisabled: vscode.l10n.t('Disabled for this run'),
		contextUnavailable: vscode.l10n.t('Unavailable; no context attached'),
		maximumOutputTokens: vscode.l10n.t('Maximum Output Tokens'),
		networkConsent: vscode.l10n.t('Allow this reviewed run to make provider requests. Every workspace or process tool still requires an exact one-use decision.'),
		runAgent: vscode.l10n.t('Run Agent'),
		cancel: vscode.l10n.t('Cancel'),
		agentIdle: vscode.l10n.t('Choose a provider and enter a prompt. No network request occurs until you confirm it for this run.'),
		waitingForProvider: vscode.l10n.t('Planning, inspecting, and verifying. Fikeya pauses before every workspace or process tool.'),
		runCompleted: vscode.l10n.t('Reviewed coding loop completed. The result, changed files, tests, usage, and evidence are shown below.'),
		runFailed: vscode.l10n.t('The provider run failed safely. Provider response bodies were not retained.'),
		providerOutput: vscode.l10n.t('Reviewed Result'),
		executionOutcome: vscode.l10n.t('Structured Execution Outcome'),
		codingPlan: vscode.l10n.t('Plan'),
		changedFiles: vscode.l10n.t('Changed Files'),
		noChangedFiles: vscode.l10n.t('No files were changed.'),
		toolActivity: vscode.l10n.t('Approved Tool Activity'),
		noToolCalls: vscode.l10n.t('No tools were executed.'),
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
		inputTokens: vscode.l10n.t('Input Tokens'),
		outputTokens: vscode.l10n.t('Output Tokens'),
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
			id: 'google-gemini',
			label: vscode.l10n.t('Google Gemini'),
			detail: vscode.l10n.t('Use the Gemini API through its OpenAI-compatible endpoint.'),
			runtimeKind: 'google-gemini',
			credentialType: 'api-key',
			defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
			secretPrompt: vscode.l10n.t('Enter the Google Gemini API Key')
		},
		{
			id: 'hugging-face',
			label: vscode.l10n.t('Hugging Face Inference Providers'),
			detail: vscode.l10n.t('Use routed open models, including fastest or cheapest provider policies.'),
			runtimeKind: 'hugging-face',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://router.huggingface.co/v1',
			secretPrompt: vscode.l10n.t('Enter the Hugging Face Token')
		},
		{
			id: 'groq',
			label: vscode.l10n.t('Groq'),
			detail: vscode.l10n.t('Use Groq models through the OpenAI-compatible chat endpoint.'),
			runtimeKind: 'groq',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.groq.com/openai/v1',
			secretPrompt: vscode.l10n.t('Enter the Groq API Key')
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
			label: vscode.l10n.t('Vertex AI or OpenAI-Compatible'),
			detail: vscode.l10n.t('Connect with a compatible endpoint and short-lived bearer token.'),
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

function createConversationMessage(
	role: FikeyaConversationMessage['role'],
	content: string,
	providerName?: string,
	tone: FikeyaConversationMessage['tone'] = 'normal'
): FikeyaConversationMessage {
	return {
		id: `chat-${Date.now()}-${randomBytes(5).toString('hex')}`,
		role,
		content,
		createdAt: new Date().toISOString(),
		providerName,
		tone
	};
}

function getLocalWorkspacePath(): string | undefined {
	if (!vscode.workspace.isTrusted) {
		return undefined;
	}
	const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.scheme === 'file');
	return folder?.uri.fsPath;
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
		case 'quota':
			return vscode.l10n.t('The provider reported that its quota or rate limit is exhausted.');
		case 'authentication':
			return vscode.l10n.t('The provider rejected its credential. Update this provider in Fikeya settings.');
		case 'provider-error':
			return vscode.l10n.t('The provider rejected the request without returning a retained response body.');
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
