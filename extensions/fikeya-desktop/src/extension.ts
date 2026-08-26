/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { agentComposerConstraints, agentComposerDefaults, invokeAgentRunRequest } from './agentComposer';
import { appendConversationMessage, FikeyaConversationMessage, parseConversationState, projectProviderHistory, serializeConversationState } from './conversation';
import { escapeHtml, parseWebviewMessage } from './messageValidation';
import { FikeyaMemorySnapshot, initializeQarinahMemory, loadQarinahMemory } from './memory';
import { captureCompletedFikeyaRun } from './sessionCapture';
import { buildChatPlanSummary, buildRecordedPlanTimeline, fikeyaNarrowPanelMaximumWidth, FikeyaPlanStageId, isChatInteractionBlocked, selectInitialPlanStepId } from './surface';
import {
	configureFikeyaProvider,
	approveFikeyaPlan,
	changeFikeyaPlan,
	createFikeyaPlan,
	FikeyaAgentApproval,
	FikeyaAgentApprovalDecision,
	FikeyaAgentMemory,
	FikeyaAgentRunHandle,
	FikeyaAgentUsage,
	FikeyaCodingOutcome,
	FikeyaMemoryMode,
	FikeyaPlanRecord,
	FikeyaPlanProposalRunHandle,
	FikeyaPlanRunHandle,
	FikeyaPlanSpecification,
	FikeyaProviderConfiguration,
	FikeyaProviderProfile,
	FikeyaProviderReceipt,
	FikeyaRuntimeResult,
	FikeyaRunProgress,
	FikeyaStatistics,
	loadFikeyaAgentReceipts,
	loadFikeyaPlan,
	loadFikeyaStatistics,
	listFikeyaProviders,
	removeFikeyaProvider,
	runFikeyaRuntime,
	startFikeyaAgentRun,
	startFikeyaPlanProposal,
	startFikeyaPlan,
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
	readonly progress?: FikeyaRunProgress;
}

interface MemorySurfaceState {
	readonly status: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly snapshot?: FikeyaMemorySnapshot;
}

interface StatisticsSurfaceState {
	readonly status: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly snapshot?: FikeyaStatistics;
}

interface PlanSurfaceState {
	readonly status: 'idle' | 'loading' | 'ready' | 'running' | 'unavailable';
	readonly record?: FikeyaPlanRecord;
	readonly recordSha256?: string;
	readonly failure?: string;
	readonly progress?: FikeyaRunProgress;
}

type FikeyaWorkspaceMode = 'chat' | 'research' | 'plan' | 'context' | 'usage' | 'setup';

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
	readonly plan: PlanSurfaceState;
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
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.chat.deleteSavedHistory', async () => {
		await provider.deleteSavedConversation();
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
	const onboardingKey = 'fikeya.desktop.onboarding.v2';
	if (context.globalState.get<boolean>(onboardingKey)) {
		return;
	}
	await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Fikeya Dark', vscode.ConfigurationTarget.Global);
	await context.globalState.update(onboardingKey, true);
	// Start in the non-modal Agent workspace. Its empty state explains the available
	// surfaces and links to Setup when no provider exists, while Code remains one
	// click away. A modal Quick Pick here can race the command that activated the
	// extension and accidentally turn a workspace action into provider setup.
	provider.openWorkspacePanel('chat');
}

class FikeyaWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'fikeya.dashboard';
	private static readonly panelViewType = 'fikeya.workspace';
	private static readonly currentPlanKey = 'fikeya.plan.current.v1';
	private static readonly conversationKey = 'fikeya.chat.conversation.v1';
	private view: vscode.WebviewView | undefined;
	private viewBinding: vscode.Disposable | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private panelBinding: vscode.Disposable | undefined;
	private state: DashboardState;
	private activeAgentRun: FikeyaAgentRunHandle | undefined;
	private activePlanProposalRun: FikeyaPlanProposalRunHandle | undefined;
	private activePlanRun: FikeyaPlanRunHandle | undefined;
	private planCancellationInProgress = false;

	public constructor(private readonly context: vscode.ExtensionContext) {
		const persistConversation = this.conversationPersistenceEnabled();
		this.state = {
			isDesktop: vscode.env.appName === 'Fikeya' || vscode.env.appName === 'Fikeya Dev',
			activeMode: 'chat',
			conversation: persistConversation
				? parseConversationState(context.workspaceState.get<string>(FikeyaWebviewViewProvider.conversationKey) ?? '')
				: [],
			workspaceName: getWorkspaceName(),
			providersStatus: 'not-loaded',
			providers: [],
			providerHealth: {},
			agent: { status: 'idle', receiptsStatus: 'idle', receipts: [] },
			memory: { status: 'not-loaded' },
			statistics: { status: 'not-loaded' },
			plan: { status: 'idle' },
			runtime: 'not-checked',
			workspaceInitialized: false,
			runtimeProviderCount: undefined,
			qarinah: vscode.l10n.t('Not checked')
		};
		if (!persistConversation) {
			void context.workspaceState.update(FikeyaWebviewViewProvider.conversationKey, undefined);
		}
	}

	public async deleteSavedConversation(): Promise<void> {
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.conversationKey, undefined);
		this.state = { ...this.state, conversation: [] };
		this.refresh();
		void vscode.window.showInformationMessage(vscode.l10n.t('Saved Fikeya Chat history was deleted from this workspace.'));
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
		this.activePlanProposalRun?.cancel();
		this.activePlanProposalRun = undefined;
		this.activePlanRun?.cancel();
		this.activePlanRun = undefined;
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
		if (this.state.plan.status === 'idle' && this.currentPlanId()) {
			void this.refreshPlan(false);
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
				await invokeAgentRunRequest(message, async (providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode) => {
					await this.runAgent(providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode);
				});
				break;
			case 'proposePlan':
				await this.proposePlan(message.providerName, message.prompt, message.maxOutputTokens, message.contextMaxCharacters, message.memoryMode);
				break;
			case 'cancelAgent':
				this.cancelAgent();
				break;
			case 'createPlan':
				await this.createPlan(message.specification);
				break;
			case 'newPlan':
				await this.startNewPlan();
				break;
			case 'refreshPlan':
				await this.refreshPlan(true);
				break;
			case 'selectSurface':
				this.state = { ...this.state, activeMode: message.surface };
				break;
			case 'planAction':
				await this.runPlanAction(message.action, message.stepId);
				break;
			case 'clearConversation':
				if (!isChatInteractionBlocked({
					agentRunning: this.state.agent.status === 'running',
					planRunning: this.activePlanRun !== undefined,
					planCancellationInProgress: this.planCancellationInProgress
				})) {
					this.state = { ...this.state, conversation: [] };
					await this.persistConversation();
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
		attemptedProviderNames: ReadonlySet<string> = new Set(),
		providerHistory = projectProviderHistory(this.state.conversation)
	): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const profile = this.state.providers.find(provider => provider.name === providerName);
		const chatBlocked = isChatInteractionBlocked({
			agentRunning: this.activeAgentRun !== undefined,
			planRunning: this.activePlanRun !== undefined,
			planCancellationInProgress: this.planCancellationInProgress
		});
		if (!workspacePath || chatBlocked || this.activePlanProposalRun || !profile) {
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
		await this.persistConversation();
		this.refresh();
		const operation = startFikeyaAgentRun(
			providerName,
			prompt,
			maxOutputTokens,
			contextMaxCharacters,
			memoryMode,
			workspacePath,
			request => this.approveAgentTool(request),
			providerHistory
		);
		this.activeAgentRun = operation;
		const disposeProgress = operation.onProgress(progress => {
			if (this.activeAgentRun !== operation) {
				return;
			}
			this.state = {
				...this.state,
				agent: { ...this.state.agent, progress }
			};
			this.refresh();
		});
		const result = await operation.result.finally(disposeProgress);
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
			await this.persistConversation();
			this.refresh();
			if (result.failure === 'quota') {
				await this.offerProviderHandoff(prompt, maxOutputTokens, contextMaxCharacters, memoryMode, attempted, providerHistory);
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
		await this.persistConversation();
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

	private async proposePlan(
		providerName: string,
		prompt: string,
		maxOutputTokens: number,
		contextMaxCharacters: number,
		memoryMode: FikeyaMemoryMode
	): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const profile = this.state.providers.find(provider => provider.name === providerName);
		if (!workspacePath || this.activeAgentRun || this.activePlanProposalRun || this.activePlanRun || this.planCancellationInProgress || !profile) {
			return;
		}

		const providerHistory = projectProviderHistory(this.state.conversation);
		this.state = {
			...this.state,
			conversation: appendConversationMessage(this.state.conversation, createConversationMessage('user', prompt)),
			agent: {
				status: 'running',
				providerName,
				receiptsStatus: 'idle',
				receipts: []
			}
		};
		await this.persistConversation();
		this.refresh();
		const operation = startFikeyaPlanProposal(
			providerName,
			prompt,
			maxOutputTokens,
			contextMaxCharacters,
			memoryMode,
			workspacePath,
			providerHistory
		);
		this.activePlanProposalRun = operation;
		const result = await operation.result;
		if (this.activePlanProposalRun !== operation) {
			return;
		}
		this.activePlanProposalRun = undefined;
		if (!result.ok || !result.value) {
			const cancelled = result.failure === 'cancelled';
			const failure = cancelled
				? vscode.l10n.t('Planning stopped before a draft was confirmed. No workspace tool ran.')
				: vscode.l10n.t('No structured plan was accepted. The provider response did not satisfy the planning protocol or the runtime stopped safely. No workspace tool ran.');
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
			await this.persistConversation();
			this.refresh();
			return;
		}

		const proposed = result.value;
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.currentPlanKey, proposed.plan.planId);
		this.state = {
			...this.state,
			activeMode: 'plan',
			conversation: appendConversationMessage(
				this.state.conversation,
				createConversationMessage(
					'assistant',
					vscode.l10n.t('Created draft plan "{0}" with {1} exact step(s). No workspace tool ran. Review the plan before issuing any single-use approval.', proposed.plan.title, proposed.plan.steps.length),
					providerName
				)
			),
			agent: {
				status: 'completed',
				providerName,
				sessionId: proposed.proposal.sessionId,
				callId: proposed.proposal.callId,
				usage: proposed.proposal.usage,
				memory: proposed.proposal.memory,
				receiptsStatus: 'loading',
				receipts: []
			},
			plan: {
				status: 'ready',
				record: proposed.plan,
				recordSha256: proposed.recordSha256
			}
		};
		await this.persistConversation();
		this.refresh();
		await this.refreshReceipts(false);
		await this.refreshStatistics(false);
	}

	private async offerProviderHandoff(
		prompt: string,
		maxOutputTokens: number,
		contextMaxCharacters: number,
		memoryMode: FikeyaMemoryMode,
		attemptedProviderNames: ReadonlySet<string>,
		providerHistory: ReturnType<typeof projectProviderHistory>
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
		await this.runAgent(target.name, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, attemptedProviderNames, providerHistory);
	}

	private async persistConversation(): Promise<void> {
		try {
			if (!this.conversationPersistenceEnabled()) {
				await this.context.workspaceState.update(FikeyaWebviewViewProvider.conversationKey, undefined);
				return;
			}
			await this.context.workspaceState.update(
				FikeyaWebviewViewProvider.conversationKey,
				this.state.conversation.length === 0 ? undefined : serializeConversationState(this.state.conversation)
			);
		} catch {
			void vscode.window.showWarningMessage(vscode.l10n.t('Fikeya could not retain this conversation in the local workspace store. The current window can continue.'));
		}
	}

	private conversationPersistenceEnabled(): boolean {
		return vscode.workspace.getConfiguration('fikeya').get<boolean>('chat.persistWorkspaceHistory', false);
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
		this.activeAgentRun?.cancel();
		this.activePlanProposalRun?.cancel();
	}

	private currentPlanId(): string | undefined {
		return this.state.plan.record?.planId ?? this.context.workspaceState.get<string>(FikeyaWebviewViewProvider.currentPlanKey);
	}

	private async startNewPlan(): Promise<void> {
		if (this.activePlanRun || this.activePlanProposalRun || this.planCancellationInProgress
			|| this.state.plan.status === 'loading' || this.state.plan.status === 'running') {
			return;
		}
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.currentPlanKey, undefined);
		this.state = { ...this.state, activeMode: 'plan', plan: { status: 'idle' } };
		this.refresh();
	}

	private async createPlan(specification: FikeyaPlanSpecification): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open one trusted local folder before creating a plan.'));
			return;
		}
		if (this.activePlanRun || this.activePlanProposalRun || this.planCancellationInProgress) {
			return;
		}
		this.state = { ...this.state, plan: { status: 'loading', record: this.state.plan.record, recordSha256: this.state.plan.recordSha256 } };
		this.refresh();
		const result = await createFikeyaPlan(specification, workspacePath);
		if (!result.ok || !result.value) {
			this.state = { ...this.state, plan: { status: 'unavailable', failure: runtimeFailureMessage(result.failure) } };
			this.refresh();
			void vscode.window.showErrorMessage(vscode.l10n.t('The exact plan could not be created. Initialize the workspace, inspect the JSON, and try again.'));
			return;
		}
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.currentPlanKey, result.value.plan.planId);
		this.applyPlanView(result.value);
	}

	private async refreshPlan(showFailure: boolean): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const planId = this.currentPlanId();
		if (!workspacePath) {
			if (showFailure) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Open the local folder that owns this plan before refreshing it.'));
			}
			return;
		}
		if (!planId || this.activePlanRun || this.planCancellationInProgress) {
			return;
		}
		this.state = { ...this.state, plan: { status: 'loading', record: this.state.plan.record, recordSha256: this.state.plan.recordSha256 } };
		this.refresh();
		const result = await loadFikeyaPlan(planId, workspacePath);
		if (!result.ok || !result.value) {
			this.state = { ...this.state, plan: { status: 'unavailable', failure: runtimeFailureMessage(result.failure) } };
			this.refresh();
			if (showFailure) {
				void vscode.window.showErrorMessage(vscode.l10n.t('The saved plan could not be reloaded from this workspace.'));
			}
			return;
		}
		this.applyPlanView(result.value);
	}

	private async runPlanAction(action: 'review' | 'approve-all' | 'approve-step' | 'run' | 'resume' | 'cancel', stepId?: string): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const plan = this.state.plan.record;
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open the local folder that owns this plan before changing it.'));
			return;
		}
		if (!plan) {
			return;
		}
		if (this.planCancellationInProgress) {
			return;
		}

		if (action === 'cancel') {
			this.planCancellationInProgress = true;
			this.state = { ...this.state, plan: { ...this.state.plan, status: 'loading', failure: undefined } };
			this.refresh();
			try {
				const active = this.activePlanRun;
				if (active) {
					active.cancel();
					await active.result;
					if (this.activePlanRun === active) {
						this.activePlanRun = undefined;
					}
				}
				this.applyPlanResult(await changeFikeyaPlan('cancel', plan.planId, workspacePath));
			} finally {
				this.planCancellationInProgress = false;
				this.refresh();
			}
			return;
		}

		if (this.activePlanRun) {
			return;
		}
		if ((action === 'approve-step' || action === 'approve-all') && !await this.confirmPlanApproval(plan, action === 'approve-step' ? stepId : undefined)) {
			return;
		}

		this.state = { ...this.state, plan: { ...this.state.plan, status: action === 'run' || action === 'resume' ? 'running' : 'loading', failure: undefined } };
		this.refresh();
		if (action === 'review') {
			this.applyPlanResult(await changeFikeyaPlan('review', plan.planId, workspacePath));
			return;
		}
		if (action === 'approve-all') {
			const pendingStepIds = plan.steps
				.filter(step => step.status === 'pending' || step.status === 'awaiting_approval')
				.map(step => step.stepId);
			if (pendingStepIds.length === 0) {
				this.applyPlanFailure(vscode.l10n.t('No pending plan steps are available for approval.'));
				return;
			}
			this.applyPlanResult(await approveFikeyaPlan(plan.planId, pendingStepIds, workspacePath));
			return;
		}
		if (action === 'approve-step') {
			if (!stepId) {
				this.applyPlanFailure(vscode.l10n.t('Choose one waiting step before approving it.'));
				return;
			}
			this.applyPlanResult(await approveFikeyaPlan(plan.planId, [stepId], workspacePath));
			return;
		}

		const operation = startFikeyaPlan(action, plan.planId, workspacePath);
		this.activePlanRun = operation;
		const disposeProgress = operation.onProgress(progress => {
			if (this.activePlanRun !== operation) {
				return;
			}
			this.state = {
				...this.state,
				plan: { ...this.state.plan, progress }
			};
			this.refresh();
		});
		const result = await operation.result.finally(disposeProgress);
		if (this.activePlanRun !== operation) {
			return;
		}
		this.activePlanRun = undefined;
		this.applyPlanResult(result);
	}

	private async confirmPlanApproval(plan: FikeyaPlanRecord, stepId?: string): Promise<boolean> {
		const steps = stepId ? plan.steps.filter(step => step.stepId === stepId) : plan.steps.filter(step => step.status === 'pending' || step.status === 'awaiting_approval');
		if (steps.length === 0) {
			return false;
		}
		const approve = steps.length === 1 ? vscode.l10n.t('Approve Exact Step') : vscode.l10n.t('Approve All Exact Steps');
		const detail = steps.map(step => `${step.order}. ${step.title}\n${step.toolCall.name}\n${step.toolCallSha256}\n${JSON.stringify(step.toolCall.arguments, null, 2)}`).join('\n\n');
		const selected = await vscode.window.showWarningMessage(
			vscode.l10n.t('Issue {0} single-use approval reference(s)?', steps.length),
			{ modal: true, detail },
			approve
		);
		return selected === approve;
	}

	private applyPlanResult(result: Awaited<ReturnType<typeof loadFikeyaPlan>>): void {
		if (!result.ok || !result.value) {
			this.applyPlanFailure(runtimeFailureMessage(result.failure));
			return;
		}
		this.applyPlanView(result.value);
	}

	private applyPlanView(value: { readonly plan: FikeyaPlanRecord; readonly recordSha256: string }): void {
		this.state = { ...this.state, plan: { status: 'ready', record: value.plan, recordSha256: value.recordSha256 } };
		this.refresh();
	}

	private applyPlanFailure(message: string): void {
		this.state = { ...this.state, plan: { status: 'unavailable', record: this.state.plan.record, recordSha256: this.state.plan.recordSha256, failure: message } };
		this.refresh();
		void vscode.window.showErrorMessage(message);
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
		const planOperationInProgress = this.activePlanRun !== undefined || this.planCancellationInProgress;
		const agentSurface = renderAgentSurface(this.state, strings, this.state.activeMode === 'research', planOperationInProgress);
		const planSurface = renderPlanSurface(this.state, strings);
		const statisticsSurface = renderStatistics(this.state.statistics, strings);
		const memoryGraph = renderMemoryGraph(this.state, strings);
		const memoryGraphData = serializeForHtml(this.state.memory.snapshot ?? { nodes: [], edges: [] });
		const latestReceipt = this.state.agent.receipts.at(-1);
		const selectedProvider = this.state.providers.find(provider => provider.name === this.state.agent.providerName) ?? this.state.providers.at(0);
		const providerSummary = selectedProvider ? `${selectedProvider.name} / ${selectedProvider.model}` : strings.noProviderSelected;
		const usageBasis = this.state.agent.usage?.measurement ?? strings.noUsageRecorded;
		const contextStatus = formatContextStatus(this.state.agent.memory, strings);
		const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fikeya.svg'));
		const initialSurface = this.state.activeMode === 'plan' || this.state.activeMode === 'context' || this.state.activeMode === 'usage' || this.state.activeMode === 'setup'
			? this.state.activeMode
			: 'chat';
		const desktopNavigation = `<div class="workspace-navigation"><nav class="mode-switcher" role="tablist" aria-label="${escapeHtml(strings.workspaceModes)}">
			<button id="surface-tab-chat" role="tab" aria-controls="surface-panel-chat" aria-selected="${initialSurface === 'chat'}" tabindex="${initialSurface === 'chat' ? '0' : '-1'}" data-surface-tab="chat" data-surface-target="chat" type="button">${escapeHtml(vscode.l10n.t('Chat'))}</button>
			<button id="surface-tab-plan" role="tab" aria-controls="surface-panel-plan" aria-selected="${initialSurface === 'plan'}" tabindex="${initialSurface === 'plan' ? '0' : '-1'}" data-surface-tab="plan" data-surface-target="plan" type="button">${escapeHtml(vscode.l10n.t('Plan'))}</button>
			<button id="surface-tab-context" role="tab" aria-controls="surface-panel-context" aria-selected="${initialSurface === 'context'}" tabindex="${initialSurface === 'context' ? '0' : '-1'}" data-surface-tab="context" data-surface-target="context" type="button">${escapeHtml(vscode.l10n.t('Context'))}</button>
			<button id="surface-tab-usage" role="tab" aria-controls="surface-panel-usage" aria-selected="${initialSurface === 'usage'}" tabindex="${initialSurface === 'usage' ? '0' : '-1'}" data-surface-tab="usage" data-surface-target="usage" type="button">${escapeHtml(vscode.l10n.t('Usage'))}</button>
		</nav><nav class="native-actions" aria-label="${escapeHtml(vscode.l10n.t('Workbench destinations'))}"><button class="quiet" data-command="fikeya.mode.research" type="button">${escapeHtml(vscode.l10n.t('Research'))}</button><button class="quiet" id="surface-action-setup" data-surface-target="setup" data-command="fikeya.view.setup" type="button">${escapeHtml(vscode.l10n.t('Setup'))}</button><button class="quiet" data-command="fikeya.mode.editor" type="button">${escapeHtml(vscode.l10n.t('Code'))}</button><button class="quiet" data-command="fikeya.mode.terminal" type="button">${escapeHtml(strings.terminalMode)}</button><button class="quiet" data-command="fikeya.mode.review" type="button">${escapeHtml(strings.reviewMode)}</button></nav></div>`;
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
		const usageSurface = `${statisticsSurface}${this.state.agent.sessionId ? `<section class="card"><h2>${escapeHtml(strings.latestCallReceipt)}</h2>${renderReceipt(latestReceipt, this.state.agent, strings)}</section>` : ''}`;
		const surfacePanels = `<div class="active-surface" data-initial-surface="${initialSurface}" data-plan-id="${escapeHtml(this.state.plan.record?.planId ?? '')}">
			<section id="surface-panel-chat" class="surface-panel" role="tabpanel" aria-labelledby="surface-tab-chat" data-surface-panel="chat"${initialSurface === 'chat' ? '' : ' hidden'}>${agentSurface}</section>
			<section id="surface-panel-plan" class="surface-panel" role="tabpanel" aria-labelledby="surface-tab-plan" data-surface-panel="plan"${initialSurface === 'plan' ? '' : ' hidden'}>${planSurface}</section>
			<section id="surface-panel-context" class="surface-panel" role="tabpanel" aria-labelledby="surface-tab-context" data-surface-panel="context"${initialSurface === 'context' ? '' : ' hidden'}>${memoryGraph}</section>
			<section id="surface-panel-usage" class="surface-panel" role="tabpanel" aria-labelledby="surface-tab-usage" data-surface-panel="usage"${initialSurface === 'usage' ? '' : ' hidden'}>${usageSurface}</section>
			<section id="surface-panel-setup" class="surface-panel" role="region" aria-labelledby="surface-action-setup" data-surface-panel="setup"${initialSurface === 'setup' ? '' : ' hidden'}>${setupCards}</section>
		</div>`;
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
		${surfacePanels}`;

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
		html, body { min-width: 0; max-width: 100%; overflow-x: hidden; }
		body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
		body[data-surface="editor"] { background: var(--vscode-editor-background); }
		button { min-height: 30px; padding: 5px 9px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		button:disabled { cursor: not-allowed; opacity: .58; }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
		.shell { display: grid; width: min(100%, 960px); min-width: 0; gap: 12px; margin: 0 auto; padding: 12px; }
		body[data-surface="editor"] .shell { width: 100%; max-width: 1480px; gap: 10px; padding: 12px 16px 28px; }
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
		.mode-switcher { display: grid; min-width: min(100%, 480px); max-width: 100%; grid-template-columns: repeat(4, minmax(82px, 1fr)); overflow-x: auto; border: 1px solid var(--vscode-widget-border); background: var(--vscode-widget-border); gap: 1px; }
		.mode-switcher button { min-width: 82px; border: 0; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); font-size: 11px; }
		.mode-switcher button:hover { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.mode-switcher button[aria-selected="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
		.native-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; justify-content: end; gap: 3px; }
		button.quiet { min-height: 28px; border-color: var(--vscode-widget-border); color: var(--vscode-foreground); background: transparent; }
		button.quiet:hover { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.active-surface, .surface-panel { display: grid; width: 100%; min-width: 0; max-width: 100%; grid-template-columns: minmax(0, 1fr); gap: 10px; }
		.surface-panel[hidden] { display: none; }
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
		.agent-surface { display: grid; min-width: 0; gap: 10px; padding: 0; overflow: visible; }
		.agent-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
		.agent-heading-actions { display: flex; align-items: center; gap: 6px; }
		.agent-heading { padding: 12px 14px 0; }
		.agent-heading h2 { margin: 0; font-size: 16px; }
		.agent-heading p { margin-top: 3px; font-size: 11px; }
		.chat-plan-strip { display: grid; min-width: 0; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) auto; align-items: center; gap: 10px; margin: 0 14px; padding: 9px 10px; border: 1px solid var(--vscode-widget-border); border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); }
		.chat-plan-copy, .chat-plan-step { display: grid; min-width: 0; gap: 2px; }
		.chat-plan-copy strong, .chat-plan-step strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.chat-plan-copy span, .chat-plan-step span { color: var(--vscode-descriptionForeground); font-size: 10px; }
		.chat-plan-copy strong { font-size: 12px; }
		.chat-plan-step strong { font-size: 11px; }
		.chat-plan-status { display: inline-flex; width: fit-content; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.chat-thread { display: flex; min-height: clamp(300px, 48vh, 540px); max-height: min(64vh, 760px); flex-direction: column; gap: 16px; overflow: auto; padding: 20px 16px; border-block: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); scroll-behavior: smooth; }
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
		.run-controls { min-width: 0; }
		.run-controls summary { min-height: 30px; padding: 6px 9px; border: 1px solid var(--vscode-widget-border); cursor: pointer; list-style: none; }
		.run-controls summary::-webkit-details-marker { display: none; }
		.run-controls[open] .control-grid { display: grid; }
		.control-grid { display: none; width: min(100%, 640px); grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 5px; padding: 12px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-menu-background); }
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
		.plan-surface { min-width: 0; }
		.plan-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
	.plan-heading h2 { margin: 0; font-size: 16px; }
	.plan-heading p { max-width: 70ch; margin-top: 4px; }
	.plan-progress { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; color: var(--vscode-descriptionForeground); }
	.plan-proposal-form { margin-top: 12px; padding: 14px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); }
	.plan-proposal-form .composer textarea { min-height: 112px; }
	.advanced-plan-json { margin-top: 12px; border-top: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); }
	.advanced-plan-json > summary { width: max-content; max-width: 100%; padding: 12px 0 6px; cursor: pointer; font-size: 11px; }
	.plan-create-form { display: grid; gap: 10px; margin-top: 12px; }
		.plan-create-form textarea { min-height: 300px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); tab-size: 2; }
		.plan-client-error { margin: 0; color: var(--vscode-errorForeground); }
		.plan-actions { margin: 12px 0; }
		.plan-bulk-approval { margin-top: 12px; border-top: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); }
		.plan-bulk-approval > summary { width: max-content; padding: 10px 0 6px; cursor: pointer; font-size: 11px; }
		.plan-bulk-approval .actions { margin-top: 8px; }
		.plan-lifecycle { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; margin: 12px 0 0; padding: 1px; list-style: none; background: var(--vscode-widget-border); }
		.plan-lifecycle li { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 7px; padding: 8px; background: var(--vscode-editorWidget-background); }
		.plan-lifecycle li span { display: grid; width: 20px; height: 20px; place-items: center; border: 1px solid var(--vscode-widget-border); border-radius: 50%; font-family: var(--vscode-editor-font-family); font-size: 9px; }
		.plan-lifecycle li strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
		.plan-lifecycle li[data-status="complete"] span { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
		.plan-lifecycle li[data-status="active"] span { border-color: var(--vscode-progressBar-background); background: var(--vscode-progressBar-background); color: var(--vscode-button-foreground); }
		.plan-lifecycle li[data-status="attention"] span { border-color: var(--vscode-testing-iconFailed); color: var(--vscode-testing-iconFailed); }
		.plan-workspace { display: grid; min-width: 0; grid-template-columns: minmax(220px, .62fr) minmax(0, 1.38fr); gap: 10px; }
		.plan-timeline { display: grid; align-content: start; gap: 1px; min-width: 0; padding: 1px; background: var(--vscode-widget-border); }
		.plan-step { display: grid; min-width: 0; min-height: 58px; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; gap: 9px; border: 0; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); text-align: left; }
		.plan-step:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
		.plan-step[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
		.plan-step-index { display: grid; width: 24px; height: 24px; place-items: center; border: 1px solid currentColor; border-radius: 50%; font-family: var(--vscode-editor-font-family); font-size: 10px; }
		.plan-step-copy { min-width: 0; }
		.plan-step-copy strong, .plan-step-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.plan-step-copy span { margin-top: 2px; opacity: .78; font-size: 10px; }
		.plan-step-status { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: capitalize; }
		.plan-step[data-status="complete"] .plan-step-index { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
		.plan-step[data-status="active"] .plan-step-index { border-color: var(--vscode-progressBar-background); background: var(--vscode-progressBar-background); color: var(--vscode-button-foreground); }
		.plan-step[data-status="attention"] .plan-step-index { border-color: var(--vscode-testing-iconFailed); color: var(--vscode-testing-iconFailed); }
		.plan-details { display: grid; min-width: 0; align-content: start; gap: 12px; padding: 14px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); }
		.plan-detail[hidden] { display: none; }
		.plan-detail h3 { margin: 0; font-size: 15px; }
		.plan-detail-copy { margin-top: 6px; }
		.plan-evidence { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin-top: 12px; background: var(--vscode-widget-border); }
		.plan-evidence div { min-width: 0; padding: 9px; background: var(--vscode-editorWidget-background); }
		.plan-evidence span, .plan-evidence strong { display: block; }
		.plan-evidence span { color: var(--vscode-descriptionForeground); font-size: 10px; }
		.plan-evidence strong { margin-top: 3px; overflow-wrap: anywhere; }
		.plan-lines { display: grid; gap: 6px; margin: 10px 0 0; padding-left: 20px; }
		.plan-lines li { padding-left: 3px; line-height: 1.45; }
		.plan-boundary { margin-top: 10px; padding-left: 9px; border-left: 2px solid var(--vscode-focusBorder); }
		.memory-graph { width: 100%; min-width: 0; max-width: 100%; grid-template-columns: minmax(0, 1fr); overflow: hidden; }
		.graph-controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(105px, .4fr) minmax(120px, .48fr) auto; gap: 6px; }
		.graph-controls > *, .graph-workspace > * { min-width: 0; max-width: 100%; }
		.graph-controls input, .graph-controls select { min-width: 0; max-width: 100%; }
		.graph-controls input { min-height: 30px; padding: 4px 7px; }
		.graph-workspace { display: grid; width: 100%; min-width: 0; max-width: 100%; grid-template-columns: minmax(0, 1fr) minmax(240px, 340px); gap: 8px; }
		.graph-viewport { position: relative; width: 100%; min-width: 0; max-width: 100%; min-height: clamp(420px, 58vh, 680px); overflow: hidden; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); }
		.graph-canvas { display: block; width: 100%; max-width: 100%; height: 100%; min-height: clamp(420px, 58vh, 680px); touch-action: none; user-select: none; }
		.graph-hit { fill: transparent; cursor: grab; }
		.graph-hit[data-panning="true"] { cursor: grabbing; }
		.graph-edge { stroke: var(--vscode-editorWidget-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
		.graph-node { cursor: grab; }
		.graph-node:focus-visible .graph-halo, .graph-node[data-selected="true"] .graph-halo { stroke: var(--vscode-focusBorder); stroke-width: 3; }
		.graph-node[data-dragging="true"] { cursor: grabbing; }
		.graph-halo { fill: var(--vscode-editor-background); stroke: var(--vscode-widget-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
		.graph-dot { stroke: var(--vscode-editor-foreground); stroke-width: .6; vector-effect: non-scaling-stroke; }
		.graph-label { fill: var(--vscode-editor-foreground); stroke: var(--vscode-editor-background); stroke-width: 3px; paint-order: stroke; font-family: var(--vscode-editor-font-family); font-size: 9px; pointer-events: none; }
		.graph-details { display: grid; width: 100%; min-width: 0; max-width: 100%; max-height: clamp(420px, 58vh, 680px); align-content: start; gap: 8px; overflow: auto; padding: 10px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
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
		.graph-summary, .graph-summary code { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
		.graph-summary { max-width: 100%; color: var(--vscode-descriptionForeground); font-size: 11px; }
		.disclaimer { padding-left: 9px; border-left: 2px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
		@media (min-width: 620px) { .run-strip { grid-template-columns: minmax(190px, 2fr) repeat(4, minmax(82px, 1fr)); } .run-metric.provider { grid-column: auto; } }
			@media (min-width: 520px) { .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .statistics-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
		@media (max-width: 900px) { .graph-workspace, .plan-workspace { grid-template-columns: 1fr; } .graph-details { max-height: none; } }
		@media (max-width: 780px) { .workspace-navigation { align-items: stretch; flex-direction: column; } .mode-switcher { width: 100%; } .native-actions { justify-content: start; } }
		@media (max-width: 720px) { .chat-plan-strip { grid-template-columns: minmax(0, 1fr) auto; } .chat-plan-copy { grid-column: 1 / -1; } .composer-bar { grid-template-columns: 1fr; } .inline-field select { max-width: none; } .control-grid { width: 100%; grid-template-columns: 1fr; } .control-grid .field:first-child { grid-column: auto; } .composer-actions { justify-content: start; } .composer-foot { flex-direction: column; } .plan-evidence { grid-template-columns: 1fr; } .plan-lifecycle { grid-template-columns: 1fr; } }
			@media (max-width: 520px) { .graph-controls { grid-template-columns: 1fr 1fr; } .graph-controls .actions { grid-column: 1 / -1; } .statistics-status { grid-template-columns: 1fr; } }
		@media (max-width: ${fikeyaNarrowPanelMaximumWidth}px) { body[data-surface="editor"] .shell { padding-inline: 8px; } .masthead { padding-inline: 9px; } .workspace-label { max-width: 42%; } .mode-switcher { min-width: 0; grid-template-columns: repeat(4, minmax(64px, 1fr)); } .mode-switcher button { min-width: 64px; padding-inline: 5px; } .native-actions button { flex: 1 1 auto; } .run-strip, .statistics-grid { grid-template-columns: 1fr; } .run-metric.provider { grid-column: auto; } .agent-heading, .plan-heading { align-items: stretch; flex-direction: column; } .agent-heading-actions { justify-content: space-between; } .chat-plan-strip { grid-template-columns: 1fr; margin-inline: 8px; } .chat-plan-copy { grid-column: auto; } .chat-plan-strip button { width: 100%; } .chat-thread { min-height: 260px; padding: 14px 10px; } .chat-message { max-width: 100%; } .message-meta { flex-wrap: wrap; } .message-meta time { margin-left: 0; } .agent-form { padding-inline: 8px; } .control-grid { max-width: 100%; padding: 8px; } .composer-actions { display: grid; grid-template-columns: 1fr; } .composer-actions button { width: 100%; } .agent-status, .run-details { margin-inline: 8px; } .receipt, .statistics-status dl { grid-template-columns: 1fr; } .table-scroll { overscroll-behavior-inline: contain; } .plan-step { grid-template-columns: 26px minmax(0, 1fr); } .plan-step-status { grid-column: 2; } .graph-controls { grid-template-columns: 1fr; } .graph-controls .actions { grid-column: 1; } .graph-viewport, .graph-canvas { min-height: 340px; } .graph-details { padding: 8px; } }
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
		const persistedState = vscode.getState() || {};
		const surfaceRoot = document.querySelector('[data-initial-surface]');
		const surfaceTabs = Array.from(document.querySelectorAll('[data-surface-tab]'));
		const surfaceTargets = Array.from(document.querySelectorAll('[data-surface-target]'));
		const surfacePanels = Array.from(document.querySelectorAll('[data-surface-panel]'));
		const availableSurfaces = new Set(surfacePanels.map(panel => panel.dataset.surfacePanel));
		const activePlanId = surfaceRoot?.dataset.planId || '';
		const activateSurface = (surfaceName, focus = false) => {
			if (!surfaceName || !availableSurfaces.has(surfaceName)) return;
			for (const panel of surfacePanels) panel.hidden = panel.dataset.surfacePanel !== surfaceName;
			for (const tab of surfaceTabs) {
				const selected = tab.dataset.surfaceTab === surfaceName;
				tab.setAttribute('aria-selected', String(selected));
				tab.tabIndex = selected ? 0 : -1;
				if (selected && focus) tab.focus();
			}
			const state = vscode.getState() || {};
			vscode.setState({ ...state, surface: surfaceName, planId: activePlanId, planStep: state.planId === activePlanId ? state.planStep : undefined });
		};
		for (const target of surfaceTargets) target.addEventListener('click', () => {
			activateSurface(target.dataset.surfaceTarget);
			if (target.dataset.surfaceTab) vscode.postMessage({ type: 'selectSurface', surface: target.dataset.surfaceTab });
		});
		document.querySelector('[data-open-plan]')?.addEventListener('click', () => {
			activateSurface('plan', true);
			vscode.postMessage({ type: 'selectSurface', surface: 'plan' });
		});
		for (const [index, tab] of surfaceTabs.entries()) tab.addEventListener('keydown', event => {
			let nextIndex;
			if (event.key === 'ArrowRight') nextIndex = (index + 1) % surfaceTabs.length;
			else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + surfaceTabs.length) % surfaceTabs.length;
			else if (event.key === 'Home') nextIndex = 0;
			else if (event.key === 'End') nextIndex = surfaceTabs.length - 1;
			else return;
			event.preventDefault();
			surfaceTabs[nextIndex].click();
			surfaceTabs[nextIndex].focus();
		});
		const serverInitialSurface = surfaceRoot?.dataset.initialSurface || 'chat';
		const initialSurface = serverInitialSurface === 'chat' && persistedState.surface === 'plan' ? 'plan' : serverInitialSurface;
		activateSurface(initialSurface);
		const planSteps = Array.from(document.querySelectorAll('[data-plan-step]'));
		const planDetails = Array.from(document.querySelectorAll('[data-plan-detail]'));
		const selectPlanStep = (stepId, focus = false) => {
			if (!planSteps.some(step => step.dataset.planStep === stepId)) return;
			for (const step of planSteps) {
				const selected = step.dataset.planStep === stepId;
				step.setAttribute('aria-selected', String(selected));
				step.tabIndex = selected ? 0 : -1;
				if (selected && focus) step.focus();
			}
			for (const detail of planDetails) detail.hidden = detail.dataset.planDetail !== stepId;
			const state = vscode.getState() || {};
			vscode.setState({ ...state, planId: activePlanId, planStep: stepId });
		};
		for (const [index, step] of planSteps.entries()) {
			step.addEventListener('click', () => selectPlanStep(step.dataset.planStep));
			step.addEventListener('keydown', event => {
				let nextIndex;
				if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % planSteps.length;
				else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + planSteps.length) % planSteps.length;
				else if (event.key === 'Home') nextIndex = 0;
				else if (event.key === 'End') nextIndex = planSteps.length - 1;
				else return;
				event.preventDefault();
				selectPlanStep(planSteps[nextIndex].dataset.planStep, true);
			});
		}
		const renderedPlanStep = planSteps.find(step => step.getAttribute('aria-selected') === 'true')?.dataset.planStep;
		const persistedPlanStep = persistedState.planId === activePlanId ? persistedState.planStep : undefined;
		selectPlanStep(planSteps.some(step => step.dataset.planStep === persistedPlanStep) ? persistedPlanStep : renderedPlanStep);
		const planCreateForm = document.querySelector('[data-plan-create-form]');
		const planClientError = document.querySelector('[data-plan-client-error]');
		planCreateForm?.addEventListener('submit', event => {
			event.preventDefault();
			const source = planCreateForm.querySelector('[name="specification"]')?.value;
			try {
				const specification = JSON.parse(source || '');
				if (!specification || typeof specification !== 'object' || Array.isArray(specification)) throw new Error('Plan must be a JSON object.');
				if (planClientError) planClientError.hidden = true;
				vscode.postMessage({ type: 'createPlan', specification });
			} catch (error) {
				if (planClientError) {
					planClientError.textContent = error instanceof Error ? error.message : 'Plan JSON is invalid.';
					planClientError.hidden = false;
				}
			}
		});
		const planProposalForm = document.querySelector('[data-plan-proposal-form]');
		const planNetworkConsent = planProposalForm?.querySelector('[data-plan-network-consent]');
		const planProposalButton = planProposalForm?.querySelector('[data-plan-proposal-run]');
		if (planProposalForm && planNetworkConsent && planProposalButton) {
			const updatePlanProposalButton = () => { planProposalButton.disabled = !planNetworkConsent.checked; };
			planNetworkConsent.addEventListener('change', updatePlanProposalButton);
			updatePlanProposalButton();
			planProposalForm.addEventListener('submit', event => {
				event.preventDefault();
				const providerName = planProposalForm.querySelector('[name="providerName"]')?.value;
				const prompt = planProposalForm.querySelector('[name="prompt"]')?.value;
				const maxOutputTokens = Number(planProposalForm.querySelector('[name="maxOutputTokens"]')?.value);
				const contextMaxCharacters = Number(planProposalForm.querySelector('[name="contextMaxCharacters"]')?.value);
				const memoryMode = planProposalForm.querySelector('[name="memoryMode"]')?.value;
				if (!planNetworkConsent.checked || !providerName || !prompt?.trim() || !Number.isSafeInteger(maxOutputTokens) || !Number.isSafeInteger(contextMaxCharacters) || !['auto', 'off', 'required'].includes(memoryMode)) return;
				planProposalButton.disabled = true;
				vscode.postMessage({ type: 'proposePlan', providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, allowNetwork: true });
			});
		}
		document.querySelector('[data-plan-refresh]')?.addEventListener('click', () => vscode.postMessage({ type: 'refreshPlan' }));
		document.querySelector('[data-plan-new]')?.addEventListener('click', () => vscode.postMessage({ type: 'newPlan' }));
		document.querySelectorAll('[data-plan-action]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'planAction', action: button.dataset.planAction, stepId: button.dataset.planActionStep })));
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
		const planButton = document.querySelector('[data-agent-plan]');
		const promptField = agentForm?.querySelector('[name="prompt"]');
		document.querySelectorAll('[data-prompt-value]').forEach(button => button.addEventListener('click', () => {
			if (!promptField) return;
			promptField.value = button.dataset.promptValue ?? '';
			promptField.focus();
		}));
		if (agentForm && networkConsent && runButton) {
			const readAgentRequest = () => {
				const providerName = agentForm.querySelector('[name="providerName"]')?.value;
				const prompt = agentForm.querySelector('[name="prompt"]')?.value;
				const maxOutputTokens = Number(agentForm.querySelector('[name="maxOutputTokens"]')?.value);
				const contextMaxCharacters = Number(agentForm.querySelector('[name="contextMaxCharacters"]')?.value);
				const memoryMode = agentForm.querySelector('[name="memoryMode"]')?.value;
				if (!networkConsent.checked || !providerName || !prompt?.trim() || !Number.isSafeInteger(maxOutputTokens) || !Number.isSafeInteger(contextMaxCharacters) || !['auto', 'off', 'required'].includes(memoryMode)) return undefined;
				return { providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, allowNetwork: true };
			};
			const setRunButtonsDisabled = disabled => {
				runButton.disabled = disabled;
				if (planButton) planButton.disabled = disabled;
			};
			const updateRunButtons = () => setRunButtonsDisabled(!networkConsent.checked);
			networkConsent.addEventListener('change', updateRunButtons);
			updateRunButtons();
			agentForm.addEventListener('submit', event => {
				event.preventDefault();
				const request = readAgentRequest();
				if (!request) return;
				setRunButtonsDisabled(true);
				vscode.postMessage({ type: 'runAgent', ...request });
			});
			planButton?.addEventListener('click', () => {
				const request = readAgentRequest();
				if (!request) return;
				setRunButtonsDisabled(true);
				vscode.postMessage({ type: 'proposePlan', ...request });
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

function renderPlanSurface(state: DashboardState, strings: WebviewStrings): string {
	const plan = state.plan.record;
	const sample = JSON.stringify({
		schemaVersion: 1,
		title: 'Inspect this project safely',
		steps: [{
			stepId: 'list-project-files',
			title: 'List bounded project files',
			toolCall: { callId: 'plan:list-files', name: 'workspace.list_files', arguments: { path: '.' } },
			verify: { expectedStatus: 'ok' }
		}]
	}, null, 2);
	if (!plan) {
		const controlsDisabled = state.plan.status === 'loading' || state.providers.length === 0;
		const providerOptions = state.providers.length === 0
			? `<option value="">${escapeHtml(strings.noProviders)}</option>`
			: state.providers.map(provider => `<option value="${escapeHtml(provider.name)}"${state.agent.providerName === provider.name ? ' selected' : ''}>${escapeHtml(`${provider.name} | ${provider.model}`)}</option>`).join('');
		const narrativeBoundary = state.agent.outcome
			? vscode.l10n.t('The latest Chat run returned a provider narrative, but it is not an immutable structured plan. Create an exact local plan below before claiming step-level proof.')
			: vscode.l10n.t('Describe the outcome. Fikeya drafts exact steps first, then keeps review, one-use approval, execution, and verification visibly separate.');
		return `<section class="card plan-surface" aria-labelledby="plan-surface-title">
			<div class="plan-heading"><div><h2 id="plan-surface-title">${escapeHtml(vscode.l10n.t('Plan to proof'))}</h2><p>${escapeHtml(narrativeBoundary)}</p></div><span class="badge">${escapeHtml(state.plan.status === 'loading' ? vscode.l10n.t('Creating') : vscode.l10n.t('No tool has run'))}</span></div>
			<ol class="plan-lifecycle" aria-label="${escapeHtml(vscode.l10n.t('Plan lifecycle'))}"><li data-status="active"><span>1</span><strong>${escapeHtml(vscode.l10n.t('Draft'))}</strong></li><li><span>2</span><strong>${escapeHtml(vscode.l10n.t('Review'))}</strong></li><li><span>3</span><strong>${escapeHtml(vscode.l10n.t('Approval'))}</strong></li><li><span>4</span><strong>${escapeHtml(vscode.l10n.t('Execute'))}</strong></li><li><span>5</span><strong>${escapeHtml(vscode.l10n.t('Verify'))}</strong></li></ol>
			${state.plan.failure ? `<p class="plan-boundary" role="alert">${escapeHtml(state.plan.failure)}</p>` : ''}
			<form class="agent-form plan-proposal-form" data-plan-proposal-form autocomplete="off">
				<label class="field composer"><span>${escapeHtml(vscode.l10n.t('What should Fikeya build or change?'))}</span><textarea name="prompt" maxlength="65536" placeholder="${escapeHtml(vscode.l10n.t('Describe the outcome, constraints, and how you want it verified...'))}"${controlsDisabled ? ' disabled' : ''} required></textarea></label>
				<div class="composer-bar"><label class="field inline-field"><span class="sr-only">${escapeHtml(strings.provider)}</span><select name="providerName" aria-label="${escapeHtml(strings.provider)}"${controlsDisabled ? ' disabled' : ''}>${providerOptions}</select></label><details class="run-controls"><summary>${escapeHtml(vscode.l10n.t('Model and context'))}</summary><div class="control-grid"><label class="field"><span>${escapeHtml(strings.contextMode)}</span><select name="memoryMode"${controlsDisabled ? ' disabled' : ''}><option value="${agentComposerDefaults.memoryMode}">${escapeHtml(strings.contextAuto)}</option><option value="required">${escapeHtml(strings.contextRequired)}</option><option value="off">${escapeHtml(strings.contextOff)}</option></select></label><label class="field"><span>${escapeHtml(strings.contextBudget)}</span><input name="contextMaxCharacters" type="number" min="${agentComposerConstraints.contextMaxCharacters.minimum}" max="${agentComposerConstraints.contextMaxCharacters.maximum}" step="${agentComposerConstraints.contextMaxCharacters.step}" value="${agentComposerDefaults.contextMaxCharacters}"${controlsDisabled ? ' disabled' : ''} required></label><label class="field"><span>${escapeHtml(strings.maximumOutputTokens)}</span><input name="maxOutputTokens" type="number" min="${agentComposerConstraints.maxOutputTokens.minimum}" max="${agentComposerConstraints.maxOutputTokens.maximum}" step="${agentComposerConstraints.maxOutputTokens.step}" value="${agentComposerDefaults.maxOutputTokens}"${controlsDisabled ? ' disabled' : ''} required></label></div></details><div class="actions composer-actions"><button data-plan-proposal-run type="submit"${controlsDisabled ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Draft plan'))}</button></div></div>
				<div class="composer-foot"><label class="consent"><input data-plan-network-consent type="checkbox"${controlsDisabled ? ' disabled' : ''}><span>${escapeHtml(vscode.l10n.t('Allow provider network to draft this plan'))}</span></label><span>${escapeHtml(vscode.l10n.t('No workspace tool runs during drafting'))}</span></div>
			</form>
			<details class="advanced-plan-json"><summary>${escapeHtml(vscode.l10n.t('Advanced: create from exact JSON'))}</summary><form class="plan-create-form" data-plan-create-form><label class="field"><span>${escapeHtml(vscode.l10n.t('Exact plan JSON'))}</span><textarea name="specification" rows="18" maxlength="1048576" spellcheck="false"${state.plan.status === 'loading' ? ' disabled' : ''}>${escapeHtml(sample)}</textarea></label><p class="plan-boundary">${escapeHtml(vscode.l10n.t('This JSON crosses to the local runtime through stdin and never appears in process arguments.'))}</p><p class="plan-client-error" data-plan-client-error role="alert" hidden></p><div class="actions"><button type="submit"${state.plan.status === 'loading' ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Create exact plan'))}</button></div></form></details>
		</section>`;
	}

	const initialStepId = selectInitialPlanStepId(plan.steps);
	const selectedStep = plan.steps.find(step => step.stepId === initialStepId) ?? plan.steps[0]!;
	const busy = state.plan.status === 'loading' || state.plan.status === 'running';
	const waitingSteps = plan.steps.filter(step => step.status === 'pending' || step.status === 'awaiting_approval');
	const approvedSteps = plan.steps.filter(step => step.status === 'approved');
	const lifecycle = renderPlanLifecycle(plan);
	const actionButtons = [
		plan.status === 'draft' ? `<button data-plan-action="review" type="button"${busy ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Review immutable plan'))}</button>` : '',
		plan.status === 'reviewed' ? `<button data-plan-action="run" type="button"${busy ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Start to approval'))}</button>` : '',
		(plan.status === 'executing' || plan.status === 'verifying' || (plan.status === 'awaiting_approval' && approvedSteps.length > 0)) ? `<button data-plan-action="resume" type="button"${busy ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Resume approved work'))}</button>` : '',
		!['succeeded', 'failed', 'cancelled'].includes(plan.status) ? `<button class="secondary" data-plan-action="cancel" type="button">${escapeHtml(vscode.l10n.t('Cancel plan'))}</button>` : '',
		`<button class="quiet" data-plan-refresh type="button"${busy ? ' disabled' : ''}>${escapeHtml(strings.refresh)}</button>`,
		`<button class="quiet" data-plan-new type="button"${busy ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('New plan'))}</button>`
	].join('');
	const bulkApproval = (plan.status === 'reviewed' || plan.status === 'awaiting_approval') && waitingSteps.length > 0
		? `<details class="plan-bulk-approval"><summary>${escapeHtml(vscode.l10n.t('Bulk approval'))}</summary><p>${escapeHtml(vscode.l10n.t('The selected step remains the primary approval path. Use this only when you have reviewed every pending tool call and exact argument.'))}</p><div class="actions"><button class="quiet" data-plan-action="approve-all" type="button"${busy ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Approve all {0} pending steps', waitingSteps.length))}</button></div></details>`
		: '';
	const timelineButtons = plan.steps.map(step => `<button class="plan-step" id="plan-step-${escapeHtml(step.stepId)}" role="tab" aria-controls="plan-detail-${escapeHtml(step.stepId)}" aria-selected="${step.stepId === selectedStep.stepId}" tabindex="${step.stepId === selectedStep.stepId ? '0' : '-1'}" data-plan-step="${escapeHtml(step.stepId)}" data-status="${planStepVisualStatus(step.status)}" type="button"><span class="plan-step-index" aria-hidden="true">${step.order}</span><span class="plan-step-copy"><strong>${escapeHtml(step.title)}</strong><span>${escapeHtml(step.toolCall.name)}</span></span><span class="plan-step-status">${escapeHtml(planStepStatusLabel(step.status))}</span></button>`).join('');
	const detailPanels = plan.steps.map(step => {
		const dependencies = step.dependsOn.length > 0 ? step.dependsOn.join(', ') : vscode.l10n.t('None');
		const approval = step.approval ? `${step.approval.referenceId}${step.approval.consumedAt ? ` · ${vscode.l10n.t('consumed')}` : ` · ${vscode.l10n.t('unused')}`}` : vscode.l10n.t('Not issued');
		const approvalExpiry = step.approval
			? `<dt>${escapeHtml(vscode.l10n.t('Approval expires'))}</dt><dd><time datetime="${escapeHtml(step.approval.expiresAt)}">${escapeHtml(step.approval.expiresAt)}</time></dd>`
			: '';
		const execution = step.execution ? `${step.execution.status} · ${step.execution.executionSha256}` : vscode.l10n.t('No execution receipt');
		const verification = step.verification ? `${step.verification.status} · ${step.verification.outcomeSha256}` : vscode.l10n.t('No verification receipt');
		const approveStep = (plan.status === 'reviewed' || plan.status === 'awaiting_approval') && (step.status === 'pending' || step.status === 'awaiting_approval')
			? `<button data-plan-action="approve-step" data-plan-action-step="${escapeHtml(step.stepId)}" type="button"${busy ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Approve this exact step'))}</button>`
			: '';
		const checks = step.verification?.checks.length
			? `<ul class="plan-lines">${step.verification.checks.map(check => `<li>${escapeHtml(check.passed ? '✓' : '×')} ${escapeHtml(check.kind)} · ${escapeHtml(check.subject)} · ${escapeHtml(check.actual)}</li>`).join('')}</ul>`
			: '';
		return `<section class="plan-detail" id="plan-detail-${escapeHtml(step.stepId)}" role="tabpanel" aria-labelledby="plan-step-${escapeHtml(step.stepId)}" data-plan-detail="${escapeHtml(step.stepId)}"${step.stepId === selectedStep.stepId ? '' : ' hidden'}>
			<h3>${escapeHtml(step.title)}</h3><p class="plan-detail-copy">${escapeHtml(vscode.l10n.t('Step {0} of {1}', step.order, plan.steps.length))}</p>
			<div class="plan-evidence"><div><span>${escapeHtml(vscode.l10n.t('Status'))}</span><strong>${escapeHtml(planStepStatusLabel(step.status))}</strong></div><div><span>${escapeHtml(vscode.l10n.t('Dependencies'))}</span><strong>${escapeHtml(dependencies)}</strong></div><div><span>${escapeHtml(vscode.l10n.t('Tool'))}</span><strong>${escapeHtml(step.toolCall.name)}</strong></div></div>
			<h4>${escapeHtml(vscode.l10n.t('Exact arguments'))}</h4><pre class="agent-output" tabindex="0">${escapeHtml(JSON.stringify(step.toolCall.arguments, null, 2))}</pre>
			<h4>${escapeHtml(vscode.l10n.t('Expected verification'))}</h4><pre class="agent-output" tabindex="0">${escapeHtml(JSON.stringify(step.verificationSpec, null, 2))}</pre>
			<dl class="receipt"><dt>${escapeHtml(vscode.l10n.t('Tool call evidence'))}</dt><dd><code>${escapeHtml(step.toolCallSha256)}</code></dd><dt>${escapeHtml(vscode.l10n.t('Approval'))}</dt><dd><code>${escapeHtml(approval)}</code></dd>${approvalExpiry}<dt>${escapeHtml(vscode.l10n.t('Execution'))}</dt><dd><code>${escapeHtml(execution)}</code></dd><dt>${escapeHtml(vscode.l10n.t('Verification'))}</dt><dd><code>${escapeHtml(verification)}</code></dd></dl>${checks}<div class="actions">${approveStep}</div>
		</section>`;
	}).join('');
	return `<section class="card plan-surface" aria-labelledby="plan-surface-title">
		<div class="plan-heading"><div><h2 id="plan-surface-title">${escapeHtml(plan.title)}</h2><p>${escapeHtml(vscode.l10n.t('Durable plan {0} · revision {1}', plan.planId, plan.revision))}</p></div><span class="badge">${escapeHtml(state.plan.status === 'running' ? vscode.l10n.t('Running') : planStatusLabel(plan.status))}</span></div>
		${lifecycle}
		${state.plan.progress ? `<p class="plan-progress" role="status"><span class="thinking-dot" aria-hidden="true"></span>${escapeHtml(formatRunProgress(state.plan.progress))}</p>` : ''}
		<div class="actions plan-actions">${actionButtons}</div>
		${state.plan.failure || plan.failureReason ? `<p class="plan-boundary" role="alert">${escapeHtml(state.plan.failure ?? plan.failureReason ?? '')}</p>` : ''}
		<div class="plan-workspace"><div class="plan-timeline" role="tablist" aria-label="${escapeHtml(vscode.l10n.t('Exact plan steps'))}">${timelineButtons}</div><div class="plan-details" aria-live="polite">${detailPanels}</div></div>${bulkApproval}
		<dl class="receipt compact-receipt"><dt>${escapeHtml(vscode.l10n.t('Specification'))}</dt><dd><code>${escapeHtml(plan.specSha256)}</code></dd><dt>${escapeHtml(vscode.l10n.t('Current record'))}</dt><dd><code>${escapeHtml(state.plan.recordSha256 ?? strings.unavailable)}</code></dd></dl>
	</section>`;
}

function renderPlanLifecycle(plan: FikeyaPlanRecord): string {
	const order: readonly { readonly id: FikeyaPlanStageId; readonly title: string }[] = [
		{ id: 'draft', title: vscode.l10n.t('Draft') },
		{ id: 'review', title: vscode.l10n.t('Review') },
		{ id: 'approval', title: vscode.l10n.t('Approval') },
		{ id: 'execute', title: vscode.l10n.t('Execute') },
		{ id: 'verify', title: vscode.l10n.t('Verify') }
	];
	const timeline = buildRecordedPlanTimeline(plan);
	return `<ol class="plan-lifecycle" aria-label="${escapeHtml(vscode.l10n.t('Plan lifecycle'))}">${order.map((stage, index) => {
		const visual = timeline.find(item => item.id === stage.id)?.status ?? 'pending';
		return `<li data-status="${visual}"><span>${index + 1}</span><strong>${escapeHtml(stage.title)}</strong></li>`;
	}).join('')}</ol>`;
}

function planStepVisualStatus(status: FikeyaPlanRecord['steps'][number]['status']): 'pending' | 'active' | 'complete' | 'attention' {
	if (status === 'succeeded') {
		return 'complete';
	}
	if (status === 'failed' || status === 'cancelled') {
		return 'attention';
	}
	if (status === 'awaiting_approval' || status === 'executing' || status === 'verifying') {
		return 'active';
	}
	return 'pending';
}

function planStepStatusLabel(status: FikeyaPlanRecord['steps'][number]['status']): string {
	return status.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function planStatusLabel(status: FikeyaPlanRecord['status']): string {
	return status.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function formatRunProgress(progress: FikeyaRunProgress): string {
	switch (progress.event) {
		case 'session.started':
		case 'session.resumed':
			return vscode.l10n.t('Starting the coding run');
		case 'context.attached':
			return vscode.l10n.t('Attached bounded project evidence');
		case 'plan.created':
			return vscode.l10n.t('Prepared the next step');
		case 'tool.proposed':
			return vscode.l10n.t('Reviewing an exact tool call');
		case 'approval.requested':
			return vscode.l10n.t('Waiting for your one-use approval');
		case 'tool.execution_claimed':
			return vscode.l10n.t('Running the approved tool');
		case 'tool.completed':
			return vscode.l10n.t('Recorded the tool result');
		case 'answer.proposed':
			return vscode.l10n.t('Preparing the answer');
		case 'review.completed':
			return vscode.l10n.t('Verifying the result');
		case 'retry.scheduled':
			return vscode.l10n.t('Retrying within the configured limit');
		case 'session.completed':
			return vscode.l10n.t('Recording final receipts');
		case 'session.cancelled':
			return vscode.l10n.t('Stopping at the current boundary');
		case 'session.failed':
			return vscode.l10n.t('The bounded run stopped safely');
	}
	switch (progress.stage) {
		case 'plan':
			return vscode.l10n.t('Planning the next step');
		case 'act':
			return vscode.l10n.t('Preparing an exact action');
		case 'awaiting_approval':
			return vscode.l10n.t('Waiting for your one-use approval');
		case 'observe':
			return vscode.l10n.t('Inspecting the tool result');
		case 'review':
			return vscode.l10n.t('Verifying the result');
		default:
			return vscode.l10n.t('Working on the current step');
	}
}

function renderAgentSurface(state: DashboardState, strings: WebviewStrings, researchMode: boolean, planOperationInProgress: boolean): string {
	const running = state.agent.status === 'running';
	const interactionBlocked = isChatInteractionBlocked({ agentRunning: running, planRunning: planOperationInProgress, planCancellationInProgress: false });
	const controlsDisabled = interactionBlocked || state.providers.length === 0;
	const providerOptions = state.providers.length === 0
		? `<option value="">${escapeHtml(strings.noProviders)}</option>`
		: state.providers.map(provider => `<option value="${escapeHtml(provider.name)}"${state.agent.providerName === provider.name ? ' selected' : ''}>${escapeHtml(`${provider.name} | ${provider.model}`)}</option>`).join('');
	const statusTone = state.agent.status === 'failed' || state.agent.status === 'cancelled' ? 'error' : 'normal';
	const conversation = state.conversation.length === 0
		? `<div class="chat-empty"><strong>${escapeHtml(researchMode ? vscode.l10n.t('Research the codebase') : vscode.l10n.t('Ask Fikeya about this project'))}</strong><p>${escapeHtml(researchMode ? vscode.l10n.t('Request a cited technical investigation using the configured model and approved tools.') : vscode.l10n.t('Chat, edit, run, or review. Fikeya retrieves bounded Qarinah evidence for each turn and asks before a tool runs.'))}</p><div class="prompt-suggestions"><button class="quiet" data-prompt-value="Explain this project and cite the files that matter." type="button">${escapeHtml(vscode.l10n.t('Explain this project'))}</button><button class="quiet" data-prompt-value="Inspect the current changes and identify the highest-risk issue." type="button">${escapeHtml(vscode.l10n.t('Review current changes'))}</button><button class="quiet" data-prompt-value="Run the relevant tests, diagnose any failure, and propose the smallest fix." type="button">${escapeHtml(vscode.l10n.t('Diagnose failing tests'))}</button></div></div>`
		: state.conversation.map(renderConversationMessage).join('');
	const progress = running
		? `<article class="chat-message assistant-message" aria-label="${escapeHtml(vscode.l10n.t('Fikeya is working'))}"><div class="message-meta"><strong>${escapeHtml(vscode.l10n.t('Fikeya'))}</strong><span class="thinking-dot" aria-hidden="true"></span><span>${escapeHtml(state.agent.progress ? formatRunProgress(state.agent.progress) : vscode.l10n.t('Starting a bounded run'))}</span></div></article>`
		: '';
	const outcome = state.agent.outcome ? renderCodingOutcome(state.agent.outcome, strings) : '';
	const chatPlan = state.plan.record ? renderChatPlanStrip(state.plan.record, state.plan.status === 'running') : '';
	const runDetails = state.agent.sessionId
		? `<details class="run-details"><summary>${escapeHtml(vscode.l10n.t('Inspect latest run'))}</summary><div class="run-details-body">${outcome}<dl class="receipt"><dt>${escapeHtml(strings.session)}</dt><dd><code>${escapeHtml(state.agent.sessionId)}</code></dd><dt>${escapeHtml(strings.call)}</dt><dd><code>${escapeHtml(state.agent.callId ?? strings.unavailable)}</code></dd><dt>${escapeHtml(strings.usageBasis)}</dt><dd>${escapeHtml(state.agent.usage?.measurement ?? strings.unavailable)}</dd><dt>${escapeHtml(strings.context)}</dt><dd>${escapeHtml(formatContextStatus(state.agent.memory, strings))}</dd>${state.agent.memory?.receiptId ? `<dt>${escapeHtml(strings.contextReceipt)}</dt><dd><code>${escapeHtml(state.agent.memory.receiptId)}</code></dd>` : ''}${state.agent.memory?.responseSha256 ? `<dt>${escapeHtml(strings.contextEvidence)}</dt><dd><code>${escapeHtml(state.agent.memory.responseSha256)}</code></dd>` : ''}</dl></div></details>`
		: '';
	return `<section class="card agent-surface" aria-labelledby="agent-run-title">
		<div class="agent-heading"><div><h2 id="agent-run-title">${escapeHtml(researchMode ? vscode.l10n.t('Research') : vscode.l10n.t('Chat'))}</h2><p>${escapeHtml(researchMode ? vscode.l10n.t('Cited investigation with the same project and permission boundary.') : vscode.l10n.t('A live conversation beside the editor. Chat is process-local unless workspace history is explicitly enabled in Fikeya settings.'))}</p></div><div class="agent-heading-actions"><button class="quiet" data-conversation-clear type="button"${interactionBlocked || state.conversation.length === 0 ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('New chat'))}</button><span class="badge">${escapeHtml(planOperationInProgress ? vscode.l10n.t('Plan active') : agentStatusLabel(state.agent, strings))}</span></div></div>
		${chatPlan}
		<div class="chat-thread" data-chat-thread aria-live="polite">${conversation}${progress}</div>
		<form class="agent-form" data-agent-form autocomplete="off">
			<label class="field composer"><span class="sr-only">${escapeHtml(strings.prompt)}</span><textarea name="prompt" maxlength="65536" placeholder="${escapeHtml(researchMode ? vscode.l10n.t('Research a technical question and ask for cited findings...') : vscode.l10n.t('Ask Fikeya to inspect, edit, run, or review this project...'))}"${controlsDisabled ? ' disabled' : ''} required></textarea></label>
			<div class="composer-bar"><label class="field inline-field"><span class="sr-only">${escapeHtml(strings.provider)}</span><select name="providerName" aria-label="${escapeHtml(strings.provider)}"${controlsDisabled ? ' disabled' : ''}>${providerOptions}</select></label><details class="run-controls"><summary>${escapeHtml(vscode.l10n.t('Model and context'))}</summary><div class="control-grid"><label class="field"><span>${escapeHtml(strings.contextMode)}</span><select name="memoryMode"${controlsDisabled ? ' disabled' : ''}><option value="${agentComposerDefaults.memoryMode}">${escapeHtml(strings.contextAuto)}</option><option value="required">${escapeHtml(strings.contextRequired)}</option><option value="off">${escapeHtml(strings.contextOff)}</option></select></label><label class="field"><span>${escapeHtml(strings.contextBudget)}</span><input name="contextMaxCharacters" type="number" min="${agentComposerConstraints.contextMaxCharacters.minimum}" max="${agentComposerConstraints.contextMaxCharacters.maximum}" step="${agentComposerConstraints.contextMaxCharacters.step}" value="${agentComposerDefaults.contextMaxCharacters}"${controlsDisabled ? ' disabled' : ''} required></label><label class="field"><span>${escapeHtml(strings.maximumOutputTokens)}</span><input name="maxOutputTokens" type="number" min="${agentComposerConstraints.maxOutputTokens.minimum}" max="${agentComposerConstraints.maxOutputTokens.maximum}" step="${agentComposerConstraints.maxOutputTokens.step}" value="${agentComposerDefaults.maxOutputTokens}"${controlsDisabled ? ' disabled' : ''} required></label></div></details><div class="actions composer-actions"><button data-agent-run type="submit"${controlsDisabled ? ' disabled' : ''}>${escapeHtml(researchMode ? vscode.l10n.t('Research') : vscode.l10n.t('Send'))}</button><button class="secondary" data-agent-plan type="button"${controlsDisabled ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Create plan'))}</button>${running ? `<button class="secondary" data-agent-cancel type="button">${escapeHtml(strings.cancel)}</button>` : ''}</div></div>
			<div class="composer-foot"><label class="consent"><input data-network-consent type="checkbox"${controlsDisabled ? ' disabled' : ''}><span>${escapeHtml(vscode.l10n.t('Allow provider network for this turn'))}</span></label><span>${escapeHtml(vscode.l10n.t('Enter to send, Shift+Enter for a new line'))}</span></div>
		</form>
		<div class="agent-status" data-tone="${statusTone}" role="status">${escapeHtml(state.providers.length === 0 ? vscode.l10n.t('Add a model in Fikeya Settings to begin.') : planOperationInProgress ? vscode.l10n.t('Chat is paused while the current plan executes or cancels.') : agentStatusLabel(state.agent, strings))}</div>
		${runDetails}
		${state.agent.sessionId ? `<div class="actions"><button class="secondary" data-receipts-refresh type="button"${state.agent.receiptsStatus === 'loading' ? ' disabled' : ''}>${escapeHtml(strings.refreshReceipts)}</button></div>` : ''}
	</section>`;
}

function renderChatPlanStrip(plan: FikeyaPlanRecord, operationRunning: boolean): string {
	const summary = buildChatPlanSummary(plan);
	const stepLabel = summary.stepKind === 'current'
		? vscode.l10n.t('Current step')
		: summary.stepKind === 'next'
			? vscode.l10n.t('Next step')
			: vscode.l10n.t('Last recorded step');
	const step = summary.step
		? `<div class="chat-plan-step"><span>${escapeHtml(stepLabel)}</span><strong>${escapeHtml(vscode.l10n.t('{0} of {1} · {2}', summary.step.order, summary.totalSteps, summary.step.title))}</strong><span>${escapeHtml(planStepStatusLabel(summary.step.status))}</span></div>`
		: `<div class="chat-plan-step"><span>${escapeHtml(stepLabel)}</span><strong>${escapeHtml(vscode.l10n.t('No recorded step'))}</strong></div>`;
	return `<aside class="chat-plan-strip" aria-label="${escapeHtml(vscode.l10n.t('Current plan'))}" aria-live="polite"><div class="chat-plan-copy"><span>${escapeHtml(vscode.l10n.t('Current plan'))}</span><strong title="${escapeHtml(summary.title)}">${escapeHtml(summary.title)}</strong><span class="chat-plan-status">${escapeHtml(operationRunning ? vscode.l10n.t('Running') : planStatusLabel(summary.status))}</span></div>${step}<button class="secondary" data-open-plan type="button">${escapeHtml(vscode.l10n.t('Open Plan'))}</button></aside>`;
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
