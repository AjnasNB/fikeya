/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createHash, randomBytes } from 'crypto';
import { basename, relative, resolve } from 'path';
import { FikeyaAgentProfile, FikeyaAgentProfileStore, FikeyaAgentRole } from './agentProfiles';
import { agentComposerConstraints, agentComposerDefaults, buildAgentProviderPrompt, FikeyaAgentMode, invokeAgentRunRequest } from './agentComposer';
import { listAzureOpenAIDeployments, listAzureOpenAIResources, listAzureSubscriptions } from './azureDiscovery';
import { appendConversationMessage, FikeyaConversationMessage, parseConversationState, projectProviderHistory, serializeConversationState } from './conversation';
import {
	canEnableDangerousLocalMode,
	createDangerousLocalModeGrant,
	dangerousLocalModeConfirmation,
	dangerousLocalModeDurationMs,
	dangerousLocalModeIsActive,
	DangerousLocalModeGrant
} from './dangerousLocalMode';
import {
	appendTextFilesToPrompt,
	FikeyaTextFileInput,
	isAllowedTextFileName,
	maximumTextFileBytes,
	maximumTextFileCount,
	maximumTotalTextFileBytes,
	parseTextFileInputs
} from './fileInputs';
import { escapeHtml, FikeyaAgentComposerMode, FikeyaComposerMode, parseWebviewMessage, runtimeModeForComposerMode } from './messageValidation';
import { FikeyaImageInput } from './imageInputs';
import { renderSafeMarkdown } from './markdown';
import { FikeyaHostCapabilities, resolveFikeyaHostCapabilities } from './hostCapabilities';
import { FikeyaMemorySnapshot, initializeQarinahMemory, loadQarinahMemory } from './memory';
import { FikeyaMultiAgentProgress, FikeyaMultiAgentRunHandle, startFikeyaMultiAgentRun } from './multiAgent';
import { captureCompletedFikeyaRun } from './sessionCapture';
import { buildChatPlanSummary, buildDurableProjectPresentation, buildRecordedPlanTimeline, fikeyaNarrowPanelMaximumWidth, FikeyaPlanStageId, isChatInteractionBlocked, selectInitialPlanStepId } from './surface';
import { buildTeamLeadPrompt } from './teamLead';
import {
	configureFikeyaProvider,
	cancelFikeyaProject,
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
	FikeyaProjectRunHandle,
	FikeyaProjectView,
	FikeyaProviderConfiguration,
	FikeyaProviderProfile,
	FikeyaProviderReceipt,
	FikeyaRuntimeResult,
	FikeyaRunProgress,
	FikeyaStatistics,
	loadFikeyaAgentReceipts,
	loadFikeyaPlan,
	loadFikeyaProject,
	loadFikeyaStatistics,
	listFikeyaProviders,
	removeFikeyaProvider,
	runFikeyaRuntime,
	startFikeyaAgentRun,
	startFikeyaPlanProposal,
	startFikeyaProject,
	startFikeyaPlan,
	testFikeyaProvider
} from './runtime';

export interface ProviderDefinition {
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
	readonly multiAgentProgress?: readonly {
		readonly agentId: string;
		readonly displayName: string;
		readonly status: FikeyaMultiAgentProgress['status'];
		readonly runtime?: FikeyaRunProgress;
	}[];
	readonly multiAgentMaxConcurrency?: number;
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

interface ProjectSurfaceState {
	readonly status: 'idle' | 'loading' | 'running' | 'ready' | 'unavailable';
	readonly view?: FikeyaProjectView;
	readonly providerName?: string;
	/** Process-local only. Recovered runs require the exact goal to be re-entered. */
	readonly goal?: string;
	readonly failure?: string;
}

type FikeyaWorkspaceMode = 'chat' | 'research' | 'plan' | 'context' | 'usage' | 'setup';

const droppedResourceDirectoryExclusions = new Set([
	'.git',
	'.fikeya',
	'.venv',
	'build',
	'coverage',
	'dist',
	'node_modules',
	'out'
]);

interface DashboardState {
	readonly activeMode: FikeyaWorkspaceMode;
	readonly conversation: readonly FikeyaConversationMessage[];
	readonly workspaceName: string;
	readonly providersStatus: 'not-loaded' | 'loading' | 'ready' | 'unavailable';
	readonly providers: readonly FikeyaProviderProfile[];
	readonly providerHealth: Readonly<Record<string, ProviderHealth>>;
	readonly agentProfiles: readonly FikeyaAgentProfile[];
	readonly agent: AgentSurfaceState;
	readonly memory: MemorySurfaceState;
	readonly statistics: StatisticsSurfaceState;
	readonly plan: PlanSurfaceState;
	readonly project: ProjectSurfaceState;
	readonly runtime: 'not-checked' | 'checking' | 'ready' | 'attention';
	readonly workspaceInitialized: boolean;
	readonly runtimeProviderCount?: number;
	readonly qarinah: string;
}

export function activate(context: vscode.ExtensionContext): void {
	const hostCapabilities = resolveFikeyaHostCapabilities(
		vscode.env.appName,
		vscode.env.uiKind === vscode.UIKind.Desktop
	);
	const provider = new FikeyaWebviewViewProvider(context, hostCapabilities);
	void vscode.commands.executeCommand('setContext', 'fikeya.isFikeyaProduct', hostCapabilities.isFikeyaProduct);
	void vscode.commands.executeCommand('setContext', 'fikeya.supportsDesktopWorkbench', hostCapabilities.supportsDesktopWorkbench);
	void vscode.commands.executeCommand('setContext', 'fikeya.dangerousLocalModeActive', false);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(FikeyaWebviewViewProvider.viewType, provider));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.open', () => provider.openDefaultLayout('chat')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.chat.toggle', () => provider.toggleChatPane()));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.layout.project', () => provider.openWorkspacePanel('chat')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.layout.editor', () => provider.openEditorLayout('chat')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.chat.attachFiles', async (resource?: vscode.Uri, selectedResources?: readonly vscode.Uri[]) => {
		await provider.attachExplorerFiles(resource, selectedResources);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.configureProvider', async () => {
		await provider.configureProvider();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.configureAgents', async () => {
		await provider.configureAgents();
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
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.dangerousLocalMode.enable', async () => {
		await provider.enableDangerousLocalMode();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.dangerousLocalMode.disable', () => {
		provider.disableDangerousLocalMode(true);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.editor', async () => {
		await provider.focusEditor();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.agent', () => provider.openDefaultLayout('chat')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.terminal', async () => {
		await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.review', async () => {
		await vscode.commands.executeCommand('workbench.view.scm');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.research', () => provider.openDefaultLayout('research')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.mode.lab', () => provider.openDefaultLayout('context')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.view.usage', () => provider.openDefaultLayout('usage')));
	context.subscriptions.push(vscode.commands.registerCommand('fikeya.view.setup', () => provider.openDefaultLayout('setup')));
	if (hostCapabilities.supportsDesktopWorkbench) {
		const chatStatus = vscode.window.createStatusBarItem('fikeya.chat.toggle', vscode.StatusBarAlignment.Right, 100);
		chatStatus.name = vscode.l10n.t('Fikeya Chat');
		chatStatus.text = '$(comment-discussion) Fikeya Chat';
		chatStatus.tooltip = hostCapabilities.isFikeyaProduct
			? vscode.l10n.t('Toggle Fikeya Chat on the right (Ctrl+L)')
			: vscode.l10n.t('Open Fikeya Chat on the right');
		chatStatus.command = 'fikeya.chat.toggle';
		chatStatus.show();
		context.subscriptions.push(chatStatus);
	}
	const firstExtensionOpenKey = 'fikeya.chat.firstExtensionOpen.v1';
	if (hostCapabilities.isFikeyaProduct) {
		const startupMode = vscode.workspace.getConfiguration('fikeya').get<string>('startupMode', 'project');
		if (startupMode === 'project') {
			void provider.openWorkspacePanel('chat');
		} else if (startupMode === 'editor') {
			void provider.openEditorLayout('chat');
		}
	} else {
		const openAtStartup = vscode.workspace.getConfiguration('fikeya.chat').get<boolean>('openAtStartup', true);
		if (openAtStartup && !context.globalState.get<boolean>(firstExtensionOpenKey, false)) {
			void provider.openEditorLayout('chat');
			void context.globalState.update(firstExtensionOpenKey, true);
		}
	}
}

class FikeyaWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'fikeya.dashboard';
	private static readonly panelViewType = 'fikeya.workspace';
	private static readonly currentPlanKey = 'fikeya.plan.current.v1';
	private static readonly previousPlanKey = 'fikeya.plan.previous.v1';
	private static readonly conversationKey = 'fikeya.chat.conversation.v1';
	private static readonly currentProjectKey = 'fikeya.project.current.v1';
	private view: vscode.WebviewView | undefined;
	private viewBinding: vscode.Disposable | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private panelBinding: vscode.Disposable | undefined;
	private state: DashboardState;
	private activeAgentRun: FikeyaAgentRunHandle | undefined;
	private activeMultiAgentRun: FikeyaMultiAgentRunHandle | undefined;
	private activePlanProposalRun: FikeyaPlanProposalRunHandle | undefined;
	private activePlanRun: FikeyaPlanRunHandle | undefined;
	private activeProjectRun: FikeyaProjectRunHandle | undefined;
	private activeProjectRunId: string | undefined;
	private planCancellationInProgress = false;
	private composerHasTransientAttachments = false;
	private lastAcceptedComposerRequestId: string | undefined;
	private pendingComposerFiles: readonly FikeyaTextFileInput[] = [];
	private workspaceInitialization: Thenable<boolean> | undefined;
	private qarinahWorkspaceInitialized = false;
	private previousConversation: readonly FikeyaConversationMessage[] | undefined;
	private projectPanelRequired = false;
	private disposed = false;
	private readonly agentProfileStore: FikeyaAgentProfileStore;
	private lastSourceDocument: vscode.Uri | undefined;
	private dangerousLocalModeGrant: DangerousLocalModeGrant | undefined;
	private dangerousLocalModeExpiryTimer: NodeJS.Timeout | undefined;

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly hostCapabilities: FikeyaHostCapabilities
	) {
		this.agentProfileStore = new FikeyaAgentProfileStore(context.workspaceState);
		this.lastSourceDocument = vscode.window.activeTextEditor?.document.uri;
		context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				this.lastSourceDocument = editor.document.uri;
			}
		}));
		const persistConversation = this.conversationPersistenceEnabled();
		this.state = {
			activeMode: 'chat',
			conversation: persistConversation
				? parseConversationState(context.workspaceState.get<string>(FikeyaWebviewViewProvider.conversationKey) ?? '')
				: [],
			workspaceName: getWorkspaceName(),
			providersStatus: 'not-loaded',
			providers: [],
			providerHealth: {},
			agentProfiles: this.agentProfileStore.load(),
			agent: { status: 'idle', receiptsStatus: 'idle', receipts: [] },
			memory: { status: 'not-loaded' },
			statistics: { status: 'not-loaded' },
			plan: { status: 'idle' },
			project: { status: 'idle' },
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

	public async enableDangerousLocalMode(): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.scheme === 'file');
		const workspacePath = folder?.uri.fsPath;
		const eligible = canEnableDangerousLocalMode({
			desktopUi: vscode.env.uiKind === vscode.UIKind.Desktop,
			remoteName: vscode.env.remoteName,
			trustedWorkspace: vscode.workspace.isTrusted,
			workspaceScheme: folder?.uri.scheme,
			workspacePath
		});
		if (!eligible || !workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Full Access is available only for one trusted local desktop workspace. It is disabled in web, remote, virtual, and untrusted windows.'));
			return;
		}

		const continueLabel = vscode.l10n.t('Continue');
		const selected = await vscode.window.showWarningMessage(
			vscode.l10n.t('Enable Full Access for 15 minutes?'),
			{
				modal: true,
				detail: vscode.l10n.t('Fikeya will approve its own workspace and process tool requests for this exact local folder until the timer expires. Path containment, secret redaction, output limits, network controls, receipts, and cancellation stay enforced. This grant is process-local and is never restored after restart.')
			},
			continueLabel
		);
		if (selected !== continueLabel) {
			return;
		}

		const phrase = dangerousLocalModeConfirmation(folder.name);
		const confirmation = await vscode.window.showInputBox({
			title: vscode.l10n.t('Confirm temporary Full Access'),
			prompt: vscode.l10n.t('Type exactly: {0}', phrase),
			placeHolder: phrase,
			ignoreFocusOut: true,
			validateInput: value => value === phrase ? undefined : vscode.l10n.t('The confirmation phrase must match exactly.')
		});
		if (confirmation !== phrase) {
			return;
		}

		this.dangerousLocalModeGrant = createDangerousLocalModeGrant(workspacePath);
		this.scheduleDangerousLocalModeExpiry();
		void vscode.commands.executeCommand('setContext', 'fikeya.dangerousLocalModeActive', true);
		this.refresh();
		void vscode.window.showWarningMessage(vscode.l10n.t('Fikeya Full Access is active for this folder for 15 minutes. Tool requests are still recorded with exact receipts.'));
	}

	public disableDangerousLocalMode(showMessage = false): void {
		if (this.dangerousLocalModeExpiryTimer) {
			clearTimeout(this.dangerousLocalModeExpiryTimer);
			this.dangerousLocalModeExpiryTimer = undefined;
		}
		const wasActive = this.dangerousLocalModeGrant !== undefined;
		this.dangerousLocalModeGrant = undefined;
		void vscode.commands.executeCommand('setContext', 'fikeya.dangerousLocalModeActive', false);
		if (!this.disposed) {
			this.refresh();
		}
		if (showMessage && wasActive) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Fikeya Full Access was disabled. Tool requests require approval again.'));
		}
	}

	private scheduleDangerousLocalModeExpiry(): void {
		if (this.dangerousLocalModeExpiryTimer) {
			clearTimeout(this.dangerousLocalModeExpiryTimer);
		}
		const grant = this.dangerousLocalModeGrant;
		if (!grant) {
			return;
		}
		this.dangerousLocalModeExpiryTimer = setTimeout(() => {
			this.disableDangerousLocalMode(false);
			void vscode.window.showInformationMessage(vscode.l10n.t('Fikeya Full Access expired. Tool requests require approval again.'));
		}, Math.max(1, Math.min(dangerousLocalModeDurationMs, grant.expiresAt - Date.now())));
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
			this.composerHasTransientAttachments = false;
			const binding = this.viewBinding;
			this.viewBinding = undefined;
			binding?.dispose();
		});
		this.viewBinding = vscode.Disposable.from(messageSubscription, disposeSubscription);
		this.initializeSurface(webviewView.webview);
	}

	public async focusEditor(): Promise<void> {
		const visibleEditor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
		if (visibleEditor) {
			this.lastSourceDocument = visibleEditor.document.uri;
			await vscode.window.showTextDocument(visibleEditor.document, {
				viewColumn: visibleEditor.viewColumn,
				preserveFocus: false,
				preview: false
			});
			return;
		}
		if (this.lastSourceDocument) {
			const document = await vscode.workspace.openTextDocument(this.lastSourceDocument);
			await vscode.window.showTextDocument(document, {
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: false,
				preview: false
			});
			return;
		}
		await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
	}

	public async openDefaultLayout(mode: FikeyaWorkspaceMode = 'chat'): Promise<void> {
		if (this.hostCapabilities.isFikeyaProduct) {
			await this.openWorkspacePanel(mode);
			return;
		}
		await this.openEditorLayout(mode);
	}

	public async openEditorLayout(mode: FikeyaWorkspaceMode = 'chat'): Promise<void> {
		this.projectPanelRequired = false;
		this.state = { ...this.state, activeMode: mode };
		const panel = this.panel;
		this.panel = undefined;
		this.panelBinding?.dispose();
		this.panelBinding = undefined;
		panel?.dispose();
		await vscode.commands.executeCommand('workbench.action.alignPanelCenter');
		await this.focusEditor();
		await vscode.commands.executeCommand(`${FikeyaWebviewViewProvider.viewType}.focus`);
		this.refresh();
	}

	public async openWorkspacePanel(mode: FikeyaWorkspaceMode = 'chat'): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.projectPanelRequired = true;
		this.state = { ...this.state, activeMode: mode };
		await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		if (this.panel) {
			this.refresh(this.panel.webview);
			this.panel.reveal(vscode.ViewColumn.Active, false);
			return;
		}

		this.panelBinding?.dispose();
		const viewColumn = this.hostCapabilities.isFikeyaProduct
			? vscode.ViewColumn.Active
			: vscode.ViewColumn.Beside;
		const panel = vscode.window.createWebviewPanel(
			FikeyaWebviewViewProvider.panelViewType,
			vscode.l10n.t('Fikeya Chat'),
			{ viewColumn, preserveFocus: false },
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
			this.composerHasTransientAttachments = false;
			const binding = this.panelBinding;
			this.panelBinding = undefined;
			binding?.dispose();
			if (this.projectPanelRequired && !this.disposed) {
				void Promise.resolve().then(() => {
					if (this.projectPanelRequired && !this.disposed && !this.panel) {
						return this.openWorkspacePanel(this.state.activeMode);
					}
					return undefined;
				});
			}
		});
		this.panelBinding = vscode.Disposable.from(messageSubscription, disposeSubscription);
		this.initializeSurface(panel.webview);
	}

	public async attachExplorerFiles(resource?: vscode.Uri, selectedResources?: readonly vscode.Uri[]): Promise<void> {
		const candidates = selectedResources?.length ? selectedResources : resource ? [resource] : [];
		if (candidates.length === 0) {
			await this.pickMentionFiles('workspace');
			return;
		}
		if (candidates.length > maximumTextFileCount) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Select no more than 10 files for one message.'));
			return;
		}
		const files = await this.readMentionFiles(candidates);
		if (files.length === 0) {
			return;
		}
		this.pendingComposerFiles = files;
		if (this.panel) {
			await this.deliverPendingComposerFiles(this.panel.webview);
			return;
		}
		if (this.hostCapabilities.isFikeyaProduct) {
			await this.openWorkspacePanel('chat');
			const workspacePanel = this.panel as vscode.WebviewPanel | undefined;
			if (workspacePanel) {
				await this.deliverPendingComposerFiles(workspacePanel.webview);
			}
			return;
		}
		await this.openEditorLayout('chat');
		if (this.view) {
			await this.deliverPendingComposerFiles(this.view.webview);
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.disableDangerousLocalMode(false);
		this.projectPanelRequired = false;
		this.activeAgentRun?.cancel();
		this.activeAgentRun = undefined;
		this.activeMultiAgentRun?.cancel();
		this.activeMultiAgentRun = undefined;
		this.activePlanProposalRun?.cancel();
		this.activePlanProposalRun = undefined;
		this.activePlanRun?.cancel();
		this.activePlanRun = undefined;
		this.activeProjectRun?.cancel();
		this.activeProjectRun = undefined;
		this.activeProjectRunId = undefined;
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
			void this.handleWebviewMessage(value, webview).catch(() => {
				void vscode.window.showErrorMessage(vscode.l10n.t('Fikeya could not process that action. Try again or run doctor.'));
			});
		});
	}

	private acceptComposerRequest(requestId?: string): void {
		this.composerHasTransientAttachments = false;
		this.lastAcceptedComposerRequestId = requestId;
	}

	private async rejectComposerRequest(webview: vscode.Webview, requestId: string | undefined, message: string): Promise<void> {
		if (!requestId) {
			return;
		}
		await webview.postMessage({ type: 'fikeya.composerRequestRejected', requestId, message });
	}

	private async deliverPendingComposerFiles(webview: vscode.Webview): Promise<void> {
		if (this.pendingComposerFiles.length === 0) {
			return;
		}
		const files = this.pendingComposerFiles;
		this.pendingComposerFiles = [];
		await webview.postMessage({ type: 'fikeya.composerFilesPicked', files });
	}

	private async attachDroppedResources(resourceUris: readonly string[], target: vscode.Webview): Promise<void> {
		const candidates: vscode.Uri[] = [];
		const visitedDirectories = new Set<string>();
		for (const rawResourceUri of resourceUris) {
			if (candidates.length >= maximumTextFileCount) {
				break;
			}
			try {
				const resource = vscode.Uri.parse(rawResourceUri, true).with({ query: '', fragment: '' });
				if (resource.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(resource)) {
					continue;
				}
				await this.collectDroppedWorkspaceFiles(resource, candidates, visitedDirectories);
			} catch {
				// Untrusted drag payloads are ignored. Only canonical local workspace URIs are read.
			}
		}
		const files = await this.readMentionFiles(candidates);
		if (files.length === 0) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No supported workspace text or code files were found in that drop.'));
			return;
		}
		await target.postMessage({ type: 'fikeya.composerFilesPicked', files });
	}

	private async collectDroppedWorkspaceFiles(
		resource: vscode.Uri,
		results: vscode.Uri[],
		visitedDirectories: Set<string>
	): Promise<void> {
		if (results.length >= maximumTextFileCount || !vscode.workspace.getWorkspaceFolder(resource)) {
			return;
		}
		const stat = await vscode.workspace.fs.stat(resource);
		if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
			return;
		}
		if ((stat.type & vscode.FileType.File) !== 0) {
			if (isAllowedTextFileName(basename(resource.fsPath))) {
				results.push(resource);
			}
			return;
		}
		if ((stat.type & vscode.FileType.Directory) === 0
			|| droppedResourceDirectoryExclusions.has(basename(resource.fsPath).toLowerCase())
			|| visitedDirectories.size >= 128) {
			return;
		}
		const directoryKey = resource.toString();
		if (visitedDirectories.has(directoryKey)) {
			return;
		}
		visitedDirectories.add(directoryKey);
		const entries = await vscode.workspace.fs.readDirectory(resource);
		entries.sort(([left], [right]) => left.localeCompare(right));
		for (const [name, type] of entries) {
			if (results.length >= maximumTextFileCount) {
				break;
			}
			if ((type & vscode.FileType.SymbolicLink) !== 0
				|| ((type & vscode.FileType.Directory) !== 0 && droppedResourceDirectoryExclusions.has(name.toLowerCase()))) {
				continue;
			}
			await this.collectDroppedWorkspaceFiles(vscode.Uri.joinPath(resource, name), results, visitedDirectories);
		}
	}

	private async pickMentionFiles(source: 'workspace' | 'computer', target?: vscode.Webview): Promise<void> {
		let uris: readonly vscode.Uri[] | undefined;
		if (source === 'workspace') {
			const workspaceFiles = (await vscode.workspace.findFiles(
				'**/*',
				'**/{.git,.fikeya,.venv,node_modules,dist,build,out,coverage}/**',
				1_000
			)).filter(uri => uri.scheme === 'file' && isAllowedTextFileName(basename(uri.fsPath)));
			const picked = await vscode.window.showQuickPick(
				workspaceFiles.map(uri => ({
					label: vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/'),
					description: vscode.workspace.getWorkspaceFolder(uri)?.name,
					uri
				})),
				{
					canPickMany: true,
					matchOnDescription: true,
					placeHolder: vscode.l10n.t('Mention up to 10 workspace files'),
					title: vscode.l10n.t('Add workspace files to this message')
				}
			);
			uris = picked?.map(item => item.uri);
		} else {
			uris = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
				filters: { [vscode.l10n.t('Text and code files')]: ['txt', 'md', 'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'cs', 'cpp', 'c', 'h', 'html', 'css', 'scss', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sql', 'sh', 'ps1'] },
				openLabel: vscode.l10n.t('Mention files'),
				title: vscode.l10n.t('Add files from this computer')
			});
		}
		if (!uris || uris.length === 0) {
			return;
		}
		if (uris.length > maximumTextFileCount) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Select no more than 10 files for one message.'));
			return;
		}
		const files = await this.readMentionFiles(uris);
		if (files.length === 0) {
			return;
		}
		if (target) {
			await target.postMessage({ type: 'fikeya.composerFilesPicked', files });
			return;
		}
		this.pendingComposerFiles = files;
		await this.openEditorLayout('chat');
	}

	private async readMentionFiles(uris: readonly vscode.Uri[]): Promise<readonly FikeyaTextFileInput[]> {
		const inputs: FikeyaTextFileInput[] = [];
		let totalBytes = 0;
		for (const uri of uris) {
			if (uri.scheme !== 'file' || inputs.length >= maximumTextFileCount) {
				continue;
			}
			const name = basename(uri.fsPath);
			if (!isAllowedTextFileName(name)) {
				void vscode.window.showWarningMessage(vscode.l10n.t('{0} was skipped because only supported text/code files can be mentioned. Credential and key files are blocked.', name));
				continue;
			}
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				if ((stat.type & vscode.FileType.File) === 0 || stat.size < 1 || stat.size > maximumTextFileBytes || totalBytes + stat.size > maximumTotalTextFileBytes) {
					void vscode.window.showWarningMessage(vscode.l10n.t('{0} was skipped because mentioned text files are limited to 96 KB each and 384 KB total.', name));
					continue;
				}
				const bytes = await vscode.workspace.fs.readFile(uri);
				const text = Buffer.from(bytes).toString('utf8');
				if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
					void vscode.window.showWarningMessage(vscode.l10n.t('{0} was skipped because it is not canonical UTF-8 text.', name));
					continue;
				}
				const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
				const relativePath = workspaceFolder
					? relative(workspaceFolder.uri.fsPath, uri.fsPath).replaceAll('\\', '/')
					: `external/${createHash('sha256').update(uri.fsPath).digest('hex').slice(0, 8)}/${name}`;
				inputs.push({ name, relativePath, mimeType: 'text/plain', text, sizeBytes: bytes.byteLength });
				totalBytes += bytes.byteLength;
			} catch {
				void vscode.window.showWarningMessage(vscode.l10n.t('{0} could not be read and was not attached.', name));
			}
		}
		const parsed = parseTextFileInputs(inputs);
		if (!parsed) {
			void vscode.window.showErrorMessage(vscode.l10n.t('The selected file set did not pass Fikeya attachment validation.'));
			return [];
		}
		return parsed;
	}

	private initializeSurface(webview?: vscode.Webview): void {
		this.refresh(webview);
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
		if (this.state.project.status === 'idle' && this.currentProjectId()) {
			void this.refreshProject(false);
		}
	}

	private async handleWebviewMessage(value: unknown, source: vscode.Webview): Promise<void> {
		const message = parseWebviewMessage(value);
		if (!message) {
			return;
		}

		switch (message.type) {
			case 'webviewReady':
				await this.deliverPendingComposerFiles(source);
				break;
			case 'pickMentionFiles':
				await this.pickMentionFiles(message.source, source);
				break;
			case 'attachDroppedResources':
				await this.attachDroppedResources(message.resourceUris, source);
				break;
			case 'openCommand':
				await vscode.commands.executeCommand(message.command);
				break;
			case 'refreshProviders':
				await this.refreshProviders(true);
				break;
			case 'configureProviderProfile':
				await this.configureProviderProfile(message.providerId, message.profileLabel, message.baseUrl, message.model, message.secret);
				break;
			case 'setComposerAttachmentState':
				this.composerHasTransientAttachments = message.hasAttachments;
				break;
			case 'testProvider':
				await this.testProvider(message.providerName);
				break;
			case 'removeProvider':
				await this.removeProvider(message.providerName);
				break;
			case 'runAgent': {
				let accepted = false;
				await invokeAgentRunRequest(message, async (providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, mode, images, files) => {
					await this.runAgent(providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, mode, message.composerMode, images, files, new Set(), projectProviderHistory(this.state.conversation), () => {
						accepted = true;
						this.acceptComposerRequest(message.requestId);
					});
				});
				if (!accepted) {
					await this.rejectComposerRequest(source, message.requestId, vscode.l10n.t('Fikeya could not start this run. Check the selected model, workspace, and active tasks.'));
				}
				break;
			}
			case 'runMultiAgent': {
				let accepted = false;
				await this.runMultiAgent(message.selectedAgentIds, message.leadProviderName, message.prompt, message.composerMode, message.maxConcurrency, message.maxOutputTokens, message.contextMaxCharacters, message.memoryMode, () => {
					accepted = true;
					this.acceptComposerRequest(message.requestId);
				});
				if (!accepted) {
					await this.rejectComposerRequest(source, message.requestId, vscode.l10n.t('Fikeya could not start the parallel run. Review the selected agents and active tasks.'));
				}
				break;
			}
			case 'proposePlan': {
				let accepted = false;
				await this.proposePlan(message.providerName, message.prompt, message.maxOutputTokens, message.contextMaxCharacters, message.memoryMode, message.images, message.files, () => {
					accepted = true;
					this.acceptComposerRequest(message.requestId);
				});
				if (!accepted) {
					await this.rejectComposerRequest(source, message.requestId, vscode.l10n.t('Fikeya could not start the plan proposal. Check the selected model and active tasks.'));
				}
				break;
			}
			case 'startProject': {
				let accepted = false;
				await this.startProject(message.providerName, message.goal, () => {
					accepted = true;
					this.acceptComposerRequest(message.requestId);
				});
				if (!accepted) {
					await this.rejectComposerRequest(source, message.requestId, vscode.l10n.t('Fikeya could not start the project. Resolve the current project or provider state and try again.'));
				}
				break;
			}
			case 'projectAction':
				await this.runProjectAction(message.action, message.goal, message.providerName);
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
			case 'restorePlan':
				await this.restorePreviousPlan();
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
					planRunning: this.activePlanRun !== undefined || this.activeProjectRun !== undefined,
					planCancellationInProgress: this.planCancellationInProgress
				})) {
					const confirmation = vscode.l10n.t('Start New Chat');
					const accepted = await vscode.window.showWarningMessage(
						vscode.l10n.t('Start a new chat? The current conversation can be restored until this Fikeya window closes.'),
						{ modal: true },
						confirmation
					);
					if (accepted !== confirmation) {
						break;
					}
					this.previousConversation = this.state.conversation;
					this.state = { ...this.state, conversation: [] };
					await this.persistConversation();
					this.refresh();
				}
				break;
			case 'restoreConversation':
				if (this.state.conversation.length === 0 && this.previousConversation) {
					this.state = { ...this.state, conversation: this.previousConversation };
					this.previousConversation = undefined;
					await this.persistConversation();
					this.refresh();
				}
				break;
			case 'copyConversationMessage': {
				const conversationMessage = this.state.conversation.find(candidate => candidate.id === message.messageId);
				if (conversationMessage) {
					await vscode.env.clipboard.writeText(conversationMessage.content);
				}
				break;
			}
			case 'copyText':
				await vscode.env.clipboard.writeText(message.text);
				break;
			case 'openFile':
				await this.openProjectFile(message.path);
				break;
			case 'openExternal':
				await vscode.env.openExternal(vscode.Uri.parse(message.url, true));
				break;
			case 'reviewDiff': {
				const document = await vscode.workspace.openTextDocument({ content: message.content, language: 'diff' });
				await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
				break;
			}
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

	public async configureAgents(): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open a trusted local folder before configuring agents.'));
			return;
		}
		if (this.state.providers.length === 0) {
			await this.refreshProviders(false);
		}
		if (this.state.providers.length === 0) {
			const addModel = vscode.l10n.t('Add Model');
			const selected = await vscode.window.showInformationMessage(
				vscode.l10n.t('Configure at least one model before creating an agent profile.'),
				addModel
			);
			if (selected === addModel) {
				await this.configureProvider();
			}
			return;
		}

		const add = vscode.l10n.t('Add advisory agent');
		const edit = vscode.l10n.t('Edit advisory agent');
		const remove = vscode.l10n.t('Remove advisory agent');
		const action = await vscode.window.showQuickPick([
			{ label: add, action: 'add' as const },
			...(this.state.agentProfiles.length > 0 ? [
				{ label: edit, action: 'edit' as const },
				{ label: remove, action: 'remove' as const }
			] : [])
		], {
			title: vscode.l10n.t('Fikeya parallel agents'),
			placeHolder: vscode.l10n.t('Parallel agents are limited to planning, research, and review until isolated write worktrees are enabled.')
		});
		if (!action) {
			return;
		}
		if (action.action === 'remove') {
			const target = await vscode.window.showQuickPick(this.state.agentProfiles.map(profile => ({
				label: profile.displayName,
				description: `${profile.role} · ${profile.providerName}`,
				profile
			})), { title: remove });
			if (!target) {
				return;
			}
			this.state = { ...this.state, agentProfiles: await this.agentProfileStore.remove(target.profile.id) };
			this.refresh();
			return;
		}

		const existing = action.action === 'edit'
			? (await vscode.window.showQuickPick(this.state.agentProfiles.map(profile => ({
				label: profile.displayName,
				description: `${profile.role} · ${profile.providerName}`,
				profile
			})), { title: edit }))?.profile
			: undefined;
		if (action.action === 'edit' && !existing) {
			return;
		}
		const displayName = await vscode.window.showInputBox({
			title: vscode.l10n.t('Agent name'),
			prompt: vscode.l10n.t('Use a short role name such as Security reviewer or Test researcher.'),
			value: existing?.displayName ?? '',
			validateInput: value => value.trim().length > 0 && value.trim().length <= 80 ? undefined : vscode.l10n.t('Enter 1 to 80 characters.')
		});
		if (!displayName) {
			return;
		}
		const role = await vscode.window.showQuickPick((['planner', 'researcher', 'reviewer'] as const).map(value => ({
			label: value[0].toUpperCase() + value.slice(1),
			role: value satisfies FikeyaAgentRole,
			picked: existing?.role === value
		})), {
			title: vscode.l10n.t('Agent role'),
			placeHolder: vscode.l10n.t('Advisory roles may run safely in parallel against the same checkout.')
		});
		if (!role) {
			return;
		}
		const provider = await vscode.window.showQuickPick(this.state.providers.map(profile => ({
			label: profile.name,
			description: `${profile.kind} · ${profile.model}`,
			profile,
			picked: existing?.providerName === profile.name
		})), { title: vscode.l10n.t('Agent model') });
		if (!provider) {
			return;
		}
		const instruction = await vscode.window.showInputBox({
			title: vscode.l10n.t('Agent instruction'),
			prompt: vscode.l10n.t('Describe the independent perspective this agent should return. It cannot contain credentials.'),
			value: existing?.instruction ?? '',
			validateInput: value => value.trim().length <= 8_192 ? undefined : vscode.l10n.t('Keep the instruction below 8,192 characters.')
		});
		if (instruction === undefined) {
			return;
		}
		const profile: FikeyaAgentProfile = {
			schemaVersion: 1,
			id: existing?.id ?? `agent-${randomBytes(8).toString('hex')}`,
			displayName: displayName.trim(),
			providerName: provider.profile.name,
			role: role.role,
			instruction: instruction.trim(),
			maxOutputTokens: existing?.maxOutputTokens ?? agentComposerDefaults.maxOutputTokens,
			contextMaxCharacters: existing?.contextMaxCharacters ?? agentComposerDefaults.contextMaxCharacters,
			memoryMode: existing?.memoryMode ?? agentComposerDefaults.memoryMode
		};
		this.state = { ...this.state, agentProfiles: await this.agentProfileStore.upsert(profile) };
		this.refresh();
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
		let discoveredBaseUrl: string | undefined;
		let discoveredModel: string | undefined;
		let discoveredLabel: string | undefined;
		if (provider.definition.id === 'azure-openai') {
			const discovery = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('Discover from Azure CLI'), description: vscode.l10n.t('Recommended - choose a signed-in subscription, Azure OpenAI resource, and deployment.'), discover: true },
				{ label: vscode.l10n.t('Enter endpoint manually'), description: vscode.l10n.t('Use this when Azure CLI is unavailable.'), discover: false }
			], { placeHolder: vscode.l10n.t('How should Fikeya configure Azure?') });
			if (!discovery) {
				return;
			}
			if (discovery.discover) {
				try {
					const selected = await discoverAzureOpenAIConfiguration();
					if (!selected) {
						return;
					}
					discoveredBaseUrl = selected.endpoint;
					discoveredModel = selected.deployment;
					discoveredLabel = selected.label;
				} catch (error) {
					void vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Azure discovery failed.'));
					return;
				}
			}
		}

		const profileLabel = await vscode.window.showInputBox({
			title: vscode.l10n.t('Configure {0}', provider.definition.label),
			prompt: vscode.l10n.t('Profile Name'),
			value: discoveredLabel ?? provider.definition.label,
			ignoreFocusOut: true,
			validateInput: value => value.trim().length > 0 && value.trim().length <= 80 ? undefined : vscode.l10n.t('Enter a name with 1 to 80 characters.')
		});
		if (!profileLabel) {
			return;
		}

		const baseUrl = await vscode.window.showInputBox({
			title: vscode.l10n.t('Configure {0}', provider.definition.label),
			prompt: vscode.l10n.t('Endpoint URL'),
			value: discoveredBaseUrl ?? provider.definition.defaultBaseUrl,
			ignoreFocusOut: true,
			validateInput: value => validateProviderUrl(value, true)
		});
		if (baseUrl === undefined) {
			return;
		}

		const model = await vscode.window.showInputBox({
			title: vscode.l10n.t('Configure {0}', provider.definition.label),
			prompt: vscode.l10n.t('Model or Deployment Name'),
			value: discoveredModel,
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
		await this.context.globalState.update('fikeya.desktop.onboarding.completed.v3', true);
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} was configured in Fikeya Runtime.', profileLabel.trim()));
	}

	private async configureProviderProfile(providerId: string, profileLabel: string, baseUrl: string, model: string, suppliedSecret?: string): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const definition = getProviderDefinitions().find(candidate => candidate.id === providerId);
		if (!workspacePath || !definition) {
			return;
		}
		const urlFailure = validateProviderUrl(baseUrl, true);
		if (urlFailure) {
			void vscode.window.showErrorMessage(urlFailure);
			return;
		}
		if (definition.secretPrompt && !suppliedSecret) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Enter the credential for {0}.', definition.label));
			return;
		}
		if (!definition.secretPrompt && suppliedSecret !== undefined) {
			return;
		}

		const configuration: FikeyaProviderConfiguration = {
			name: createProviderName(definition.id, profileLabel),
			kind: definition.runtimeKind,
			model,
			baseUrl,
			credentialType: definition.credentialType
		};
		let secret = suppliedSecret;
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Adding {0}', definition.label) },
			() => configureFikeyaProvider(configuration, workspacePath, secret)
		);
		secret = undefined;
		if (!result.ok) {
			void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
			return;
		}
		await this.context.globalState.update('fikeya.desktop.onboarding.completed.v3', true);
		await this.refreshProviders(false);
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} is ready.', profileLabel));
	}

	public async runRuntimeCommand(command: 'doctor' | 'init'): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open a trusted local folder before running Fikeya.'));
			return;
		}

		if (command === 'init') {
			await this.ensureWorkspaceInitialized(workspacePath, true);
			return;
		}

		this.state = { ...this.state, runtime: 'checking' };
		this.refresh();
		const title = command === 'doctor' ? vscode.l10n.t('Running Fikeya Doctor') : vscode.l10n.t('Initializing Fikeya Workspace');
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => runFikeyaRuntime(command, workspacePath));
		this.applyRuntimeResult(result, command);
		if (result.ok) {
			await this.refreshMemory(false);
		}
	}

	private async ensureWorkspaceInitialized(workspacePath: string, announce: boolean): Promise<boolean> {
		if (this.state.workspaceInitialized && this.qarinahWorkspaceInitialized) {
			return true;
		}
		if (this.workspaceInitialization) {
			return this.workspaceInitialization;
		}

		this.state = { ...this.state, runtime: 'checking' };
		const initialization = vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: announce
					? vscode.l10n.t('Initializing Fikeya Workspace')
					: vscode.l10n.t('Preparing this workspace for Fikeya')
			},
			async () => {
				const result = this.state.workspaceInitialized
					? { ok: true, failure: 'none' as const, report: undefined }
					: await runFikeyaRuntime('init', workspacePath);
				if (!result.ok) {
					this.state = { ...this.state, runtime: 'attention', workspaceInitialized: false };
					this.refresh();
					void vscode.window.showErrorMessage(runtimeFailureMessage(result.failure));
					return false;
				}

				const memoryInitialization = await initializeQarinahMemory(this.context.extensionPath, workspacePath);
				this.qarinahWorkspaceInitialized = memoryInitialization.ok;
				this.state = {
					...this.state,
					runtime: 'ready',
					workspaceInitialized: result.report?.initialized ?? true,
					runtimeProviderCount: result.report?.providerCount ?? this.state.runtimeProviderCount,
					qarinah: memoryInitialization.ok
						? vscode.l10n.t('Ready')
						: result.report?.qarinah ?? this.state.qarinah
				};
				if (!memoryInitialization.ok) {
					void vscode.window.showWarningMessage(vscode.l10n.t('Fikeya is ready, but Qarinah memory could not be initialized. Run Fikeya: Initialize Workspace to retry.'));
				}
				if (announce) {
					this.refresh();
					void vscode.window.showInformationMessage(vscode.l10n.t('Fikeya workspace initialized.'));
					await this.refreshMemory(false);
				}
				return true;
			}
		);
		this.workspaceInitialization = initialization;
		try {
			return await initialization;
		} finally {
			if (this.workspaceInitialization === initialization) {
				this.workspaceInitialization = undefined;
			}
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
		runtimeMode: FikeyaAgentMode = 'agent',
		composerMode: FikeyaAgentComposerMode = runtimeMode === 'research' ? 'research' : 'build',
		images: readonly FikeyaImageInput[] = [],
		files: readonly FikeyaTextFileInput[] = [],
		attemptedProviderNames: ReadonlySet<string> = new Set(),
		providerHistory = projectProviderHistory(this.state.conversation),
		onAccepted?: () => void
	): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const profile = this.state.providers.find(provider => provider.name === providerName);
		const chatBlocked = isChatInteractionBlocked({
			agentRunning: this.activeAgentRun !== undefined || this.activeMultiAgentRun !== undefined,
			planRunning: this.activePlanRun !== undefined || this.activeProjectRun !== undefined,
			planCancellationInProgress: this.planCancellationInProgress
		});
		if (!workspacePath || chatBlocked || this.activePlanProposalRun || !profile) {
			return;
		}
		if (!await this.ensureWorkspaceInitialized(workspacePath, false)) {
			return;
		}
		if (!await this.saveWorkspaceEditsBeforeAgentRun(workspacePath)) {
			return;
		}

		const conversation = attemptedProviderNames.size === 0
			? appendConversationMessage(this.state.conversation, createConversationMessage('user', prompt, undefined, 'normal', images, files))
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
		onAccepted?.();
		this.refresh();
		const operation = startFikeyaAgentRun(
			providerName,
			appendTextFilesToPrompt(buildAgentProviderPrompt(runtimeMode, buildComposerModeProviderPrompt(composerMode, prompt)), files),
			maxOutputTokens,
			contextMaxCharacters,
			memoryMode,
			workspacePath,
			request => this.approveAgentTool(request),
			providerHistory,
			images,
			composerMode
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
				await this.offerProviderHandoff(prompt, maxOutputTokens, contextMaxCharacters, memoryMode, runtimeMode, composerMode, images, files, attempted, providerHistory);
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

	private async saveWorkspaceEditsBeforeAgentRun(workspacePath: string): Promise<boolean> {
		const autoSave = vscode.workspace.getConfiguration('fikeya.agent').get<boolean>('autoSaveWorkspaceEdits', true);
		if (!autoSave) {
			return true;
		}
		const root = resolve(workspacePath);
		const dirtyDocuments = vscode.workspace.textDocuments.filter(document => {
			if (!document.isDirty || document.isUntitled || document.uri.scheme !== 'file') {
				return false;
			}
			const pathFromRoot = relative(root, resolve(document.uri.fsPath));
			return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !pathFromRoot.includes(':'));
		});
		for (const document of dirtyDocuments) {
			if (!await document.save()) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Fikeya could not save {0}. Save or discard the editor changes before running the agent.', document.uri.fsPath));
				return false;
			}
		}
		return true;
	}

	private async runMultiAgent(
		selectedAgentIds: readonly string[],
		leadProviderName: string,
		prompt: string,
		composerMode: FikeyaAgentComposerMode,
		maxConcurrency: number,
		maxOutputTokens: number,
		contextMaxCharacters: number,
		memoryMode: FikeyaMemoryMode,
		onAccepted?: () => void
	): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const selectedProfiles = this.state.agentProfiles.filter(profile => selectedAgentIds.includes(profile.id));
		const leadProfile = this.state.providers.find(provider => provider.name === leadProviderName);
		const advisoryRoles = new Set<FikeyaAgentRole>(['planner', 'researcher', 'reviewer']);
		if (!workspacePath
			|| this.activeAgentRun
			|| this.activeMultiAgentRun
			|| this.activePlanProposalRun
			|| this.activePlanRun
			|| this.activeProjectRun
			|| this.planCancellationInProgress
			|| !leadProfile
			|| selectedProfiles.length !== selectedAgentIds.length
			|| selectedProfiles.some(profile => !advisoryRoles.has(profile.role))) {
			return;
		}
		if (!await this.ensureWorkspaceInitialized(workspacePath, false)) {
			return;
		}
		if (!await this.saveWorkspaceEditsBeforeAgentRun(workspacePath)) {
			return;
		}

		const history = projectProviderHistory(this.state.conversation);
		this.state = {
			...this.state,
			conversation: appendConversationMessage(this.state.conversation, createConversationMessage('user', prompt)),
			agent: {
				status: 'running',
				providerName: vscode.l10n.t('{0} specialists → {1}', selectedProfiles.length, leadProviderName),
				receiptsStatus: 'idle',
				receipts: [],
				multiAgentProgress: selectedProfiles.map(profile => ({
					agentId: profile.id,
					displayName: profile.displayName,
					status: 'queued'
				})),
				multiAgentMaxConcurrency: Math.min(maxConcurrency, selectedProfiles.length)
			}
		};
		await this.persistConversation();
		onAccepted?.();
		this.refresh();

		const operation = startFikeyaMultiAgentRun({
			selectedAgentIds,
			prompt: buildComposerModeProviderPrompt(composerMode, prompt),
			history,
			maxConcurrency,
			allowNetwork: true
		}, this.state.agentProfiles, workspacePath, (_profile, request) => this.approveAgentTool(request));
		this.activeMultiAgentRun = operation;
		const disposeProgress = operation.onProgress(progress => {
			if (this.activeMultiAgentRun !== operation) {
				return;
			}
			this.state = {
				...this.state,
				agent: {
					...this.state.agent,
					progress: progress.runtime ?? this.state.agent.progress,
					multiAgentProgress: this.state.agent.multiAgentProgress?.map(item => item.agentId === progress.agentId
						? { ...item, status: progress.status, runtime: progress.runtime }
						: item)
				}
			};
			this.refresh();
		});
		const result = await operation.result.finally(disposeProgress);
		if (this.activeMultiAgentRun !== operation) {
			return;
		}
		this.activeMultiAgentRun = undefined;

		let conversation = this.state.conversation;
		for (const item of result.agents) {
			const label = `${item.profile.displayName} · ${item.profile.providerName}`;
			if (item.runtime.ok && item.runtime.value) {
				const provider = this.state.providers.find(candidate => candidate.name === item.profile.providerName);
				if (provider && item.status === 'completed') {
					await captureCompletedFikeyaRun({
						extensionPath: this.context.extensionPath,
						workspacePath,
						prompt,
						profile: provider,
						turn: item.runtime.value,
						receipts: item.receipts
					});
				}
			} else {
				conversation = appendConversationMessage(conversation, createConversationMessage(
					'notice',
					item.status === 'cancelled'
						? vscode.l10n.t('{0} was cancelled before returning an answer.', item.profile.displayName)
						: vscode.l10n.t('{0} could not complete this advisory run.', item.profile.displayName),
					label,
					item.status === 'cancelled' ? 'normal' : 'error'
				));
			}
		}
		this.state = {
			...this.state,
			conversation,
			agent: {
				status: result.status === 'cancelled' ? 'cancelled' : result.status === 'failed' ? 'failed' : 'completed',
				providerName: vscode.l10n.t('{0} specialists → {1}', selectedProfiles.length, leadProviderName),
				receiptsStatus: 'ready',
				receipts: result.agents.flatMap(item => item.receipts),
				failure: result.status === 'partial' ? vscode.l10n.t('Some advisory agents did not complete. Their available evidence and receipts were retained for one lead answer.') : undefined
			}
		};
		await this.persistConversation();
		this.refresh();
		await this.refreshStatistics(false);
		await this.refreshMemory(false);

		const completedAdvisors = result.agents.filter(item => item.status === 'completed' && item.runtime.ok && item.runtime.value);
		if (result.status === 'cancelled' || completedAdvisors.length === 0) {
			return;
		}
		const leadPrompt = buildTeamLeadPrompt(prompt, completedAdvisors.map(item => ({
			name: item.profile.displayName,
			role: item.profile.role,
			output: item.runtime.value?.output ?? ''
		})));
		await this.runAgent(
			leadProviderName,
			leadPrompt,
			maxOutputTokens,
			contextMaxCharacters,
			memoryMode,
			runtimeModeForComposerMode(composerMode),
			composerMode,
			[],
			[],
			new Set(['fikeya-team']),
			history
		);
	}

	private async proposePlan(
		providerName: string,
		prompt: string,
		maxOutputTokens: number,
		contextMaxCharacters: number,
		memoryMode: FikeyaMemoryMode,
		images: readonly FikeyaImageInput[] = [],
		files: readonly FikeyaTextFileInput[] = [],
		onAccepted?: () => void
	): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const profile = this.state.providers.find(provider => provider.name === providerName);
		if (!workspacePath || this.activeAgentRun || this.activeMultiAgentRun || this.activePlanProposalRun || this.activePlanRun || this.activeProjectRun || this.planCancellationInProgress || !profile) {
			return;
		}
		if (!await this.ensureWorkspaceInitialized(workspacePath, false)) {
			return;
		}

		const providerHistory = projectProviderHistory(this.state.conversation);
		this.state = {
			...this.state,
			conversation: appendConversationMessage(this.state.conversation, createConversationMessage('user', prompt, undefined, 'normal', images, files)),
			agent: {
				status: 'running',
				providerName,
				receiptsStatus: 'idle',
				receipts: []
			}
		};
		await this.persistConversation();
		onAccepted?.();
		this.refresh();
		const operation = startFikeyaPlanProposal(
			providerName,
			appendTextFilesToPrompt(prompt, files),
			maxOutputTokens,
			contextMaxCharacters,
			memoryMode,
			workspacePath,
			providerHistory,
			images
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
			activeMode: 'chat',
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
		runtimeMode: FikeyaAgentMode,
		composerMode: FikeyaAgentComposerMode,
		images: readonly FikeyaImageInput[],
		files: readonly FikeyaTextFileInput[],
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
		await this.runAgent(target.name, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, runtimeMode, composerMode, images, files, attemptedProviderNames, providerHistory);
	}

	public async toggleChatPane(): Promise<void> {
		if (!this.panel && this.view?.visible) {
			await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
			await this.focusEditor();
			return;
		}
		await this.openEditorLayout('chat');
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

	private async openProjectFile(relativePath: string): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open a trusted local folder before opening a cited file.'));
			return;
		}
		const root = vscode.Uri.file(workspacePath);
		const target = vscode.Uri.joinPath(root, ...relativePath.split('/'));
		try {
			const document = await vscode.workspace.openTextDocument(target);
			await vscode.window.showTextDocument(document, { preview: true });
		} catch {
			void vscode.window.showErrorMessage(vscode.l10n.t('Fikeya could not open {0} inside this workspace.', relativePath));
		}
	}

	private conversationPersistenceEnabled(): boolean {
		return vscode.workspace.getConfiguration('fikeya').get<boolean>('chat.persistWorkspaceHistory', false);
	}

	private async approveAgentTool(request: FikeyaAgentApproval): Promise<FikeyaAgentApprovalDecision> {
		const workspacePath = getLocalWorkspacePath();
		if (dangerousLocalModeIsActive(this.dangerousLocalModeGrant, workspacePath)) {
			return 'allow_once';
		}
		if (this.dangerousLocalModeGrant) {
			this.disableDangerousLocalMode(false);
		}
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
		this.activeMultiAgentRun?.cancel();
		this.activePlanProposalRun?.cancel();
		this.activeProjectRun?.cancel();
	}

	private currentProjectId(): string | undefined {
		return this.activeProjectRunId
			?? this.state.project.view?.runId
			?? this.context.workspaceState.get<string>(FikeyaWebviewViewProvider.currentProjectKey);
	}

	private async startProject(providerName: string, goal: string, onAccepted?: () => void): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const profile = this.state.providers.find(provider => provider.name === providerName);
		if (!workspacePath || !profile || this.activeAgentRun || this.activeMultiAgentRun
			|| this.activePlanProposalRun || this.activePlanRun || this.activeProjectRun || this.planCancellationInProgress) {
			return;
		}
		const currentProject = this.state.project.view;
		if (currentProject && (!['completed', 'stopped', 'failed'].includes(currentProject.stage)
			|| (currentProject.stage === 'stopped' && currentProject.record.resumeStage !== null))) {
			void vscode.window.showErrorMessage(vscode.l10n.t('A durable project is already active. Resume or cancel it before starting another project.'));
			return;
		}
		if (this.currentProjectId() && !currentProject && this.state.project.status !== 'idle') {
			void vscode.window.showErrorMessage(vscode.l10n.t('Wait for the current durable project record to finish loading, then try again.'));
			return;
		}
		if (!await this.ensureWorkspaceInitialized(workspacePath, false)) {
			return;
		}
		if (!await this.saveWorkspaceEditsBeforeAgentRun(workspacePath)) {
			return;
		}
		this.state = {
			...this.state,
			conversation: appendConversationMessage(this.state.conversation, createConversationMessage('user', goal)),
			project: { status: 'running', providerName, goal },
			agent: { status: 'idle', receiptsStatus: 'idle', receipts: [] }
		};
		await this.persistConversation();
		onAccepted?.();
		this.refresh();
		const operation = startFikeyaProject(
			'start', providerName, goal, workspacePath,
			request => this.approveAgentTool(request)
		);
		this.activeProjectRun = operation;
		const stopStartedObserver = operation.onStarted(started => {
			if (this.activeProjectRun !== operation) {
				return;
			}
			this.activeProjectRunId = started.runId;
			void this.context.workspaceState.update(FikeyaWebviewViewProvider.currentProjectKey, started.runId);
		});
		const result = await operation.result;
		stopStartedObserver();
		if (this.activeProjectRun !== operation) {
			return;
		}
		this.activeProjectRun = undefined;
		this.activeProjectRunId = undefined;
		await this.applyProjectResult(result, goal, providerName);
	}

	private async refreshProject(showFailure: boolean): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const runId = this.currentProjectId();
		if (!workspacePath || !runId || this.activeProjectRun) {
			return;
		}
		this.state = { ...this.state, project: { ...this.state.project, status: 'loading', failure: undefined } };
		this.refresh();
		const result = await loadFikeyaProject(runId, workspacePath);
		if (!result.ok || !result.value) {
			this.state = { ...this.state, project: { ...this.state.project, status: 'unavailable', failure: runtimeFailureMessage(result.failure) } };
			this.refresh();
			if (showFailure) {
				void vscode.window.showErrorMessage(vscode.l10n.t('The durable project record could not be recovered from this workspace.'));
			}
			return;
		}
		await this.applyProjectView(result.value);
	}

	private async runProjectAction(action: 'refresh' | 'resume' | 'cancel', suppliedGoal?: string, suppliedProvider?: string): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		const view = this.state.project.view;
		if (!workspacePath) {
			return;
		}
		if (action === 'refresh') {
			await this.refreshProject(true);
			return;
		}
		if (action === 'cancel') {
			const confirm = vscode.l10n.t('Cancel Project');
			const selected = await vscode.window.showWarningMessage(
				vscode.l10n.t('Cancel this durable project run? Its plan, transition history, and completed evidence remain available.'),
				{ modal: true },
				confirm
			);
			if (selected !== confirm) {
				return;
			}
			const runId = this.currentProjectId();
			if (!runId) {
				this.activeProjectRun?.cancel();
				return;
			}
			const result = await cancelFikeyaProject(runId, workspacePath);
			if (this.activeProjectRun && result.ok && result.value
				&& !['completed', 'stopped', 'failed'].includes(result.value.stage)) {
				// The durable store accepted the request. Keep the owner process alive long
				// enough to observe it, unwind tools, and emit the terminal receipt.
				return;
			}
			await this.applyProjectResult(result, this.state.project.goal, this.state.project.providerName);
			return;
		}
		if (!view) {
			return;
		}
		const goal = suppliedGoal?.trim() || this.state.project.goal;
		const providerName = suppliedProvider || this.state.project.providerName;
		if (!goal || !providerName || !this.state.providers.some(provider => provider.name === providerName)) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Choose a configured model and re-enter the exact original project goal before resuming this recovered run.'));
			return;
		}
		if (this.activeAgentRun || this.activeMultiAgentRun || this.activePlanProposalRun || this.activePlanRun || this.activeProjectRun) {
			return;
		}
		let allowPrivateBrowser = false;
		if (this.state.plan.record && planNeedsPrivateBrowserAccess(this.state.plan.record)) {
			const confirmation = vscode.l10n.t('Allow local browser access once');
			const accepted = await vscode.window.showWarningMessage(
				vscode.l10n.t('This audited project opens a loopback or private-network page. Allow that browser access for this resume only?'),
				{ modal: true },
				confirmation
			);
			if (accepted !== confirmation) {
				return;
			}
			allowPrivateBrowser = true;
		}
		this.state = { ...this.state, project: { ...this.state.project, status: 'running', goal, providerName, failure: undefined } };
		this.refresh();
		const operation = startFikeyaProject(
			'resume', providerName, goal, workspacePath,
			request => this.approveAgentTool(request), view.runId, [], allowPrivateBrowser
		);
		this.activeProjectRun = operation;
		this.activeProjectRunId = view.runId;
		const stopStartedObserver = operation.onStarted(started => {
			if (this.activeProjectRun === operation) {
				this.activeProjectRunId = started.runId;
			}
		});
		const result = await operation.result;
		stopStartedObserver();
		if (this.activeProjectRun !== operation) {
			return;
		}
		this.activeProjectRun = undefined;
		this.activeProjectRunId = undefined;
		await this.applyProjectResult(result, goal, providerName);
	}

	private async applyProjectResult(
		result: Awaited<ReturnType<typeof loadFikeyaProject>>,
		goal?: string,
		providerName?: string
	): Promise<void> {
		if (!result.ok || !result.value) {
			const failure = runtimeFailureMessage(result.failure);
			this.state = { ...this.state, project: { ...this.state.project, status: 'unavailable', failure } };
			this.refresh();
			return;
		}
		await this.applyProjectView(result.value, goal, providerName);
	}

	private async applyProjectView(view: FikeyaProjectView, goal?: string, providerName?: string): Promise<void> {
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.currentProjectKey, view.runId);
		if (view.planId) {
			await this.context.workspaceState.update(FikeyaWebviewViewProvider.currentPlanKey, view.planId);
		}
		this.state = {
			...this.state,
			project: {
				status: 'ready',
				view,
				goal: goal ?? this.state.project.goal,
				providerName: providerName ?? this.state.project.providerName,
				failure: view.record.failureReason ?? undefined
			}
		};
		this.refresh();
		if (view.planId) {
			await this.refreshPlan(false);
		}
	}

	private currentPlanId(): string | undefined {
		return this.context.workspaceState.get<string>(FikeyaWebviewViewProvider.currentPlanKey)
			?? this.state.plan.record?.planId;
	}

	private async startNewPlan(): Promise<void> {
		if (this.activePlanRun || this.activePlanProposalRun || this.activeProjectRun || this.planCancellationInProgress
			|| this.state.plan.status === 'loading' || this.state.plan.status === 'running') {
			return;
		}
		const currentPlanId = this.currentPlanId();
		if (currentPlanId) {
			const confirmation = vscode.l10n.t('Start New Plan');
			const accepted = await vscode.window.showWarningMessage(
				vscode.l10n.t('Start a new plan? The current plan remains stored in the workspace and can be restored.'),
				{ modal: true },
				confirmation
			);
			if (accepted !== confirmation) {
				return;
			}
			await this.context.workspaceState.update(FikeyaWebviewViewProvider.previousPlanKey, currentPlanId);
		}
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.currentPlanKey, undefined);
		this.state = { ...this.state, activeMode: 'chat', plan: { status: 'idle' } };
		this.refresh();
	}

	private async restorePreviousPlan(): Promise<void> {
		if (this.currentPlanId() || this.activePlanRun || this.activePlanProposalRun || this.activeProjectRun || this.planCancellationInProgress) {
			return;
		}
		const previousPlanId = this.context.workspaceState.get<string>(FikeyaWebviewViewProvider.previousPlanKey);
		if (!previousPlanId) {
			return;
		}
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.currentPlanKey, previousPlanId);
		await this.context.workspaceState.update(FikeyaWebviewViewProvider.previousPlanKey, undefined);
		this.state = { ...this.state, activeMode: 'chat', plan: { status: 'idle' } };
		await this.refreshPlan(true);
	}

	private async createPlan(specification: FikeyaPlanSpecification): Promise<void> {
		const workspacePath = getLocalWorkspacePath();
		if (!workspacePath) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Open one trusted local folder before creating a plan.'));
			return;
		}
		if (this.activePlanRun || this.activePlanProposalRun || this.activeProjectRun || this.planCancellationInProgress) {
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
		if (!planId || this.activePlanRun || this.activeProjectRun || this.planCancellationInProgress) {
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
			const confirmation = vscode.l10n.t('Cancel Plan');
			const accepted = await vscode.window.showWarningMessage(
				vscode.l10n.t('Cancel this plan? Completed step evidence remains available, but pending work will stop.'),
				{ modal: true },
				confirmation
			);
			if (accepted !== confirmation) {
				return;
			}
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

		if (this.activePlanRun || this.activeProjectRun) {
			return;
		}
		if ((action === 'approve-step' || action === 'approve-all') && !await this.confirmPlanApproval(plan, action === 'approve-step' ? stepId : undefined)) {
			return;
		}
		let allowPrivateBrowser = false;
		if ((action === 'run' || action === 'resume') && planNeedsPrivateBrowserAccess(plan)) {
			const confirmation = vscode.l10n.t('Allow local browser access once');
			const accepted = await vscode.window.showWarningMessage(
				vscode.l10n.t('This approved plan opens a loopback or private-network page. Allow that browser access for this run only?'),
				{ modal: true },
				confirmation
			);
			if (accepted !== confirmation) {
				return;
			}
			allowPrivateBrowser = true;
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

		const operation = startFikeyaPlan(action, plan.planId, workspacePath, allowPrivateBrowser);
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

	private refresh(forceWebview?: vscode.Webview): void {
		if (this.composerHasTransientAttachments && !forceWebview) {
			return;
		}
		if (this.view && (!forceWebview || forceWebview === this.view.webview)) {
			this.view.webview.html = this.getHtml(this.view.webview, 'sidebar');
		}
		if (this.panel && (!forceWebview || forceWebview === this.panel.webview)) {
			this.panel.webview.html = this.getHtml(this.panel.webview, 'editor');
		}
	}

	private getHtml(webview: vscode.Webview, surface: 'sidebar' | 'editor'): string {
		const nonce = randomBytes(16).toString('hex');
		const strings = getWebviewStrings();
		const providerCards = renderProviderCards(this.state, strings);
		const planOperationInProgress = this.activePlanRun !== undefined || this.planCancellationInProgress;
		const projectOperationInProgress = this.activeProjectRun !== undefined;
		const planSurface = renderPlanSurface(this.state, strings, this.context.workspaceState.get<string>(FikeyaWebviewViewProvider.previousPlanKey) !== undefined);
		const agentSurface = renderAgentSurface(this.state, strings, planOperationInProgress, projectOperationInProgress, this.previousConversation !== undefined, planSurface);
		const statisticsSurface = renderStatistics(this.state.statistics, strings);
		const memoryGraph = renderMemoryGraph(this.state, strings);
		const memoryGraphData = serializeForHtml(this.state.memory.snapshot ?? { nodes: [], edges: [] });
		const latestReceipt = this.state.agent.receipts.at(-1);
		const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fikeya.svg'));
		const initialModal = this.state.activeMode === 'context' || this.state.activeMode === 'usage' || this.state.activeMode === 'setup'
			? this.state.activeMode
			: '';
		const providerDefinitionOptions = getProviderDefinitions().map((definition, index) => `<option value="${escapeHtml(definition.id)}" data-label="${escapeHtml(definition.label)}" data-detail="${escapeHtml(definition.detail)}" data-base-url="${escapeHtml(definition.defaultBaseUrl)}" data-requires-secret="${definition.secretPrompt ? 'true' : 'false'}"${index === 0 ? ' selected' : ''}>${escapeHtml(definition.label)}</option>`).join('');
		const fullAccessActive = dangerousLocalModeIsActive(this.dangerousLocalModeGrant, getLocalWorkspacePath());
		const fullAccessRemainingMinutes = fullAccessActive && this.dangerousLocalModeGrant
			? Math.max(1, Math.ceil((this.dangerousLocalModeGrant.expiresAt - Date.now()) / 60_000))
			: 0;
		const setupCards = `<section class="grid two compact-grid">
			<article class="card">
				<div class="card-heading"><h2>${escapeHtml(strings.getStarted)}</h2><span class="badge">${escapeHtml(this.state.workspaceInitialized ? strings.initialized : strings.notInitialized)}</span></div>
				<p>${escapeHtml(strings.getStartedDescription)}</p>
				<div class="actions"><button data-command="fikeya.initializeWorkspace" type="button">${escapeHtml(strings.initializeWorkspace)}</button><button data-command="fikeya.runDoctor" class="secondary" type="button">${escapeHtml(strings.runDoctor)}</button></div>
			</article>
			<article class="card">
				<div class="card-heading"><h2>${escapeHtml(strings.providers)}</h2><span class="badge">${escapeHtml(providerStatusSummary(this.state, strings))}</span></div>
				<div class="providers">${providerCards}</div>
				<div class="actions"><button data-provider-modal-open type="button">${escapeHtml(strings.configureProvider)}</button><button data-command="fikeya.configureProvider" class="secondary" type="button">${escapeHtml(vscode.l10n.t('Azure CLI discovery'))}</button><button data-action="refresh-providers" class="secondary" type="button">${escapeHtml(strings.refresh)}</button></div>
			</article>
			<article class="card full-access-card" data-active="${fullAccessActive}">
				<div class="card-heading"><h2>${escapeHtml(vscode.l10n.t('Temporary Full Access'))}</h2><span class="badge">${escapeHtml(fullAccessActive ? vscode.l10n.t('{0} min left', fullAccessRemainingMinutes) : vscode.l10n.t('Off'))}</span></div>
				<p>${escapeHtml(vscode.l10n.t('For a trusted local folder only. Fikeya skips repeated tool approval dialogs for 15 minutes while keeping containment, limits, redaction, cancellation, and receipts. It is never enabled remotely or restored after restart.'))}</p>
				<div class="actions">${fullAccessActive
					? `<button data-command="fikeya.dangerousLocalMode.disable" class="secondary" type="button">${escapeHtml(vscode.l10n.t('Disable now'))}</button>`
					: `<button data-command="fikeya.dangerousLocalMode.enable" type="button">${escapeHtml(vscode.l10n.t('Enable for 15 minutes'))}</button>`}</div>
			</article>
		</section>`;
		const usageSurface = `${statisticsSurface}${this.state.agent.outcome ? `<section class="card">${renderCodingOutcome(this.state.agent.outcome, strings)}</section>` : ''}${this.state.agent.sessionId ? `<section class="card"><h2>${escapeHtml(strings.latestCallReceipt)}</h2>${renderReceipt(latestReceipt, this.state.agent, strings)}</section>` : ''}`;
		const closeOverlay = `<button class="quiet overlay-close" data-modal-close type="button" aria-label="${escapeHtml(vscode.l10n.t('Close'))}">${escapeHtml(vscode.l10n.t('Close'))}</button>`;
		const chatWorkspace = `<div class="active-surface" data-initial-modal="${initialModal}" data-plan-id="${escapeHtml(this.state.plan.record?.planId ?? '')}" data-accepted-request-id="${escapeHtml(this.lastAcceptedComposerRequestId ?? '')}">
			<nav class="workspace-navigation" aria-label="${escapeHtml(vscode.l10n.t('Fikeya workspace'))}">
				<div class="workspace-current"><img class="workspace-mark" src="${logoUri}" alt=""><strong>${escapeHtml(vscode.l10n.t('Fikeya Chat'))}</strong><span class="workspace-label" title="${escapeHtml(this.state.workspaceName)}">${escapeHtml(this.state.workspaceName)}</span></div>
			</nav>
			<section id="surface-panel-chat" class="surface-panel" role="region" aria-label="${escapeHtml(vscode.l10n.t('Chat'))}" data-surface-panel="chat">${agentSurface}</section>
			<dialog class="workspace-overlay" data-workspace-modal="context" aria-label="${escapeHtml(vscode.l10n.t('Context graph'))}"><header><strong>${escapeHtml(vscode.l10n.t('Qarinah context graph'))}</strong>${closeOverlay}</header><div class="workspace-overlay-body">${memoryGraph}</div></dialog>
			<dialog class="workspace-overlay" data-workspace-modal="usage" aria-label="${escapeHtml(vscode.l10n.t('Usage and receipts'))}"><header><strong>${escapeHtml(vscode.l10n.t('Usage and receipts'))}</strong>${closeOverlay}</header><div class="workspace-overlay-body">${usageSurface}</div></dialog>
			<dialog class="workspace-overlay" data-workspace-modal="setup" aria-label="${escapeHtml(vscode.l10n.t('Models and setup'))}"><header><strong>${escapeHtml(vscode.l10n.t('Models and setup'))}</strong>${closeOverlay}</header><div class="workspace-overlay-body">${setupCards}</div></dialog>
			<dialog class="provider-modal" data-provider-modal aria-label="${escapeHtml(vscode.l10n.t('Add a model'))}">
				<form data-provider-form autocomplete="off">
					<header><div><strong>${escapeHtml(vscode.l10n.t('Add a model'))}</strong><span>${escapeHtml(vscode.l10n.t('Your credential is sent once to the local runtime and stored in the operating system credential store.'))}</span></div><button class="quiet" data-provider-modal-close type="button" aria-label="${escapeHtml(vscode.l10n.t('Close'))}">×</button></header>
					<div class="provider-modal-body">
						<label class="field"><span>${escapeHtml(vscode.l10n.t('Provider'))}</span><select name="providerId">${providerDefinitionOptions}</select></label>
						<p class="provider-definition-detail" data-provider-detail></p>
						<div class="provider-fields"><label class="field"><span>${escapeHtml(vscode.l10n.t('Profile name'))}</span><input name="profileLabel" maxlength="80" required></label><label class="field"><span>${escapeHtml(vscode.l10n.t('Model or deployment'))}</span><input name="model" maxlength="160" placeholder="${escapeHtml(vscode.l10n.t('Enter the exact model ID'))}" required></label></div>
						<label class="field"><span>${escapeHtml(vscode.l10n.t('Endpoint'))}</span><input name="baseUrl" type="url" maxlength="4096" required></label>
						<label class="field" data-provider-secret-field><span>${escapeHtml(vscode.l10n.t('API key or token'))}</span><input name="secret" type="password" maxlength="16384" autocomplete="new-password"></label>
						<p class="provider-form-error" data-provider-error role="alert" hidden></p>
					</div>
					<footer><button class="secondary" data-provider-modal-close type="button">${escapeHtml(vscode.l10n.t('Cancel'))}</button><button type="submit">${escapeHtml(vscode.l10n.t('Add model'))}</button></footer>
				</form>
			</dialog>
		</div>`;
		const sidebarContent = chatWorkspace;
		const editorContent = chatWorkspace;

		return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>${escapeHtml(strings.fikeya)}</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; min-width: 0; max-width: 100%; overflow: hidden; }
		body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
		body[data-surface="editor"] { background: var(--vscode-editor-background); }
		button { min-height: 30px; padding: 5px 9px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		button:disabled { cursor: not-allowed; opacity: .58; }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
		.shell { display: grid; width: min(100%, 960px); height: 100%; min-width: 0; min-height: 0; gap: 12px; margin: 0 auto; padding: 12px; }
		body[data-surface="editor"] .shell, body[data-surface="sidebar"] .shell { width: 100%; max-width: none; gap: 0; padding: 0; overflow: hidden; }
		body[data-surface="editor"] .masthead, body[data-surface="sidebar"] .masthead { display: none; }
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
			.workspace-navigation { position: relative; display: flex; align-items: center; justify-content: space-between; min-width: 0; min-height: 34px; padding: 0 2px; border-bottom: 1px solid var(--vscode-widget-border); }
			.workspace-current { display: inline-flex; min-width: 0; align-items: center; gap: 7px; }
			.status-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
			.workspace-menu { position: relative; z-index: 20; }
			.workspace-menu > summary { display: inline-flex; min-height: 28px; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid transparent; color: var(--vscode-descriptionForeground); cursor: pointer; list-style: none; user-select: none; }
			.workspace-menu > summary::-webkit-details-marker { display: none; }
			.workspace-menu > summary:hover, .workspace-menu[open] > summary { border-color: var(--vscode-widget-border); color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
			.workspace-menu-popover { position: absolute; top: calc(100% + 4px); right: 0; display: grid; width: min(280px, calc(100vw - 28px)); gap: 1px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); background: var(--vscode-menu-background); box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
			.mode-switcher, .native-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; }
			.mode-switcher { padding-bottom: 4px; border-bottom: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-widget-border)); }
			.mode-switcher button, .native-actions button { min-width: 0; justify-content: start; border: 0; color: var(--vscode-menu-foreground); background: transparent; font-size: 12px; text-align: left; }
			.mode-switcher button:hover { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
			.mode-switcher button[aria-selected="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
			.run-summary { min-width: 0; }
			.run-summary > summary { display: flex; min-height: 34px; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 8px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); cursor: pointer; list-style: none; }
			.run-summary > summary::-webkit-details-marker { display: none; }
			.run-summary > summary span:first-child { display: grid; min-width: 0; gap: 1px; }
			.run-summary > summary strong { overflow: hidden; color: var(--vscode-foreground); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
			.run-summary > summary small { font-size: 10px; }
			.run-summary-body { display: grid; gap: 7px; padding-top: 7px; }
		button.quiet { min-height: 28px; border-color: var(--vscode-widget-border); color: var(--vscode-foreground); background: transparent; }
		button.quiet:hover { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.active-surface, .surface-panel { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; max-width: 100%; grid-template-columns: minmax(0, 1fr); gap: 0; overflow: hidden; }
		.active-surface { grid-template-rows: auto minmax(0, 1fr); }
		.surface-panel { grid-template-rows: minmax(0, 1fr); }
		.workspace-navigation { display: flex; min-width: 0; min-height: 38px; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 10px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
		.workspace-current { display: flex; min-width: 0; align-items: center; gap: 7px; }
		.workspace-mark { width: 18px; height: 18px; flex: 0 0 auto; object-fit: contain; }
		.workspace-current strong { flex: 0 0 auto; font-size: 12px; font-weight: 600; }
		.workspace-current .workspace-label { max-width: min(34vw, 280px); margin-left: 1px; }
		.workspace-overlay { width: min(920px, calc(100vw - 24px)); max-width: 920px; height: min(820px, calc(100vh - 24px)); max-height: calc(100vh - 24px); padding: 0; overflow: hidden; border: 1px solid var(--vscode-widget-border); color: var(--vscode-foreground); background: var(--vscode-editor-background); box-shadow: 0 16px 48px var(--vscode-widget-shadow); }
		.workspace-overlay::backdrop { background: rgba(0, 0, 0, .48); }
		.workspace-overlay > header { display: flex; min-height: 42px; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
		.workspace-overlay-body { height: calc(100% - 42px); padding: 10px; overflow: auto; }
		.overlay-close { margin-left: auto; }
		.provider-modal { width: min(560px, calc(100vw - 24px)); max-width: 560px; padding: 0; overflow: hidden; border: 1px solid var(--vscode-widget-border); border-radius: 14px; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); box-shadow: 0 20px 64px var(--vscode-widget-shadow); }
		.provider-modal::backdrop { background: rgba(0, 0, 0, .56); backdrop-filter: blur(2px); }
		.provider-modal form { display: grid; max-height: min(720px, calc(100vh - 24px)); grid-template-rows: auto minmax(0, 1fr) auto; }
		.provider-modal header, .provider-modal footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; }
		.provider-modal header { border-bottom: 1px solid var(--vscode-widget-border); }
		.provider-modal header > div { display: grid; min-width: 0; gap: 3px; }
		.provider-modal header strong { font-size: 14px; }
		.provider-modal header span { color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.35; }
		.provider-modal footer { justify-content: flex-end; border-top: 1px solid var(--vscode-widget-border); }
		.provider-modal-body { display: grid; gap: 10px; padding: 14px; overflow: auto; }
		.provider-fields { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); gap: 10px; }
		.provider-definition-detail, .provider-form-error { padding: 8px 9px; border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-textBlockQuote-background); font-size: 11px; }
		.provider-form-error { border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
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
		.agent-surface { position: relative; display: grid; width: 100%; min-width: 0; height: 100%; max-height: 100%; min-height: 0; grid-template-rows: minmax(0, 1fr) auto; gap: 0; padding: 0; overflow: hidden; contain: size layout; border: 0; background: var(--vscode-editor-background); }
		.agent-surface.is-dropping::after { position: absolute; z-index: 30; display: grid; inset: 10px; place-items: center; border: 2px dashed var(--vscode-focusBorder); border-radius: 14px; color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent); content: attr(data-drop-label); font-weight: 600; pointer-events: none; }
		.agent-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
		.agent-heading-actions { display: flex; align-items: center; gap: 6px; }
		.agent-heading { padding: 12px 14px 0; }
		.agent-heading h2 { margin: 0; font-size: 16px; }
		.agent-heading p { margin-top: 3px; font-size: 11px; }
		.chat-plan-strip { display: grid; min-width: 0; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) auto; align-items: center; gap: 10px; margin: 0 14px; padding: 9px 10px; border: 1px solid var(--vscode-widget-border); border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); }
		.chat-plan-details > summary { cursor: pointer; list-style: none; }
		.chat-plan-details > summary::-webkit-details-marker { display: none; }
		.chat-plan-body { margin: 0 14px 10px; padding: 10px; border: 1px solid var(--vscode-widget-border); border-top: 0; background: var(--vscode-editorWidget-background); }
		.plan-expand { color: var(--vscode-textLink-foreground); font-size: 11px; }
		.chat-plan-copy, .chat-plan-step { display: grid; min-width: 0; gap: 2px; }
		.chat-plan-copy strong, .chat-plan-step strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.chat-plan-copy span, .chat-plan-step span { color: var(--vscode-descriptionForeground); font-size: 10px; }
		.chat-plan-copy strong { font-size: 12px; }
		.chat-plan-step strong { font-size: 11px; }
		.chat-plan-status { display: inline-flex; width: fit-content; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.chat-thread { display: flex; min-height: 0; max-height: none; flex-direction: column; gap: 18px; overflow: auto; overscroll-behavior: contain; padding: 24px max(16px, calc((100% - 880px) / 2)) 16px; background: var(--vscode-editor-background); scroll-behavior: smooth; }
		.chat-empty { display: grid; place-content: center; max-width: 54ch; min-height: min(290px, 42vh); margin: auto; text-align: left; }
		.chat-empty strong { font-size: 18px; }
		.chat-empty p { margin-top: 7px; }
		.prompt-suggestions { display: grid; gap: 6px; margin-top: 18px; }
		.prompt-suggestions button { width: 100%; text-align: left; }
		.chat-message { display: grid; max-width: min(86%, 760px); gap: 7px; }
		.chat-message.user-message { align-self: end; padding: 10px 12px; border: 1px solid var(--vscode-widget-border); border-radius: 12px; background: var(--vscode-editorWidget-background); }
		.chat-message.assistant-message { align-self: start; width: 100%; }
		.chat-message.notice-message { align-self: stretch; max-width: none; padding: 8px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; color: var(--vscode-descriptionForeground); }
		.chat-message[data-tone="error"] { color: var(--vscode-errorForeground); }
		.message-meta { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.message-meta strong { color: var(--vscode-foreground); font-size: 11px; }
		.message-meta time { margin-left: auto; }
		.message-content { color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
		.message-content > :first-child { margin-top: 0; }
		.message-content > :last-child { margin-bottom: 0; }
		.message-content p, .message-content ul { margin-block: 8px; }
		.message-content ul { padding-left: 20px; }
		.message-content h3, .message-content h4, .message-content h5, .message-content h6 { margin: 14px 0 6px; font-size: 13px; }
		.message-content code { font-family: var(--vscode-editor-font-family); }
		.message-link { display: inline; width: auto; min-height: 0; margin: 0; padding: 0; border: 0; color: var(--vscode-textLink-foreground); background: transparent; font: inherit; text-decoration: underline; }
		.message-code { margin: 10px 0; border: 1px solid var(--vscode-widget-border); background: var(--vscode-textCodeBlock-background); }
		.message-code figcaption { display: flex; min-height: 28px; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 7px; border-bottom: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
		.message-code-actions { display: inline-flex; gap: 4px; }
		.message-code pre { max-height: 420px; margin: 0; overflow: auto; padding: 10px; white-space: pre; }
		.message-attachments { display: flex; flex-wrap: wrap; gap: 6px; }
		.message-attachment { display: inline-flex; align-items: center; gap: 5px; min-width: 0; padding: 4px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 7px; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); font-size: 10px; }
		.message-attachment strong { max-width: 220px; overflow: hidden; color: var(--vscode-foreground); text-overflow: ellipsis; white-space: nowrap; }
		.message-attachment-path { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.message-actions { display: flex; min-height: 30px; align-items: center; justify-content: start; gap: 2px; margin-top: 1px; opacity: .66; transform: translateY(-2px); transition: opacity 140ms ease, transform 140ms ease; }
		.user-message .message-actions { justify-content: end; }
		.chat-message:hover .message-actions, .chat-message:focus-within .message-actions, .message-actions[data-active="true"] { opacity: 1; transform: translateY(0); }
		.message-action { display: grid; width: 28px; min-width: 28px; min-height: 28px; place-items: center; padding: 0; border: 1px solid transparent; border-radius: 7px; color: var(--vscode-descriptionForeground); background: transparent; transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease, transform 120ms ease; }
		.message-action:hover { border-color: color-mix(in srgb, var(--vscode-widget-border) 74%, transparent); color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 88%, transparent); }
		.message-action:active { transform: scale(.92); }
		.message-action:focus-visible { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
		.message-action-icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
		.message-action .copied-icon { display: none; }
		.message-action[data-copy-state="copied"] { color: var(--vscode-testing-iconPassed); }
		.message-action[data-copy-state="copied"] .copy-icon { display: none; }
		.message-action[data-copy-state="copied"] .copied-icon { display: block; animation: fikeya-action-confirm 180ms ease-out; }
		.thinking-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-progressBar-background); animation: fikeya-pulse 1.2s ease-in-out infinite; }
		.multi-agent-live { display: grid; width: min(100%, 560px); gap: 7px; padding: 9px 10px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
		.multi-agent-live > strong { font-size: 12px; }
		.multi-agent-live ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
		.multi-agent-live li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
		.multi-agent-live li strong { overflow: hidden; color: var(--vscode-foreground); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
		.run-progress-stages { display: grid; width: min(100%, 720px); grid-template-columns: repeat(5, minmax(76px, 1fr)); gap: 1px; margin: 3px 0 0; padding: 1px; overflow-x: auto; list-style: none; background: var(--vscode-widget-border); }
		.run-progress-stages li { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 5px; padding: 6px; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); }
		.run-progress-stages li > span:first-child { display: grid; width: 17px; height: 17px; place-items: center; border: 1px solid var(--vscode-widget-border); border-radius: 50%; font-family: var(--vscode-editor-font-family); font-size: 8px; }
		.run-progress-stages strong { overflow: hidden; font-family: var(--vscode-editor-font-family); font-size: 9px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
		.run-progress-stages li[data-status="complete"] > span:first-child { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
		.run-progress-stages li[data-status="active"] { color: var(--vscode-foreground); box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
		.run-progress-stages li[data-status="active"] > span:first-child { border-color: var(--vscode-progressBar-background); background: var(--vscode-progressBar-background); color: var(--vscode-button-foreground); }
		.plan-run-progress { display: grid; gap: 6px; margin: -10px 14px 0; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.run-recovery-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin: -10px 14px 0; }
		.run-recovery-actions span { margin-right: auto; color: var(--vscode-descriptionForeground); font-size: 10px; }
		.durable-project { display: grid; align-self: stretch; gap: 8px; margin: 0 14px; padding: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 10px; background: var(--vscode-editorWidget-background); font-size: 11px; }
		.durable-project[data-tone="error"] { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
		.durable-project > header { display: flex; min-width: 0; align-items: start; justify-content: space-between; gap: 10px; }
		.durable-project > header > div { display: grid; gap: 2px; }
		.durable-project > header span, .durable-project > span, .project-next-action > span { color: var(--vscode-descriptionForeground); }
		.durable-project > header code { max-width: 42%; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
		.durable-project details > summary { cursor: pointer; }
		.project-history { display: grid; gap: 1px; margin: 8px 0 0; padding: 1px; overflow-x: auto; list-style: none; background: var(--vscode-widget-border); }
		.project-history li { display: grid; min-width: 520px; grid-template-columns: 76px 90px minmax(150px, 1fr) 150px; align-items: center; gap: 8px; padding: 6px 8px; background: var(--vscode-editorWidget-background); }
		.project-history li[aria-current="step"] { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
		.project-history time, .project-history code, .project-history span { color: var(--vscode-descriptionForeground); font-size: 10px; }
		.project-next-action { display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border); }
		.project-next-action > span { margin-right: auto; }
		.project-goal { width: 100%; }
		.project-goal textarea { min-height: 64px; }
		@keyframes fikeya-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
		@keyframes fikeya-action-confirm { 0% { opacity: 0; transform: scale(.65); } 100% { opacity: 1; transform: scale(1); } }
			.agent-form { position: relative; z-index: 10; display: grid; width: calc(100% - 20px); max-width: 900px; gap: 0; margin: 0 auto 10px; padding: 8px; border: 1px solid var(--vscode-focusBorder); border-radius: 16px; background: var(--vscode-editor-background); box-shadow: 0 8px 26px color-mix(in srgb, var(--vscode-widget-shadow) 52%, transparent); transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
			.agent-surface.is-dropping .agent-form { border-color: var(--vscode-button-background); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 38%, transparent), 0 12px 34px var(--vscode-widget-shadow); transform: translateY(-1px); }
			.agent-form .composer textarea { min-height: 78px; max-height: 260px; border: 0; background: transparent; resize: none; }
			.composer-mode-help { min-height: 17px; padding: 0 4px 5px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.35; }
			.composer-attachments { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 2px 7px; }
			.composer-attachments[hidden] { display: none; }
			.composer-attachment { position: relative; display: grid; width: 66px; min-width: 0; gap: 3px; margin: 0; }
			.composer-attachment img { width: 66px; height: 52px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; object-fit: cover; }
			.composer-attachment figcaption { overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
			.composer-attachment button { position: absolute; top: 3px; right: 3px; display: grid; width: 20px; min-width: 20px; min-height: 20px; place-items: center; padding: 0; border-radius: 999px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); line-height: 1; }
			.composer-attachment.file { width: 150px; min-height: 52px; grid-template-columns: 30px minmax(0, 1fr); align-items: center; padding: 7px 28px 7px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 9px; background: var(--vscode-editorWidget-background); }
			.composer-file-icon { display: grid; width: 30px; height: 34px; place-items: center; border-radius: 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-family: var(--vscode-editor-font-family); font-size: 10px; font-weight: 700; }
			.composer-file-copy { display: grid; min-width: 0; gap: 2px; }
			.composer-file-copy strong, .composer-file-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.composer-bar { display: flex; min-width: 0; align-items: center; gap: 5px; padding-top: 6px; border-top: 1px solid var(--vscode-widget-border); }
			.inline-field { min-width: 0; max-width: none; flex: 1 1 auto; }
			.inline-field select { max-width: 100%; border: 0; background: var(--vscode-dropdown-background); overflow: hidden; text-overflow: ellipsis; }
			.composer-mode { width: 84px; min-width: 72px; max-width: 84px; }
			.composer-mode select { max-width: 100%; border: 0; background: var(--vscode-dropdown-background); font-weight: 600; }
			.agent-picker { position: relative; }
			.agent-picker[hidden] { display: none; }
			.agent-picker > summary { display: flex; min-height: 30px; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; cursor: pointer; list-style: none; }
			.agent-picker > summary::-webkit-details-marker { display: none; }
			.agent-picker [data-agent-count] { display: grid; min-width: 18px; height: 18px; place-items: center; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
			.agent-picker-menu { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 30; display: grid; width: min(330px, calc(100vw - 42px)); max-height: min(420px, 60vh); gap: 8px; padding: 10px; overflow: auto; border: 1px solid var(--vscode-widget-border); border-radius: 9px; background: var(--vscode-menu-background); box-shadow: 0 10px 30px var(--vscode-widget-shadow); }
			.agent-choice { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 8px; padding: 7px; border: 1px solid var(--vscode-widget-border); cursor: pointer; }
			.agent-choice span { display: grid; min-width: 0; gap: 2px; }
			.agent-choice small { overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
			.composer-actions { margin-left: auto; flex-wrap: nowrap; justify-content: end; }
			.composer-actions button { display: grid; width: 32px; min-width: 32px; min-height: 30px; place-items: center; padding: 0; border-radius: 999px; font-size: 17px; line-height: 1; }
			.composer-icon { display: grid; width: 30px; min-width: 30px; min-height: 30px; place-items: center; padding: 0; border-color: transparent; }
			.composer-attach, .composer-mention { position: relative; }
			.composer-attach > summary, .composer-mention > summary { display: grid; width: 30px; min-width: 30px; min-height: 30px; place-items: center; border: 1px solid transparent; border-radius: 999px; cursor: pointer; font-size: 17px; list-style: none; }
			.composer-attach > summary::-webkit-details-marker, .composer-mention > summary::-webkit-details-marker { display: none; }
			.composer-attach[open] > summary, .composer-mention[open] > summary { border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
			.composer-attach-menu { position: absolute; bottom: calc(100% + 7px); left: 0; z-index: 34; display: grid; width: 210px; gap: 1px; padding: 5px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius: 9px; background: var(--vscode-menu-background); box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
			.composer-attach-menu button { min-height: 30px; border: 0; color: var(--vscode-menu-foreground); background: transparent; text-align: left; }
			.composer-attach-menu button:hover { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
			.composer-route { position: relative; }
			.composer-route > summary { display: grid; width: 30px; min-width: 30px; min-height: 30px; place-items: center; padding: 0; border: 1px solid transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; list-style: none; }
			.composer-route > summary::-webkit-details-marker { display: none; }
			.composer-route[open] > summary { border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
			.composer-route-menu { position: absolute; right: -42px; bottom: calc(100% + 6px); z-index: 30; display: grid; width: min(310px, calc(100vw - 32px)); gap: 1px; padding: 6px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius: 9px; background: var(--vscode-menu-background); box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
			.composer-menu-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 6px 6px 10px; border-bottom: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-widget-border)); }
			.composer-menu-controls .field:first-child { grid-column: 1 / -1; }
			.composer-menu-controls .field > span { font-size: 10px; }
			.composer-route-menu nav { display: grid; gap: 1px; padding-top: 4px; }
			.composer-route-menu button { min-height: 28px; border: 0; color: var(--vscode-menu-foreground); background: transparent; text-align: left; }
			.composer-route-menu button:hover { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
		.field { display: grid; gap: 4px; }
		.field > span { color: var(--vscode-foreground); font-weight: 600; }
		select, textarea, input[type="number"], input[type="search"] { width: 100%; border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
		select, input[type="number"], input[type="search"] { min-height: 30px; padding: 4px 7px; }
		textarea { min-height: 108px; resize: vertical; padding: 7px; line-height: 1.45; }
		select:focus-visible, textarea:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
			.composer-foot { display: block; min-width: 0; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; }
			.composer-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.consent { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.4; }
		.consent input { margin: 2px 0 0; }
		.agent-status { margin: 0 14px; padding: 8px 9px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-textBlockQuote-background); }
		.agent-status[data-tone="error"] { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
		.run-details { margin: 0 14px 14px; border: 1px solid var(--vscode-widget-border); }
		.run-details > summary { padding: 8px 10px; cursor: pointer; }
		.run-details-body { display: grid; gap: 12px; padding: 10px; border-top: 1px solid var(--vscode-widget-border); }
		.agent-output { max-height: 360px; margin: 0; overflow: auto; padding: 10px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
		.agent-receipt { display: grid; gap: 8px; }
		.outcome-files { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
		.outcome-file { width: 100%; min-height: 28px; border-color: var(--vscode-widget-border); color: var(--vscode-foreground); background: transparent; font-family: var(--vscode-editor-font-family); font-size: 11px; text-align: left; }
		.chat-run-outcome { width: min(100%, 760px); align-self: start; border: 1px solid var(--vscode-widget-border); border-radius: 10px; background: var(--vscode-editorWidget-background); }
		.chat-run-outcome > summary { display: flex; min-height: 34px; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 9px; cursor: pointer; }
		.chat-run-outcome > summary span { color: var(--vscode-descriptionForeground); font-size: 10px; }
		.chat-run-outcome > div { display: grid; gap: 8px; padding: 0 9px 9px; border-top: 1px solid var(--vscode-widget-border); }
		.chat-run-outcome > div > p { padding-top: 8px; }
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
		.plan-lifecycle li > span:first-child { display: grid; width: 20px; height: 20px; place-items: center; border: 1px solid var(--vscode-widget-border); border-radius: 50%; font-family: var(--vscode-editor-font-family); font-size: 9px; }
		.plan-lifecycle li strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
		.plan-lifecycle li[data-status="complete"] > span:first-child { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
		.plan-lifecycle li[data-status="active"] > span:first-child { border-color: var(--vscode-progressBar-background); background: var(--vscode-progressBar-background); color: var(--vscode-button-foreground); }
		.plan-lifecycle li[data-status="attention"] > span:first-child { border-color: var(--vscode-testing-iconFailed); color: var(--vscode-testing-iconFailed); }
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
		.graph-results { display: grid; max-height: 220px; gap: 2px; margin: 0; padding: 0; overflow: auto; list-style: none; }
		.graph-results button { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; border-color: var(--vscode-widget-border); color: var(--vscode-foreground); background: transparent; text-align: left; }
		.graph-results button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.graph-results button small { color: var(--vscode-descriptionForeground); }
		.memory-graph[data-expanded="true"] { position: fixed; inset: 0; z-index: 1000; align-content: start; overflow: auto; padding: 12px; background: var(--vscode-editor-background); }
		.memory-graph[data-expanded="true"] .graph-viewport, .memory-graph[data-expanded="true"] .graph-canvas { min-height: calc(100vh - 160px); }
		.disclaimer { padding-left: 9px; border-left: 2px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
		.full-access-card { border-color: var(--vscode-editorWarning-foreground); }
		.full-access-card[data-active="true"] { box-shadow: inset 3px 0 0 var(--vscode-editorWarning-foreground); }
		@media (min-width: 620px) { .run-strip { grid-template-columns: minmax(190px, 2fr) repeat(4, minmax(82px, 1fr)); } .run-metric.provider { grid-column: auto; } }
			@media (min-width: 520px) { .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .statistics-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
		@media (max-width: 900px) { .graph-workspace, .plan-workspace { grid-template-columns: 1fr; } .graph-details { max-height: none; } }
			@media (max-width: 780px) { .workspace-menu-popover { position: fixed; top: 52px; right: 12px; } }
			@media (max-width: 720px) { .chat-plan-strip { grid-template-columns: minmax(0, 1fr) auto; } .chat-plan-copy { grid-column: 1 / -1; } .composer-bar { gap: 3px; } .composer-mode { width: 76px; min-width: 68px; } .inline-field { min-width: 0; max-width: none; flex: 1 1 auto; } .composer-menu-controls { grid-template-columns: 1fr; } .composer-menu-controls .field:first-child { grid-column: auto; } .plan-evidence { grid-template-columns: 1fr; } .plan-lifecycle { grid-template-columns: 1fr; } }
			@media (max-width: 520px) { .graph-controls { grid-template-columns: 1fr 1fr; } .graph-controls .actions { grid-column: 1 / -1; } .statistics-status { grid-template-columns: 1fr; } .provider-fields { grid-template-columns: 1fr; } }
			@media (max-width: ${fikeyaNarrowPanelMaximumWidth}px) { body[data-surface="editor"] .shell { padding-inline: 8px; } .masthead { padding-inline: 9px; } .workspace-label { max-width: 42%; } .mode-switcher { min-width: 0; grid-template-columns: 1fr; } .mode-switcher button { min-width: 0; padding-inline: 8px; } .run-strip, .statistics-grid { grid-template-columns: 1fr; } .run-metric.provider { grid-column: auto; } .agent-heading, .plan-heading { align-items: stretch; flex-direction: column; } .agent-heading-actions { justify-content: space-between; } .chat-plan-strip { grid-template-columns: 1fr; margin-inline: 8px; } .chat-plan-copy { grid-column: auto; } .chat-plan-strip button { width: 100%; } .chat-thread { min-height: 0; padding: 14px 10px; } .chat-message { max-width: 100%; } .message-meta { flex-wrap: wrap; } .message-meta time { margin-left: 0; } .agent-form { margin-inline: 8px; padding: 8px; } .control-grid { max-width: calc(100vw - 28px); padding: 8px; } .composer-actions { display: flex; } .composer-actions button { width: auto; } .agent-status, .run-details { margin-inline: 8px; } .receipt, .statistics-status dl { grid-template-columns: 1fr; } .table-scroll { overscroll-behavior-inline: contain; } .plan-step { grid-template-columns: 26px minmax(0, 1fr); } .plan-step-status { grid-column: 2; } .graph-controls { grid-template-columns: 1fr; } .graph-controls .actions { grid-column: 1; } .graph-viewport, .graph-canvas { min-height: 340px; } .graph-details { padding: 8px; } }
		@media (max-height: 620px) { .chat-thread { gap: 10px; padding-block: 10px 8px; } .chat-empty { min-height: 0; place-content: start; } .prompt-suggestions { margin-top: 10px; } .agent-form { margin-bottom: 6px; } .composer textarea { min-height: 54px; max-height: 112px; } }
		@media (max-width: 280px) { .provider-card { grid-template-columns: 1fr; } }
		@media (hover: none), (pointer: coarse) { .message-actions { opacity: 1; transform: none; } }
		@media (prefers-reduced-motion: reduce) { .chat-thread { scroll-behavior: auto; } .thinking-dot, .message-action[data-copy-state="copied"] .copied-icon { animation: none; opacity: 1; } .message-actions, .message-action { transition: none; transform: none; } }
	</style>
</head>
		<body data-surface="${surface}" data-copied-label="${escapeHtml(vscode.l10n.t('Copied'))}">
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
		document.addEventListener('submit', event => event.preventDefault(), true);
		const persistedState = vscode.getState() || {};
		const postUi = (type, payload = {}) => vscode.postMessage({
			jsonrpc: '2.0',
			method: 'ui.' + type,
			params: { type, ...payload }
		});
		const persistUiState = patch => vscode.setState({ ...(vscode.getState() || {}), ...patch });
		const surfaceRoot = document.querySelector('[data-initial-modal]');
		const acceptedComposerRequestId = surfaceRoot?.dataset.acceptedRequestId || '';
		if (acceptedComposerRequestId && persistedState.pendingComposerRequestId === acceptedComposerRequestId) {
			persistedState.chatDraft = '';
			persistedState.pendingComposerRequestId = '';
			persistUiState({ chatDraft: '', pendingComposerRequestId: '' });
		}
		const copiedLabel = document.body.dataset.copiedLabel || '';
		const copyFeedbackTimers = new WeakMap();
		const showCopiedState = button => {
			const originalLabel = button.getAttribute('aria-label') || button.textContent || '';
			const originalTitle = button.getAttribute('title') || originalLabel;
			const originalText = button.matches('[data-copy-code]') ? button.textContent : '';
			const existingTimer = copyFeedbackTimers.get(button);
			if (existingTimer) clearTimeout(existingTimer);
			button.dataset.copyState = 'copied';
			button.setAttribute('aria-label', copiedLabel);
			button.setAttribute('title', copiedLabel);
			button.closest('.message-actions')?.setAttribute('data-active', 'true');
			const status = button.closest('.message-actions')?.querySelector('[data-copy-status]');
			if (status) status.textContent = copiedLabel;
			if (button.matches('[data-copy-code]')) button.textContent = copiedLabel;
			copyFeedbackTimers.set(button, setTimeout(() => {
				delete button.dataset.copyState;
				button.setAttribute('aria-label', originalLabel);
				button.setAttribute('title', originalTitle);
				button.closest('.message-actions')?.removeAttribute('data-active');
				if (status) status.textContent = '';
				if (button.matches('[data-copy-code]')) button.textContent = originalText;
				copyFeedbackTimers.delete(button);
			}, 1600));
		};
		const activePlanId = surfaceRoot?.dataset.planId || '';
		const initialSurface = 'chat';
		const workspaceModals = Array.from(document.querySelectorAll('[data-workspace-modal]'));
		const openWorkspaceModal = modalName => {
			const modal = workspaceModals.find(candidate => candidate.dataset.workspaceModal === modalName);
			if (!modal) return;
			for (const candidate of workspaceModals) {
				if (candidate !== modal && candidate.open) candidate.close();
			}
			if (!modal.open) modal.showModal();
			persistUiState({ modal: modalName, planId: activePlanId });
		};
		for (const target of document.querySelectorAll('[data-modal-open]')) target.addEventListener('click', () => {
				openWorkspaceModal(target.dataset.modalOpen);
				target.closest('details')?.removeAttribute('open');
			});
		for (const close of document.querySelectorAll('[data-modal-close]')) close.addEventListener('click', () => {
			const modal = close.closest('[data-workspace-modal]');
			if (modal?.open) modal.close();
			persistUiState({ modal: '' });
		});
		for (const modal of workspaceModals) modal.addEventListener('close', () => {
			persistUiState({ modal: '' });
		});
		const serverInitialModal = surfaceRoot?.dataset.initialModal || '';
		const initialModal = serverInitialModal || (typeof persistedState.modal === 'string' ? persistedState.modal : '');
		if (initialModal) openWorkspaceModal(initialModal);
		const providerModal = document.querySelector('[data-provider-modal]');
		const providerForm = providerModal?.querySelector('[data-provider-form]');
		const providerIdField = providerForm?.querySelector('[name="providerId"]');
		const providerLabelField = providerForm?.querySelector('[name="profileLabel"]');
		const providerModelField = providerForm?.querySelector('[name="model"]');
		const providerBaseUrlField = providerForm?.querySelector('[name="baseUrl"]');
		const providerSecretField = providerForm?.querySelector('[name="secret"]');
		const providerSecretContainer = providerForm?.querySelector('[data-provider-secret-field]');
		const providerDetail = providerForm?.querySelector('[data-provider-detail]');
		const providerError = providerForm?.querySelector('[data-provider-error]');
		const syncProviderDefinition = () => {
			const selected = providerIdField?.selectedOptions?.[0];
			if (!selected) return;
			if (providerLabelField) providerLabelField.value = selected.dataset.label || '';
			if (providerBaseUrlField) providerBaseUrlField.value = selected.dataset.baseUrl || '';
			if (providerSecretField) {
				providerSecretField.value = '';
				providerSecretField.required = selected.dataset.requiresSecret === 'true';
			}
			if (providerSecretContainer) providerSecretContainer.hidden = selected.dataset.requiresSecret !== 'true';
			if (providerDetail) providerDetail.textContent = selected.dataset.detail || '';
			if (providerError) providerError.hidden = true;
		};
		const openProviderModal = () => {
			for (const candidate of workspaceModals) if (candidate.open) candidate.close();
			syncProviderDefinition();
			if (providerModal && !providerModal.open) providerModal.showModal();
			providerModelField?.focus();
		};
		for (const button of document.querySelectorAll('[data-provider-modal-open]')) button.addEventListener('click', () => {
			button.closest('details')?.removeAttribute('open');
			openProviderModal();
		});
		for (const button of document.querySelectorAll('[data-provider-modal-close]')) button.addEventListener('click', () => providerModal?.close());
		providerIdField?.addEventListener('change', syncProviderDefinition);
		providerForm?.addEventListener('submit', event => {
			event.preventDefault();
			const providerId = providerIdField?.value || '';
			const profileLabel = providerLabelField?.value?.trim() || '';
			const model = providerModelField?.value?.trim() || '';
			const baseUrl = providerBaseUrlField?.value?.trim() || '';
			const secret = providerSecretField?.value || undefined;
			const selected = providerIdField?.selectedOptions?.[0];
			const requiresSecret = selected?.dataset.requiresSecret === 'true';
			if (!providerId || !profileLabel || !model || !baseUrl || (requiresSecret && !secret)) {
				if (providerError) {
					providerError.textContent = 'Complete the required model fields.';
					providerError.hidden = false;
				}
				return;
			}
			const submit = providerForm.querySelector('button[type="submit"]');
			if (submit) submit.disabled = true;
			postUi('configureProviderProfile', { providerId, profileLabel, baseUrl, model, ...(secret ? { secret } : {}) });
			if (providerSecretField) providerSecretField.value = '';
			providerModal?.close();
		});
		const chatPlanDetails = document.querySelector('[data-chat-plan-details]');
		if (chatPlanDetails) {
			const planStateMatches = persistedState.chatPlanId === activePlanId;
			if (planStateMatches && typeof persistedState.chatPlanOpen === 'boolean') {
				chatPlanDetails.open = persistedState.chatPlanOpen;
			}
			const saveChatPlanState = () => persistUiState({ chatPlanId: activePlanId, chatPlanOpen: chatPlanDetails.open });
			chatPlanDetails.addEventListener('toggle', saveChatPlanState);
			if (!planStateMatches) saveChatPlanState();
		}
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
				postUi('createPlan', { specification });
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
			const planPromptField = planProposalForm.querySelector('[name="prompt"]');
			const planProviderField = planProposalForm.querySelector('[name="providerName"]');
			const planMemoryField = planProposalForm.querySelector('[name="memoryMode"]');
			const planContextField = planProposalForm.querySelector('[name="contextMaxCharacters"]');
			const planOutputField = planProposalForm.querySelector('[name="maxOutputTokens"]');
			if (planPromptField && typeof persistedState.planDraft === 'string') planPromptField.value = persistedState.planDraft;
			if (planProviderField && Array.from(planProviderField.options).some(option => option.value === persistedState.planProvider)) planProviderField.value = persistedState.planProvider;
			if (planMemoryField && ['auto', 'off', 'required'].includes(persistedState.planMemoryMode)) planMemoryField.value = persistedState.planMemoryMode;
			if (planContextField && Number.isSafeInteger(persistedState.planContextBudget)) planContextField.value = String(persistedState.planContextBudget);
			if (planOutputField && Number.isSafeInteger(persistedState.planOutputBudget)) planOutputField.value = String(persistedState.planOutputBudget);
			if (typeof persistedState.planNetworkConsent === 'boolean') planNetworkConsent.checked = persistedState.planNetworkConsent;
			const savePlanComposer = () => persistUiState({
				planDraft: planPromptField?.value || '',
				planProvider: planProviderField?.value || '',
				planMemoryMode: planMemoryField?.value || 'auto',
				planContextBudget: Number(planContextField?.value),
				planOutputBudget: Number(planOutputField?.value),
				planNetworkConsent: Boolean(planNetworkConsent.checked)
			});
			for (const input of [planPromptField, planProviderField, planMemoryField, planContextField, planOutputField, planNetworkConsent]) input?.addEventListener(input === planPromptField ? 'input' : 'change', savePlanComposer);
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
				persistUiState({ planDraft: '', planNetworkConsent: false });
				postUi('proposePlan', { providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, composerMode: 'plan', allowNetwork: true });
			});
		}
		document.querySelector('[data-plan-refresh]')?.addEventListener('click', () => postUi('refreshPlan'));
		document.querySelector('[data-plan-new]')?.addEventListener('click', () => postUi('newPlan'));
		document.querySelector('[data-plan-restore]')?.addEventListener('click', () => postUi('restorePlan'));
		document.querySelectorAll('[data-plan-action]').forEach(button => button.addEventListener('click', () => postUi('planAction', { action: button.dataset.planAction, stepId: button.dataset.planActionStep })));
		document.querySelectorAll('[data-project-action]').forEach(button => button.addEventListener('click', () => {
			const action = button.dataset.projectAction;
			if (action === 'resume') {
				const goal = document.querySelector('[data-project-resume-goal]')?.value;
				const providerName = document.querySelector('[name="providerName"]')?.value;
				postUi('projectAction', { action, providerName, ...(goal?.trim() ? { goal } : {}) });
				return;
			}
			postUi('projectAction', { action });
		}));
		document.querySelector('[data-project-show-plan]')?.addEventListener('click', () => {
			const details = document.querySelector('[data-chat-plan-details]');
			if (details) {
				details.open = true;
				details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}
		});
		document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => postUi('openCommand', { command: button.dataset.command })));
		document.querySelector('[data-action="refresh-providers"]')?.addEventListener('click', () => postUi('refreshProviders'));
		document.querySelectorAll('[data-provider-test]').forEach(button => button.addEventListener('click', () => postUi('testProvider', { providerName: button.dataset.providerTest })));
		document.querySelectorAll('[data-provider-remove]').forEach(button => button.addEventListener('click', () => postUi('removeProvider', { providerName: button.dataset.providerRemove })));
		document.querySelector('[data-agent-cancel]')?.addEventListener('click', () => postUi('cancelAgent'));
		document.querySelector('[data-conversation-clear]')?.addEventListener('click', () => postUi('clearConversation'));
		document.querySelector('[data-conversation-restore]')?.addEventListener('click', () => postUi('restoreConversation'));
		document.querySelectorAll('[data-copy-message]').forEach(button => button.addEventListener('click', () => {
			const messageId = button.dataset.copyMessage || '';
			if (messageId) {
				postUi('copyConversationMessage', { messageId });
				showCopiedState(button);
			}
		}));
		document.querySelectorAll('[data-copy-code]').forEach(button => button.addEventListener('click', () => {
			const content = button.closest('.message-code')?.querySelector('code')?.textContent || '';
			if (content) {
				postUi('copyText', { text: content });
				showCopiedState(button);
			}
		}));
		document.querySelectorAll('[data-review-diff]').forEach(button => button.addEventListener('click', () => {
			const content = button.closest('.message-code')?.querySelector('code')?.textContent || '';
			if (content) postUi('reviewDiff', { content });
		}));
		document.querySelectorAll('[data-open-file]').forEach(button => button.addEventListener('click', () => postUi('openFile', { path: button.dataset.openFile })));
		document.querySelectorAll('[data-open-external]').forEach(button => button.addEventListener('click', () => postUi('openExternal', { url: button.dataset.openExternal })));
		document.querySelector('[data-receipts-refresh]')?.addEventListener('click', () => postUi('refreshReceipts'));
		document.querySelector('[data-statistics-refresh]')?.addEventListener('click', () => postUi('refreshStatistics'));
		const agentForm = document.querySelector('[data-agent-form]');
		const runButton = document.querySelector('[data-agent-run]');
		const planButton = document.querySelector('[data-agent-plan]');
		const promptField = agentForm?.querySelector('[name="prompt"]');
		const chatModeField = agentForm?.querySelector('[name="chatMode"]');
		const composerModeHelp = agentForm?.querySelector('[data-composer-mode-help]');
		const providerField = agentForm?.querySelector('[name="providerName"]');
		const memoryModeField = agentForm?.querySelector('[name="memoryMode"]');
		const contextBudgetField = agentForm?.querySelector('[name="contextMaxCharacters"]');
		const outputBudgetField = agentForm?.querySelector('[name="maxOutputTokens"]');
		const agentPicker = agentForm?.querySelector('[data-agent-picker]');
		const parallelToggleButton = agentForm?.querySelector('[data-parallel-toggle]');
		const selectedAgentFields = Array.from(agentForm?.querySelectorAll('[name="selectedAgentId"]') ?? []);
		const maxConcurrencyField = agentForm?.querySelector('[name="maxConcurrency"]');
		const singleProviderField = agentForm?.querySelector('[data-single-provider]');
		const attachmentInput = agentForm?.querySelector('[data-attachment-input]');
		const folderInput = agentForm?.querySelector('[data-folder-input]');
		const attachFilesButton = agentForm?.querySelector('[data-attach-files]');
		const attachFolderButton = agentForm?.querySelector('[data-attach-folder]');
		const attachmentTray = agentForm?.querySelector('[data-composer-attachments]');
		const composerStatus = agentForm?.querySelector('.composer-status');
		let imageAttachments = [];
		let textFileAttachments = [];
		let attachmentReadCount = 0;
		let updateRunButton = () => undefined;
		const syncTransientAttachmentState = () => postUi('setComposerAttachmentState', {
			hasAttachments: attachmentReadCount > 0 || imageAttachments.length > 0 || textFileAttachments.length > 0
		});
		const imageLimits = { count: 4, each: 393216, total: 524288 };
		const textFileLimits = { count: 10, each: 98304, total: 393216 };
		const textFileExtensions = new Set([
			'.bash', '.bat', '.c', '.cc', '.cfg', '.cjs', '.cmd', '.conf', '.cpp', '.cs', '.css', '.cts', '.dart',
			'.fish', '.fs', '.fsx', '.go', '.h', '.hpp', '.htm', '.html', '.ini', '.java', '.js', '.json', '.jsonc',
			'.jsx', '.kt', '.kts', '.less', '.md', '.mdx', '.mjs', '.mts', '.php', '.ps1', '.psm1', '.py', '.pyi',
			'.rb', '.rs', '.sass', '.scss', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml',
			'.yml', '.zsh'
		]);
		const extensionlessTextFiles = new Set(['containerfile', 'dockerfile', 'gemfile', 'makefile', 'procfile', 'readme']);
		const setComposerStatus = message => {
			if (composerStatus) composerStatus.textContent = message;
		};
		const renderImageAttachments = () => {
			if (!attachmentTray) return;
			attachmentTray.hidden = imageAttachments.length === 0;
			attachmentTray.replaceChildren(...imageAttachments.map((attachment, index) => {
				const figure = document.createElement('figure');
				figure.className = 'composer-attachment';
				const image = document.createElement('img');
				image.src = attachment.dataUrl;
				image.alt = attachment.name;
				const caption = document.createElement('figcaption');
				caption.textContent = attachment.name;
				const remove = document.createElement('button');
				remove.type = 'button';
				remove.setAttribute('aria-label', 'Remove ' + attachment.name);
				remove.title = 'Remove image';
				remove.textContent = '×';
				remove.addEventListener('click', () => {
					imageAttachments = imageAttachments.filter((_, candidateIndex) => candidateIndex !== index);
					renderAttachments();
				});
				figure.append(image, caption, remove);
				return figure;
			}));
		};
		const renderAttachments = () => {
			renderImageAttachments();
			if (!attachmentTray) return;
			for (const [index, attachment] of textFileAttachments.entries()) {
				const item = document.createElement('article');
				item.className = 'composer-attachment file';
				const icon = document.createElement('span');
				icon.className = 'composer-file-icon';
				const extension = attachment.name.includes('.') ? attachment.name.split('.').at(-1) : 'FILE';
				icon.textContent = String(extension || 'FILE').slice(0, 4).toUpperCase();
				const copy = document.createElement('span');
				copy.className = 'composer-file-copy';
				const name = document.createElement('strong');
				name.textContent = attachment.relativePath;
				name.title = attachment.relativePath;
				const size = document.createElement('span');
				size.textContent = Math.max(1, Math.round(attachment.sizeBytes / 1024)) + ' KB';
				copy.append(name, size);
				const remove = document.createElement('button');
				remove.type = 'button';
				remove.setAttribute('aria-label', 'Remove ' + attachment.relativePath);
				remove.title = 'Remove file';
				remove.textContent = '×';
				remove.addEventListener('click', () => {
					textFileAttachments = textFileAttachments.filter((_, candidateIndex) => candidateIndex !== index);
					renderAttachments();
				});
				item.append(icon, copy, remove);
				attachmentTray.append(item);
			}
			attachmentTray.hidden = imageAttachments.length === 0 && textFileAttachments.length === 0;
			syncTransientAttachmentState();
		};
		const readAsDataUrl = blob => new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.addEventListener('load', () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Image could not be read.')));
			reader.addEventListener('error', () => reject(reader.error ?? new Error('Image could not be read.')));
			reader.readAsDataURL(blob);
		});
		const loadImage = dataUrl => new Promise((resolve, reject) => {
			const image = new Image();
			image.addEventListener('load', () => resolve(image), { once: true });
			image.addEventListener('error', () => reject(new Error('Image could not be decoded.')), { once: true });
			image.src = dataUrl;
		});
		const canvasBlob = (canvas, quality) => new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
		const normalizeImage = async file => {
			const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
			if (!allowed.includes(file.type)) throw new Error('Use a PNG, JPEG, WebP, or GIF image.');
			if (file.size <= imageLimits.each) {
				return { name: file.name || 'pasted-image', sizeBytes: file.size, dataUrl: await readAsDataUrl(file) };
			}
			const originalUrl = await readAsDataUrl(file);
			const source = await loadImage(originalUrl);
			let scale = Math.min(1, 1600 / Math.max(source.naturalWidth, source.naturalHeight));
			for (let attempt = 0; attempt < 6; attempt += 1) {
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
				canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
				const context = canvas.getContext('2d', { alpha: true });
				if (!context) throw new Error('Image processing is unavailable in this editor.');
				context.drawImage(source, 0, 0, canvas.width, canvas.height);
				for (const quality of [.84, .72, .6, .48]) {
					const blob = await canvasBlob(canvas, quality);
					if (blob && blob.size <= imageLimits.each) {
						const name = (file.name || 'pasted-image').replace(/\.[^.]+$/, '') + '.webp';
						return { name, sizeBytes: blob.size, dataUrl: await readAsDataUrl(blob) };
					}
				}
				scale *= .72;
			}
			throw new Error('This image is too large after safe compression.');
		};
		const addImageFiles = async files => {
			const candidates = Array.from(files ?? []);
			if (imageAttachments.length + candidates.length > imageLimits.count) throw new Error('Attach up to four images per message.');
			const normalized = [];
			for (const file of candidates) normalized.push(await normalizeImage(file));
			const total = [...imageAttachments, ...normalized].reduce((sum, item) => sum + item.sizeBytes, 0);
			if (total > imageLimits.total) throw new Error('Images must use 512 KB or less in total.');
			imageAttachments = [...imageAttachments, ...normalized];
			renderAttachments();
			promptField?.focus();
		};
		const safeRelativePath = (file, suppliedPath) => {
			const value = String(suppliedPath || file.name || '').replaceAll('\\', '/');
			const parts = value.split('/');
			if (!value || value.length > 512 || value.startsWith('/') || value.endsWith('/') || parts.at(-1) !== file.name || parts.some(part => !part || part === '.' || part === '..')) {
				throw new Error('A selected file has an unsafe relative path.');
			}
			return value;
		};
		const isAllowedTextFile = file => {
			const name = String(file.name || '').toLowerCase();
			if (!name || /^\.env(?:\.|$)/u.test(name) || /^\.(?:netrc|npmrc|pypirc)$/u.test(name) || /^credentials(?:\.|$)/u.test(name) || /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.|$)/u.test(name) || /\.(?:jks|key|p12|pem|pfx)$/u.test(name)) return false;
			const extensionIndex = name.lastIndexOf('.');
			return extensionlessTextFiles.has(name) || (extensionIndex >= 0 && textFileExtensions.has(name.slice(extensionIndex)));
		};
		const normalizeTextFile = async item => {
			const file = item.file;
			if (!isAllowedTextFile(file)) throw new Error('Use a supported text or code file. Credential and key files are blocked.');
			if (file.size < 1 || file.size > textFileLimits.each) throw new Error('Each text file must be between 1 byte and 96 KB.');
			const relativePath = safeRelativePath(file, item.relativePath);
			const text = await file.text();
			if (text.includes('\u0000') || new TextEncoder().encode(text).byteLength !== file.size) throw new Error('The selected file is not canonical UTF-8 text.');
			return { name: file.name, relativePath, mimeType: 'text/plain', text, sizeBytes: file.size };
		};
		const addTextFiles = async items => {
			if (textFileAttachments.length + items.length > textFileLimits.count) throw new Error('Attach up to ten text files per message.');
			const normalized = [];
			for (const item of items) normalized.push(await normalizeTextFile(item));
			const total = [...textFileAttachments, ...normalized].reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
			if (total > textFileLimits.total) throw new Error('Text files must use 384 KB or less in total.');
			const knownPaths = new Set(textFileAttachments.map(candidate => candidate.relativePath));
			textFileAttachments = [...textFileAttachments, ...normalized.filter(candidate => !knownPaths.has(candidate.relativePath))];
		};
		const addMentionedFiles = files => {
			const incoming = Array.isArray(files) ? files : [];
			const knownPaths = new Set(textFileAttachments.map(candidate => candidate.relativePath));
			const normalized = incoming.filter(file => file && typeof file.name === 'string' && typeof file.relativePath === 'string' && typeof file.text === 'string' && file.mimeType === 'text/plain' && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 && file.sizeBytes <= textFileLimits.each && new TextEncoder().encode(file.text).byteLength === file.sizeBytes && !knownPaths.has(file.relativePath));
			if (textFileAttachments.length + normalized.length > textFileLimits.count || [...textFileAttachments, ...normalized].reduce((sum, file) => sum + file.sizeBytes, 0) > textFileLimits.total) {
				setComposerStatus('Mention up to ten text files using 384 KB or less in total.');
				return;
			}
			textFileAttachments = [...textFileAttachments, ...normalized];
			if (promptField && normalized.length > 0) {
				const mentions = normalized.map(file => '@' + file.relativePath).join(' ');
				const before = promptField.value;
				promptField.value = /(^|\s)@$/.test(before) ? before.replace(/@$/, mentions + ' ') : before + (before && !/\s$/.test(before) ? ' ' : '') + mentions + ' ';
				promptField.dispatchEvent(new Event('input', { bubbles: true }));
			}
			renderAttachments();
			setComposerStatus(normalized.length + (normalized.length === 1 ? ' file mentioned.' : ' files mentioned.'));
			promptField?.focus();
		};
		const addAttachmentItems = async items => {
			if (promptField?.disabled) return;
			const candidates = Array.from(items ?? []).filter(item => item?.file instanceof File);
			const imageItems = candidates.filter(item => item.file.type.startsWith('image/'));
			const textItems = candidates.filter(item => !item.file.type.startsWith('image/') && isAllowedTextFile(item.file));
			const unsupported = candidates.length - imageItems.length - textItems.length;
			if (imageItems.length === 0 && textItems.length === 0) {
				setComposerStatus('No supported image, text, or code files were found.');
				return;
			}
			attachmentReadCount += 1;
			syncTransientAttachmentState();
			updateRunButton();
			try {
				if (imageItems.length > 0) await addImageFiles(imageItems.map(item => item.file));
				if (textItems.length > 0) await addTextFiles(textItems);
				renderAttachments();
				const count = imageAttachments.length + textFileAttachments.length;
				setComposerStatus(count + (count === 1 ? ' attachment ready.' : ' attachments ready.') + (unsupported > 0 ? ' ' + unsupported + ' unsupported item(s) skipped.' : ''));
				promptField?.focus();
			} catch (error) {
				setComposerStatus(error instanceof Error ? error.message : 'File attachment failed.');
			} finally {
				attachmentReadCount = Math.max(0, attachmentReadCount - 1);
				syncTransientAttachmentState();
				updateRunButton();
			}
		};
		const selectedItems = files => Array.from(files ?? []).map(file => ({ file, relativePath: file.webkitRelativePath || file.name }));
		const readEntryFile = entry => new Promise((resolve, reject) => entry.file(resolve, reject));
		const readDirectoryBatch = reader => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
		const collectEntryFiles = async (entry, results) => {
			if (!entry || results.length >= 64) return;
			if (entry.isFile) {
				const file = await readEntryFile(entry);
				results.push({ file, relativePath: String(entry.fullPath || file.name).replace(/^\/+/, '') });
				return;
			}
			if (!entry.isDirectory) return;
			const reader = entry.createReader();
			for (;;) {
				const batch = await readDirectoryBatch(reader);
				if (batch.length === 0) break;
				for (const child of batch) {
					await collectEntryFiles(child, results);
					if (results.length >= 64) return;
				}
			}
		};
		const droppedItems = async transfer => {
			const results = [];
			const entries = Array.from(transfer?.items ?? []).map(item => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : undefined).filter(Boolean);
			if (entries.length > 0) {
				for (const entry of entries) await collectEntryFiles(entry, results);
				return results;
			}
			return selectedItems(transfer?.files);
		};
		const readTransferData = (transfer, expectedType) => {
			const actualType = Array.from(transfer?.types ?? []).find(type => type.toLowerCase() === expectedType.toLowerCase());
			return actualType ? transfer.getData(actualType) : '';
		};
		const droppedResourceUris = transfer => {
			const resources = [];
			const encodedResources = readTransferData(transfer, 'ResourceURLs');
			if (encodedResources) {
				try {
					const parsed = JSON.parse(encodedResources);
					if (Array.isArray(parsed)) resources.push(...parsed.filter(value => typeof value === 'string'));
				} catch {
					// Fall through to the URI-list formats used by current desktop workbenches.
				}
			}
			const encodedCodeFiles = readTransferData(transfer, 'CodeFiles');
			if (encodedCodeFiles) {
				try {
					const parsed = JSON.parse(encodedCodeFiles);
					if (Array.isArray(parsed)) {
						for (const value of parsed) {
							if (typeof value !== 'string') continue;
							const normalized = value.replace(/\\/gu, '/');
							if (/^[a-zA-Z]:\//u.test(normalized)) resources.push(encodeURI('file:///' + normalized));
							else if (normalized.startsWith('/')) resources.push(encodeURI('file://' + normalized));
						}
					}
				} catch {
					// Ignore malformed workbench drag metadata and continue with URI-list data.
				}
			}
			for (const type of ['application/vnd.code.uri-list', 'text/uri-list']) {
				const value = readTransferData(transfer, type);
				if (!value) continue;
				resources.push(...value.split(/\r?\n/u).map(candidate => candidate.trim()).filter(candidate => candidate && !candidate.startsWith('#')));
			}
			return [...new Set(resources)].slice(0, 32);
		};
		const hasDroppableData = transfer => Array.from(transfer?.types ?? []).some(type => [
			'files',
			'resourceurls',
			'codefiles',
			'application/vnd.code.uri-list',
			'text/uri-list'
		].includes(type.toLowerCase()));
		const attachmentDetails = agentForm?.querySelector('.composer-attach');
		agentForm?.querySelector('[data-mention-workspace]')?.addEventListener('click', event => {
			event.currentTarget.closest('details')?.removeAttribute('open');
			postUi('pickMentionFiles', { source: 'workspace' });
		});
		agentForm?.querySelector('[data-mention-computer]')?.addEventListener('click', event => {
			event.currentTarget.closest('details')?.removeAttribute('open');
			postUi('pickMentionFiles', { source: 'computer' });
		});
		attachFilesButton?.addEventListener('click', () => {
			attachmentDetails?.removeAttribute('open');
			attachmentInput?.click();
		});
		attachFolderButton?.addEventListener('click', () => {
			attachmentDetails?.removeAttribute('open');
			folderInput?.click();
		});
		attachmentInput?.addEventListener('change', async () => {
			await addAttachmentItems(selectedItems(attachmentInput.files));
			attachmentInput.value = '';
		});
		folderInput?.addEventListener('change', async () => {
			await addAttachmentItems(selectedItems(folderInput.files));
			folderInput.value = '';
		});
		promptField?.addEventListener('paste', event => {
			const imageFiles = Array.from(event.clipboardData?.items ?? [])
				.filter(item => item.kind === 'file' && item.type.startsWith('image/'))
				.map(item => item.getAsFile())
				.filter(Boolean);
			if (imageFiles.length === 0) return;
			const pastedText = event.clipboardData?.getData('text/plain') || '';
			event.preventDefault();
			if (pastedText && promptField) {
				promptField.setRangeText(pastedText, promptField.selectionStart ?? promptField.value.length, promptField.selectionEnd ?? promptField.value.length, 'end');
				promptField.dispatchEvent(new Event('input', { bubbles: true }));
			}
			void addAttachmentItems(imageFiles.map(file => ({ file, relativePath: file.name })));
		});
		const dropTarget = document.querySelector('[data-agent-surface]') ?? agentForm;
		let dragDepth = 0;
		dropTarget?.addEventListener('dragenter', event => {
			if (!hasDroppableData(event.dataTransfer)) return;
			event.preventDefault();
			dragDepth += 1;
			dropTarget.classList.add('is-dropping');
		});
		dropTarget?.addEventListener('dragover', event => {
			if (!hasDroppableData(event.dataTransfer)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		});
		dropTarget?.addEventListener('dragleave', () => {
			dragDepth = Math.max(0, dragDepth - 1);
			if (dragDepth === 0) dropTarget.classList.remove('is-dropping');
		});
		dropTarget?.addEventListener('drop', event => {
			event.preventDefault();
			dragDepth = 0;
			dropTarget.classList.remove('is-dropping');
			const transfer = event.dataTransfer;
			const resourceUris = droppedResourceUris(transfer);
			void droppedItems(transfer)
				.then(items => {
					if (items.length > 0) return addAttachmentItems(items);
					if (resourceUris.length === 0) throw new Error('Drop supported workspace text or code files here.');
					setComposerStatus('Reading dropped workspace files…');
					postUi('attachDroppedResources', { resourceUris });
					return undefined;
				})
				.catch(error => setComposerStatus(error instanceof Error ? error.message : 'Dropped files could not be read.'));
		});
		if (promptField && typeof persistedState.chatDraft === 'string') promptField.value = persistedState.chatDraft;
		promptField?.addEventListener('input', event => {
			if (event instanceof InputEvent && event.inputType === 'insertText' && event.data === '@' && /(^|\s)@$/.test(promptField.value.slice(0, promptField.selectionStart ?? promptField.value.length))) {
				postUi('pickMentionFiles', { source: 'workspace' });
			}
		});
		window.addEventListener('message', event => {
			const message = event.data;
			if (message?.type === 'fikeya.composerFilesPicked') {
				addMentionedFiles(message.files);
				return;
			}
			if (message?.type === 'fikeya.composerRequestRejected' && message.requestId === (vscode.getState() || {}).pendingComposerRequestId) {
				persistUiState({ pendingComposerRequestId: '' });
				setComposerStatus(typeof message.message === 'string' ? message.message : 'Fikeya could not start this request.');
				if (runButton) runButton.disabled = !promptField?.value.trim();
				if (planButton) planButton.disabled = false;
				promptField?.focus();
			}
		});
		postUi('webviewReady');
		if (chatModeField && ['ask', 'plan', 'build', 'review', 'research'].includes(persistedState.chatMode)) chatModeField.value = persistedState.chatMode;
		if (providerField && Array.from(providerField.options).some(option => option.value === persistedState.chatProvider)) providerField.value = persistedState.chatProvider;
		const persistedAgentIds = Array.isArray(persistedState.chatAgentIds) ? persistedState.chatAgentIds : [];
		for (const input of selectedAgentFields) input.checked = persistedAgentIds.includes(input.value);
		if (memoryModeField && ['auto', 'off', 'required'].includes(persistedState.chatMemoryMode)) memoryModeField.value = persistedState.chatMemoryMode;
		if (contextBudgetField && Number.isSafeInteger(persistedState.chatContextBudget)) contextBudgetField.value = String(persistedState.chatContextBudget);
		if (outputBudgetField && Number.isSafeInteger(persistedState.chatOutputBudget)) outputBudgetField.value = String(persistedState.chatOutputBudget);
		if (maxConcurrencyField && Number.isSafeInteger(persistedState.chatAgentConcurrency) && persistedState.chatAgentConcurrency >= 1 && persistedState.chatAgentConcurrency <= 8) maxConcurrencyField.value = String(persistedState.chatAgentConcurrency);
		let parallelAgentsEnabled = persistedState.chatParallelAgents === true;
		const saveComposer = () => persistUiState({
			chatDraft: promptField?.value || '',
			chatMode: chatModeField?.value || 'build',
			chatAgentIds: selectedAgentFields.filter(input => input.checked).map(input => input.value),
			chatProvider: providerField?.value || '',
			chatMemoryMode: memoryModeField?.value || 'auto',
			chatContextBudget: Number(contextBudgetField?.value),
			chatOutputBudget: Number(outputBudgetField?.value),
			chatAgentConcurrency: Number(maxConcurrencyField?.value || 3),
			chatParallelAgents: parallelAgentsEnabled
		});
		for (const input of [promptField, chatModeField, providerField, memoryModeField, contextBudgetField, outputBudgetField, maxConcurrencyField, ...selectedAgentFields]) {
			input?.addEventListener(input === promptField ? 'input' : 'change', saveComposer);
		}
		const updateComposerMode = () => {
			const selectedMode = chatModeField?.selectedOptions?.[0];
			if (selectedMode?.value === 'plan') parallelAgentsEnabled = false;
			if (agentPicker) agentPicker.hidden = !parallelAgentsEnabled;
			parallelToggleButton?.setAttribute('aria-pressed', String(parallelAgentsEnabled));
			if (singleProviderField) {
				singleProviderField.hidden = false;
				singleProviderField.title = 'Model';
			}
			const count = selectedAgentFields.filter(input => input.checked).length;
			const countTarget = agentPicker?.querySelector('[data-agent-count]');
			if (countTarget) countTarget.textContent = String(count);
			if (promptField && selectedMode?.dataset.placeholder) promptField.placeholder = selectedMode.dataset.placeholder;
			if (composerModeHelp && selectedMode?.dataset.behavior) composerModeHelp.textContent = selectedMode.dataset.behavior;
		};
		chatModeField?.addEventListener('change', updateComposerMode);
		for (const input of selectedAgentFields) input.addEventListener('change', updateComposerMode);
		parallelToggleButton?.addEventListener('click', () => {
			if (chatModeField?.value === 'plan') {
				setComposerStatus('Parallel advisors are available in Ask, Build, Review, and Research modes.');
				return;
			}
			parallelAgentsEnabled = !parallelAgentsEnabled;
			saveComposer();
			updateComposerMode();
			parallelToggleButton.closest('details')?.removeAttribute('open');
			if (parallelAgentsEnabled) {
				agentPicker?.setAttribute('open', '');
				agentPicker?.querySelector('summary')?.focus();
			}
		});
		updateComposerMode();
		document.querySelectorAll('[data-prompt-value]').forEach(button => button.addEventListener('click', () => {
			if (!promptField) return;
			promptField.value = button.dataset.promptValue ?? '';
			saveComposer();
			promptField.dispatchEvent(new Event('input', { bubbles: true }));
			promptField.focus();
		}));
		if (agentForm && runButton) {
			const runBlocked = runButton.disabled;
			const readAgentRequest = () => {
				const providerName = agentForm.querySelector('[name="providerName"]')?.value;
				const prompt = agentForm.querySelector('[name="prompt"]')?.value;
				const composerMode = chatModeField?.value;
				const maxOutputTokens = Number(agentForm.querySelector('[name="maxOutputTokens"]')?.value);
				const contextMaxCharacters = Number(agentForm.querySelector('[name="contextMaxCharacters"]')?.value);
				const memoryMode = agentForm.querySelector('[name="memoryMode"]')?.value;
				if (!providerName || !prompt?.trim() || !['ask', 'plan', 'build', 'review', 'research'].includes(composerMode) || !Number.isSafeInteger(maxOutputTokens) || !Number.isSafeInteger(contextMaxCharacters) || !['auto', 'off', 'required'].includes(memoryMode)) return undefined;
				return { providerName, prompt, maxOutputTokens, contextMaxCharacters, memoryMode, composerMode, images: imageAttachments, files: textFileAttachments, allowNetwork: true };
			};
			updateRunButton = () => {
				runButton.disabled = runBlocked || attachmentReadCount > 0 || !promptField?.value.trim();
			};
			const setRunButtonsDisabled = disabled => {
				runButton.disabled = disabled;
				if (planButton) planButton.disabled = disabled;
			};
			const executeAgentAction = action => {
				if (attachmentReadCount > 0) {
					setComposerStatus('Wait for attachments to finish processing before sending.');
					return;
				}
				if (!providerField?.value) {
					postUi('openCommand', { command: 'fikeya.configureProvider' });
					return;
				}
				const selectedAgentIds = selectedAgentFields.filter(input => input.checked).map(input => input.value);
				if (action === 'multitask' && (imageAttachments.length > 0 || textFileAttachments.length > 0)) {
					setComposerStatus('Remove attachments before starting a parallel advisory run.');
					return;
				}
				if (action === 'project' && (imageAttachments.length > 0 || textFileAttachments.length > 0)) {
					setComposerStatus('Remove attachments before starting an audited project. The durable goal is sent as bounded JSON-lines input.');
					return;
				}
				if (action === 'multitask' && selectedAgentIds.length === 0) {
					postUi('openCommand', { command: 'fikeya.configureAgents' });
					return;
				}
				const baseRequest = readAgentRequest();
				const request = action === 'project' && baseRequest
					? { providerName: baseRequest.providerName, goal: baseRequest.prompt, allowNetwork: true }
					: action === 'multitask' && baseRequest
					? {
						selectedAgentIds,
						leadProviderName: baseRequest.providerName,
						prompt: baseRequest.prompt,
						composerMode: baseRequest.composerMode,
						maxConcurrency: Number(maxConcurrencyField?.value || 3),
						maxOutputTokens: baseRequest.maxOutputTokens,
						contextMaxCharacters: baseRequest.contextMaxCharacters,
						memoryMode: baseRequest.memoryMode,
						allowNetwork: true
					}
					: baseRequest;
				if (!request || (!request.prompt && !request.goal)) {
					promptField?.focus();
					return;
				}
				setRunButtonsDisabled(true);
				const requestId = typeof crypto.randomUUID === 'function'
					? crypto.randomUUID().replaceAll('-', '')
					: 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
				persistUiState({ chatDraft: promptField?.value || '', pendingComposerRequestId: requestId });
				const actionType = action === 'project' ? 'startProject' : action === 'plan' ? 'proposePlan' : action === 'multitask' ? 'runMultiAgent' : 'runAgent';
				postUi(actionType, { ...request, requestId });
			};
			agentForm.addEventListener('submit', event => {
				event.preventDefault();
				executeAgentAction(chatModeField?.value === 'plan' ? 'plan' : parallelAgentsEnabled ? 'multitask' : 'run');
			});
			planButton?.addEventListener('click', () => {
				executeAgentAction('plan');
			});
			runButton.addEventListener('click', () => {
				executeAgentAction(chatModeField?.value === 'plan' ? 'plan' : parallelAgentsEnabled ? 'multitask' : 'run');
			});
			document.querySelector('[data-audited-project-run]')?.addEventListener('click', () => executeAgentAction('project'));
			document.querySelector('[data-draft-plan-only]')?.addEventListener('click', () => executeAgentAction('plan'));
			for (const input of [promptField, chatModeField, providerField]) input?.addEventListener(input === promptField ? 'input' : 'change', () => {
				updateRunButton();
			});
			promptField?.addEventListener('keydown', event => {
				if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
				event.preventDefault();
				agentForm.requestSubmit();
			});
			updateRunButton();
		}
		const chatThread = document.querySelector('[data-chat-thread]');
		if (chatThread) {
			const messageCount = Number(chatThread.dataset.messageCount || 0);
			chatThread.scrollTop = persistedState.chatMessageCount === messageCount && Number.isFinite(persistedState.chatScrollTop)
				? persistedState.chatScrollTop
				: chatThread.scrollHeight;
			persistUiState({ chatMessageCount: messageCount, chatScrollTop: chatThread.scrollTop });
			chatThread.addEventListener('scroll', () => persistUiState({ chatMessageCount: messageCount, chatScrollTop: chatThread.scrollTop }));
		}
		if (Number.isFinite(persistedState.pageScrollY)) window.scrollTo(0, persistedState.pageScrollY);
		window.addEventListener('scroll', () => persistUiState({ pageScrollY: window.scrollY }), { passive: true });
		document.addEventListener('focusin', event => {
			const element = event.target;
			if (!(element instanceof HTMLElement)) return;
			const name = element.getAttribute('name');
			const graphSearch = element.hasAttribute('data-graph-search');
			if (name || graphSearch) persistUiState({ focusTarget: graphSearch ? 'graph-search' : name, focusSurface: initialSurface });
		});
		if (persistedState.focusSurface === initialSurface) {
			const focusTarget = persistedState.focusTarget === 'graph-search'
				? document.querySelector('[data-graph-search]')
				: ['prompt', 'chatMode', 'providerName', 'memoryMode', 'contextMaxCharacters', 'maxOutputTokens'].includes(persistedState.focusTarget)
					? document.querySelector('[data-surface-panel="' + initialSurface + '"] [name="' + persistedState.focusTarget + '"]')
					: null;
			focusTarget?.focus({ preventScroll: true });
		}
		document.querySelectorAll('[data-memory-refresh]').forEach(button => button.addEventListener('click', () => postUi('refreshMemory')));
		const graphDataElement = document.getElementById('fikeya-memory-graph-data');
		const graphSvg = document.querySelector('[data-memory-graph]');
		if (graphDataElement && graphSvg) {
			const graph = JSON.parse(graphDataElement.textContent);
			const graphRoot = graphSvg.closest('.memory-graph');
			const scene = graphSvg.querySelector('[data-graph-scene]');
			const edgeLayer = graphSvg.querySelector('[data-graph-edges]');
			const nodeLayer = graphSvg.querySelector('[data-graph-nodes]');
			const hit = graphSvg.querySelector('[data-graph-hit]');
			const search = document.querySelector('[data-graph-search]');
			const typeFilter = document.querySelector('[data-graph-type]');
			const relationFilter = document.querySelector('[data-graph-relation]');
			const summary = document.querySelector('[data-graph-summary]');
			const results = document.querySelector('[data-graph-results]');
			const openSource = document.querySelector('[data-graph-open-source]');
			const fullView = document.querySelector('[data-graph-full-view]');
			const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
			const colors = {
				worktree: 'var(--vscode-charts-red)',
				memory: 'var(--vscode-charts-green)',
				file: 'var(--vscode-charts-blue)',
				concept: 'var(--vscode-charts-purple)',
				directory: 'var(--vscode-charts-yellow)',
				reference: 'var(--vscode-descriptionForeground)'
			};
			const savedGraph = persistedState.graphState && typeof persistedState.graphState === 'object' ? persistedState.graphState : {};
			const positions = new Map(Object.entries(savedGraph.positions || {}).filter(([, point]) => point && Number.isFinite(point.x) && Number.isFinite(point.y)).slice(0, 100));
			let pan = savedGraph.pan && Number.isFinite(savedGraph.pan.x) && Number.isFinite(savedGraph.pan.y) ? savedGraph.pan : { x: 0, y: 0 };
			let zoom = Number.isFinite(savedGraph.zoom) ? Math.max(.55, Math.min(2.5, savedGraph.zoom)) : 1;
			let selectedId = typeof savedGraph.selectedId === 'string' && nodeById.has(savedGraph.selectedId) ? savedGraph.selectedId : null;
			let pointerState = null;
			if (search && typeof savedGraph.search === 'string') search.value = savedGraph.search;
			if (typeFilter && Array.from(typeFilter.options).some(option => option.value === savedGraph.type)) typeFilter.value = savedGraph.type;
			if (relationFilter && Array.from(relationFilter.options).some(option => option.value === savedGraph.relation)) relationFilter.value = savedGraph.relation;
			const saveGraphState = () => persistUiState({ graphState: {
				search: search?.value || '', type: typeFilter?.value || 'all', relation: relationFilter?.value || 'all', pan, zoom, selectedId,
				positions: Object.fromEntries(Array.from(positions.entries()).slice(0, 100))
			} });
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
				if (openSource) {
					openSource.hidden = !(node.type === 'file' && typeof node.path === 'string' && node.path.length > 0);
					openSource.dataset.openSource = openSource.hidden ? '' : node.path;
				}
				document.querySelectorAll('.graph-node').forEach(element => { element.dataset.selected = String(element.dataset.nodeId === node.id); });
				saveGraphState();
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
				if (results) {
					results.textContent = '';
					for (const node of visible) {
						const item = document.createElement('li');
						const button = document.createElement('button');
						button.type = 'button';
						button.dataset.graphResult = node.id;
						const label = document.createElement('span'); label.textContent = node.label;
						const kind = document.createElement('small'); kind.textContent = node.type;
						button.append(label, kind);
						button.addEventListener('click', () => { showNode(node); nodeLayer.querySelector('[data-node-id="' + CSS.escape(node.id) + '"]')?.focus(); });
						item.append(button); results.append(item);
					}
				}
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
			const finishPointer = event => { if (!pointerState || pointerState.pointerId !== event.pointerId) return; hit.dataset.panning = 'false'; nodeLayer.querySelectorAll('.graph-node').forEach(node => { node.dataset.dragging = 'false'; }); try { graphSvg.releasePointerCapture(event.pointerId); } catch {} pointerState = null; saveGraphState(); };
			graphSvg.addEventListener('pointerup', finishPointer); graphSvg.addEventListener('pointercancel', finishPointer);
			graphSvg.addEventListener('wheel', event => { event.preventDefault(); const point = pointFromEvent(event); const next = Math.max(.55, Math.min(2.5, zoom * (event.deltaY < 0 ? 1.12 : .89))); const world = { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom }; zoom = next; pan = { x: point.x - world.x * zoom, y: point.y - world.y * zoom }; applyScene(); saveGraphState(); }, { passive: false });
			document.querySelector('[data-graph-zoom-in]')?.addEventListener('click', () => { zoom = Math.min(2.5, zoom * 1.2); applyScene(); saveGraphState(); });
			document.querySelector('[data-graph-zoom-out]')?.addEventListener('click', () => { zoom = Math.max(.55, zoom / 1.2); applyScene(); saveGraphState(); });
			document.querySelector('[data-graph-reset]')?.addEventListener('click', () => { positions.clear(); pan = { x: 0, y: 0 }; zoom = 1; selectedId = null; applyScene(); renderGraph(); saveGraphState(); });
			openSource?.addEventListener('click', () => { if (openSource.dataset.openSource) postUi('openFile', { path: openSource.dataset.openSource }); });
			fullView?.addEventListener('click', () => { const expanded = graphRoot?.dataset.expanded !== 'true'; if (graphRoot) graphRoot.dataset.expanded = String(expanded); fullView.setAttribute('aria-pressed', String(expanded)); fullView.textContent = expanded ? 'Exit full view' : 'Full view'; persistUiState({ graphExpanded: expanded }); });
			if (graphRoot && persistedState.graphExpanded === true) { graphRoot.dataset.expanded = 'true'; fullView?.setAttribute('aria-pressed', 'true'); if (fullView) fullView.textContent = 'Exit full view'; }
			document.addEventListener('keydown', event => { if (event.key === 'Escape' && graphRoot?.dataset.expanded === 'true') { graphRoot.dataset.expanded = 'false'; fullView?.setAttribute('aria-pressed', 'false'); if (fullView) fullView.textContent = 'Full view'; persistUiState({ graphExpanded: false }); fullView?.focus(); } });
			const refreshGraph = () => { renderGraph(); saveGraphState(); };
			search?.addEventListener('input', refreshGraph); typeFilter?.addEventListener('change', refreshGraph); relationFilter?.addEventListener('change', refreshGraph); applyScene(); renderGraph();
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
			<div class="actions"><button class="secondary" data-graph-zoom-in type="button" aria-label="${escapeHtml(strings.zoomIn)}">+</button><button class="secondary" data-graph-zoom-out type="button" aria-label="${escapeHtml(strings.zoomOut)}">-</button><button class="secondary" data-graph-reset type="button">${escapeHtml(strings.reset)}</button><button class="secondary" data-graph-full-view type="button" aria-pressed="false">${escapeHtml(vscode.l10n.t('Full view'))}</button></div>
		</div>
		<div class="graph-workspace"><div class="graph-viewport"><svg class="graph-canvas" data-memory-graph viewBox="0 0 800 480" role="img" aria-label="${escapeHtml(strings.memoryGraphAria)}"><rect class="graph-hit" data-graph-hit x="0" y="0" width="800" height="480"></rect><g data-graph-scene><g data-graph-edges></g><g data-graph-nodes></g></g></svg></div>
		<aside class="graph-details" aria-live="polite"><h3 data-graph-title>${escapeHtml(strings.chooseNode)}</h3><p data-graph-description>${escapeHtml(strings.chooseNodeDescription)}</p><div class="actions"><button class="secondary" data-graph-open-source type="button" hidden>${escapeHtml(vscode.l10n.t('Open source file'))}</button></div><dl class="receipt"><dt>${escapeHtml(strings.nodeType)}</dt><dd data-graph-detail="type">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.status)}</dt><dd data-graph-detail="status">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.connections)}</dt><dd data-graph-detail="connections">${escapeHtml(strings.unavailable)}</dd><dt>${escapeHtml(strings.sourceEvent)}</dt><dd><code data-graph-detail="source">${escapeHtml(strings.unavailable)}</code></dd><dt>${escapeHtml(strings.evidence)}</dt><dd><code data-graph-detail="evidence">${escapeHtml(strings.unavailable)}</code></dd></dl><h3>${escapeHtml(vscode.l10n.t('Visible results'))}</h3><ol class="graph-results" data-graph-results aria-label="${escapeHtml(vscode.l10n.t('Filtered graph nodes'))}"></ol></aside></div>
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
	const comparison = snapshot?.matchedComparison;
	const matchedComparison = comparison
		? `<section class="matched-comparison" aria-labelledby="matched-comparison-title">
			<h2 id="matched-comparison-title">${escapeHtml(strings.matchedComparison)}</h2>
			<p>${escapeHtml(vscode.l10n.t('{0} matched task pairs with the same pinned model and conditions.', comparison.pairCount))}</p>
			<div class="statistics-grid">
				<div class="statistics-metric"><span>${escapeHtml(strings.baselineBilledTokens)}</span><strong>${comparison.baselineBilledTokens.toLocaleString()}</strong></div>
				<div class="statistics-metric"><span>${escapeHtml(strings.fikeyaBilledTokens)}</span><strong>${comparison.fikeyaBilledTokens.toLocaleString()}</strong></div>
				<div class="statistics-metric"><span>${escapeHtml(strings.tokenDifference)}</span><strong>${comparison.billedTokenReductionPercent.toLocaleString(undefined, { maximumFractionDigits: 4 })}%</strong></div>
				<div class="statistics-metric"><span>${escapeHtml(strings.verifiedSolveRate)}</span><strong>${(comparison.baselineVerifiedSolveRate * 100).toFixed(1)}% → ${(comparison.fikeyaVerifiedSolveRate * 100).toFixed(1)}%</strong></div>
			</div>
			<p class="usage-basis">${escapeHtml(strings.comparisonReceipt)} ${escapeHtml(comparison.reportSha256)}</p>
		</section>`
		: `<section class="matched-comparison" aria-labelledby="matched-comparison-title"><h2 id="matched-comparison-title">${escapeHtml(strings.matchedComparison)}</h2><p class="empty">${escapeHtml(strings.noMatchedComparison)}</p></section>`;

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
		${matchedComparison}
		<h2>${escapeHtml(strings.providerModelBreakdown)}</h2>
		${breakdown}
	</section>`;
}

function renderPlanSurface(state: DashboardState, strings: WebviewStrings, canRestorePlan: boolean): string {
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
			<ol class="plan-lifecycle" aria-label="${escapeHtml(vscode.l10n.t('Plan lifecycle'))}"><li data-status="active" aria-current="step"><span>1</span><strong>${escapeHtml(vscode.l10n.t('Draft'))}</strong><span class="sr-only"> · ${escapeHtml(vscode.l10n.t('Current'))}</span></li><li><span>2</span><strong>${escapeHtml(vscode.l10n.t('Review'))}</strong><span class="sr-only"> · ${escapeHtml(vscode.l10n.t('Pending'))}</span></li><li><span>3</span><strong>${escapeHtml(vscode.l10n.t('Approval'))}</strong><span class="sr-only"> · ${escapeHtml(vscode.l10n.t('Pending'))}</span></li><li><span>4</span><strong>${escapeHtml(vscode.l10n.t('Execute'))}</strong><span class="sr-only"> · ${escapeHtml(vscode.l10n.t('Pending'))}</span></li><li><span>5</span><strong>${escapeHtml(vscode.l10n.t('Verify'))}</strong><span class="sr-only"> · ${escapeHtml(vscode.l10n.t('Pending'))}</span></li></ol>
			${state.plan.failure ? `<p class="plan-boundary" role="alert">${escapeHtml(state.plan.failure)}</p>` : ''}
			${canRestorePlan ? `<div class="actions"><button class="secondary" data-plan-restore type="button">${escapeHtml(vscode.l10n.t('Restore prior plan'))}</button></div>` : ''}
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
		const status = visual === 'complete' ? vscode.l10n.t('Complete') : visual === 'active' ? vscode.l10n.t('Current') : visual === 'attention' ? vscode.l10n.t('Needs attention') : vscode.l10n.t('Pending');
		return `<li data-status="${visual}"${visual === 'active' ? ' aria-current="step"' : ''}><span>${index + 1}</span><strong>${escapeHtml(stage.title)}</strong><span class="sr-only"> · ${escapeHtml(status)}</span></li>`;
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

export function planNeedsPrivateBrowserAccess(plan: FikeyaPlanRecord): boolean {
	return plan.steps.some(step => {
		if (step.toolCall.name !== 'browser.navigate') {
			return false;
		}
		const value = step.toolCall.arguments.url;
		if (typeof value !== 'string') {
			return false;
		}
		try {
			const hostname = new URL(value).hostname.toLowerCase();
			if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]') {
				return true;
			}
			const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
			if (!match) {
				return false;
			}
			const octets = match.slice(1).map(Number);
			if (octets.some(octet => octet > 255)) {
				return false;
			}
			return octets[0] === 10
				|| octets[0] === 127
				|| (octets[0] === 169 && octets[1] === 254)
				|| (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
				|| (octets[0] === 192 && octets[1] === 168);
		} catch {
			return false;
		}
	});
}

/**
 * Composer-mode integration seam. The current runtime accepts only agent/research, so Ask,
 * Build, and Review are explicit bounded intent adapters until native runtime modes exist.
 */
function buildComposerModeProviderPrompt(mode: FikeyaAgentComposerMode, prompt: string): string {
	if (mode === 'research') {
		return prompt;
	}
	const behavior = mode === 'ask'
		? 'Answer the question from project evidence. Do not edit files or run mutating tools.'
		: mode === 'review'
			? 'Audit the relevant code or changes, report prioritized findings with project paths, and do not edit files.'
			: 'Implement the requested change, keep the work scoped, run relevant checks, and verify the result.';
	return [`Fikeya ${mode.charAt(0).toUpperCase()}${mode.slice(1)} mode.`, behavior, '', 'Task:', prompt].join('\n');
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

const autonomousProgressStages = ['PLAN', 'AUDIT_PLAN', 'EXECUTE', 'AUDIT_CODE', 'VERIFY'] as const;

function autonomousProgressStageIndex(progress: FikeyaRunProgress | undefined, fallbackIndex = 0): number {
	if (!progress) {
		return fallbackIndex;
	}
	const event = progress.event.toLowerCase();
	const stage = progress.stage.toLowerCase().replaceAll('-', '_');
	if (event === 'session.completed' || stage.includes('verify')) {
		return 4;
	}
	if (event === 'answer.proposed' || event === 'review.completed' || stage.includes('audit_code') || stage.includes('code_review')) {
		return 3;
	}
	if (event === 'tool.execution_claimed' || event === 'tool.completed' || stage.includes('execut') || stage === 'act' || stage === 'observe') {
		return 2;
	}
	if (event === 'tool.proposed' || event === 'approval.requested' || stage.includes('audit_plan') || stage.includes('approval')) {
		return 1;
	}
	return 0;
}

function renderAutonomousProgress(progress: FikeyaRunProgress | undefined, fallbackIndex = 0): string {
	const activeIndex = autonomousProgressStageIndex(progress, fallbackIndex);
	return `<ol class="run-progress-stages" aria-label="${escapeHtml(vscode.l10n.t('Run progress'))}">${autonomousProgressStages.map((stage, index) => {
		const visual = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending';
		const status = visual === 'complete' ? vscode.l10n.t('Complete') : visual === 'active' ? vscode.l10n.t('Current') : vscode.l10n.t('Pending');
		return `<li data-status="${visual}"${visual === 'active' ? ' aria-current="step"' : ''}><span aria-hidden="true">${index + 1}</span><strong>${stage}</strong><span class="sr-only"> · ${escapeHtml(status)}</span></li>`;
	}).join('')}</ol>`;
}

function renderProjectStageLabel(stage: FikeyaProjectView['stage']): string {
	switch (stage) {
		case 'plan': return vscode.l10n.t('Plan');
		case 'audit_plan': return vscode.l10n.t('Audit plan');
		case 'execute': return vscode.l10n.t('Execute');
		case 'audit_code': return vscode.l10n.t('Audit code');
		case 'verify': return vscode.l10n.t('Verify');
		case 'completed': return vscode.l10n.t('Completed');
		case 'stopped': return vscode.l10n.t('Stopped');
		case 'failed': return vscode.l10n.t('Failed');
	}
}

function renderDurableProject(project: ProjectSurfaceState): string {
	if (project.status === 'idle') {
		return '';
	}
	if (project.status === 'loading') {
		return `<section class="durable-project" aria-label="${escapeHtml(vscode.l10n.t('Audited project'))}"><span role="status">${escapeHtml(vscode.l10n.t('Recovering the durable project record…'))}</span></section>`;
	}
	if (!project.view) {
		const message = project.status === 'running'
			? vscode.l10n.t('Creating the durable plan and its first audit record. Exact tool approvals remain required.')
			: project.failure ?? vscode.l10n.t('The durable project record is unavailable.');
		const action = project.status === 'unavailable'
			? `<button data-project-action="refresh" type="button">${escapeHtml(vscode.l10n.t('Recover history'))}</button>`
			: `<button class="secondary" data-project-action="cancel" type="button">${escapeHtml(vscode.l10n.t('Cancel project'))}</button>`;
		return `<section class="durable-project" data-tone="${project.status === 'unavailable' ? 'error' : 'normal'}" aria-label="${escapeHtml(vscode.l10n.t('Audited project'))}"><strong>${escapeHtml(vscode.l10n.t('Audited project'))}</strong><span role="status">${escapeHtml(message)}</span>${action}</section>`;
	}
	const presentation = buildDurableProjectPresentation(project.view);
	const history = presentation.history.map(item => `<li${item.current ? ' aria-current="step"' : ''}><span>${escapeHtml(vscode.l10n.t('Revision {0}', item.revision))}</span><strong>${escapeHtml(renderProjectStageLabel(item.stage))}</strong><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(new Date(item.createdAt).toLocaleString())}</time><code title="${escapeHtml(item.documentSha256)}">${escapeHtml(item.documentSha256.slice(0, 19))}…</code></li>`).join('');
	let nextAction = `<span>${escapeHtml(vscode.l10n.t('No further action is recorded.'))}</span>`;
	if (presentation.nextAction === 'review_plan') {
		nextAction = `<span>${escapeHtml(vscode.l10n.t('Review the immutable plan before any execution.'))}</span><button data-plan-action="review" type="button">${escapeHtml(vscode.l10n.t('Review plan'))}</button>`;
	} else if (presentation.nextAction === 'approve_plan_steps') {
		nextAction = `<span>${escapeHtml(vscode.l10n.t('Review and approve each exact plan step. One lead executes approved work; advisory agents remain read-only.'))}</span><button data-project-show-plan type="button">${escapeHtml(vscode.l10n.t('Open plan approvals'))}</button>`;
	} else if (presentation.nextAction === 'resume_project') {
		const goalInput = project.goal ? '' : `<label class="field project-goal"><span>${escapeHtml(vscode.l10n.t('Original project goal'))}</span><textarea data-project-resume-goal maxlength="65536" placeholder="${escapeHtml(vscode.l10n.t('Re-enter the exact original goal to resume this recovered run.'))}"></textarea></label>`;
		nextAction = `${goalInput}<span>${escapeHtml(project.goal ? vscode.l10n.t('Continue from the recorded stage with the exact original goal.') : vscode.l10n.t('The goal is not persisted in UI state. Re-enter it exactly to prove this is the same run.'))}</span><button data-project-action="resume" type="button">${escapeHtml(vscode.l10n.t('Resume project'))}</button>`;
	}
	const busy = project.status === 'running';
	return `<section class="durable-project" aria-label="${escapeHtml(vscode.l10n.t('Audited project'))}"><header><div><strong>${escapeHtml(vscode.l10n.t('Audited project'))}</strong><span>${escapeHtml(vscode.l10n.t('{0}, revision {1}', renderProjectStageLabel(presentation.currentStage), presentation.currentRevision))}</span></div><code title="${escapeHtml(presentation.runId)}">${escapeHtml(presentation.runId)}</code></header>${busy ? `<span role="status">${escapeHtml(vscode.l10n.t('The durable project protocol is running.'))}</span>` : ''}<details><summary>${escapeHtml(vscode.l10n.t('Recorded history ({0})', presentation.history.length))}</summary><ol class="project-history">${history}</ol></details><div class="project-next-action">${nextAction}</div><div class="actions"><button class="secondary" data-project-action="refresh" type="button"${busy ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Refresh record'))}</button>${presentation.canCancel ? `<button class="secondary" data-project-action="cancel" type="button">${escapeHtml(vscode.l10n.t('Cancel project'))}</button>` : ''}</div></section>`;
}

function renderAgentSurface(state: DashboardState, strings: WebviewStrings, planOperationInProgress: boolean, projectOperationInProgress: boolean, canRestoreConversation: boolean, planSurface: string): string {
	const workspaceReady = getLocalWorkspacePath() !== undefined;
	const running = state.agent.status === 'running';
	const interactionBlocked = isChatInteractionBlocked({ agentRunning: running, planRunning: planOperationInProgress || projectOperationInProgress, planCancellationInProgress: false });
	const controlsDisabled = interactionBlocked;
	const providerControlsDisabled = interactionBlocked || state.providers.length === 0;
	const initialComposerMode: FikeyaComposerMode = state.activeMode === 'research' ? 'research' : state.activeMode === 'plan' ? 'plan' : 'build';
	const composerModeDefinitions: readonly { readonly id: FikeyaComposerMode; readonly label: string; readonly behavior: string; readonly placeholder: string }[] = [
		{ id: 'ask', label: vscode.l10n.t('Ask'), behavior: vscode.l10n.t('Explain and answer from project context without editing files.'), placeholder: vscode.l10n.t('Ask about this project...') },
		{ id: 'plan', label: vscode.l10n.t('Plan'), behavior: vscode.l10n.t('Draft a reviewable plan before any workspace tool executes.'), placeholder: vscode.l10n.t('Describe the outcome and constraints to plan...') },
		{ id: 'build', label: vscode.l10n.t('Build'), behavior: vscode.l10n.t('Inspect, edit, test, and verify through explicit approvals.'), placeholder: vscode.l10n.t('Describe what to build or change...') },
		{ id: 'review', label: vscode.l10n.t('Review'), behavior: vscode.l10n.t('Audit relevant code and report prioritized findings without editing.'), placeholder: vscode.l10n.t('Describe the code or changes to review...') },
		{ id: 'research', label: vscode.l10n.t('Research'), behavior: vscode.l10n.t('Investigate deeply, cite project evidence, and state unknowns.'), placeholder: vscode.l10n.t('Research a technical question with cited evidence...') }
	];
	const composerModeOptions = composerModeDefinitions.map(mode => `<option value="${mode.id}" data-behavior="${escapeHtml(mode.behavior)}" data-placeholder="${escapeHtml(mode.placeholder)}"${initialComposerMode === mode.id ? ' selected' : ''}>${escapeHtml(mode.label)}</option>`).join('');
	const initialComposerDefinition = composerModeDefinitions.find(mode => mode.id === initialComposerMode) ?? composerModeDefinitions[2];
	const advisoryProfiles = state.agentProfiles.filter(profile => profile.role === 'planner' || profile.role === 'researcher' || profile.role === 'reviewer');
	const agentProfileOptions = advisoryProfiles.length > 0
		? advisoryProfiles.map(profile => `<label class="agent-choice"><input type="checkbox" name="selectedAgentId" value="${escapeHtml(profile.id)}"><span><strong>${escapeHtml(profile.displayName)}</strong><small>${escapeHtml(`${profile.role} · ${profile.providerName}`)}</small></span></label>`).join('')
		: `<p class="muted">${escapeHtml(vscode.l10n.t('No advisory agents configured yet.'))}</p>`;
	const providerOptions = state.providers.length === 0
		? `<option value="">${escapeHtml(strings.noProviders)}</option>`
		: state.providers.map(provider => `<option value="${escapeHtml(provider.name)}"${state.agent.providerName === provider.name ? ' selected' : ''}>${escapeHtml(`${provider.name} | ${provider.model}`)}</option>`).join('');
	const emptyActions = `${!workspaceReady ? `<button data-command="workbench.action.files.openFolder" type="button">${escapeHtml(vscode.l10n.t('Open a folder'))}</button>` : state.providers.length === 0 ? `<button data-provider-modal-open type="button">${escapeHtml(strings.configureProvider)}</button>` : ''}${canRestoreConversation ? `<button class="secondary" data-conversation-restore type="button">${escapeHtml(vscode.l10n.t('Restore prior chat'))}</button>` : ''}`;
	const conversation = state.conversation.length === 0
		? `<div class="chat-empty"><strong>${escapeHtml(vscode.l10n.t('What should Fikeya work on?'))}</strong><p>${escapeHtml(vscode.l10n.t('Ask, plan, build, review, or research from one project-first chat.'))}</p>${emptyActions ? `<div class="actions">${emptyActions}</div>` : ''}<div class="prompt-suggestions"><button class="quiet" data-prompt-value="Explain this project and cite the files that matter." type="button">${escapeHtml(vscode.l10n.t('Explain this project'))}</button><button class="quiet" data-prompt-value="Inspect the current changes and identify the highest-risk issue." type="button">${escapeHtml(vscode.l10n.t('Review current changes'))}</button><button class="quiet" data-prompt-value="Run the relevant tests, diagnose any failure, and propose the smallest fix." type="button">${escapeHtml(vscode.l10n.t('Diagnose failing tests'))}</button></div></div>`
		: state.conversation.map(renderConversationMessage).join('');
	const multiAgentProgress = state.agent.multiAgentProgress?.length
		? `<div class="multi-agent-live"><strong>${escapeHtml(vscode.l10n.t('Agent progress · {0} selected · up to {1} parallel', state.agent.multiAgentProgress.length, state.agent.multiAgentMaxConcurrency ?? 1))}</strong><ul>${state.agent.multiAgentProgress.map(item => `<li><strong>${escapeHtml(item.displayName)}</strong><span>${escapeHtml(item.runtime ? formatRunProgress(item.runtime) : item.status === 'queued' ? vscode.l10n.t('Queued') : item.status === 'running' ? vscode.l10n.t('Running') : item.status === 'completed' ? vscode.l10n.t('Completed') : item.status === 'cancelled' ? vscode.l10n.t('Cancelled') : vscode.l10n.t('Failed'))}</span></li>`).join('')}</ul></div>`
		: '';
	const progress = running
		? `<article class="chat-message assistant-message" aria-label="${escapeHtml(vscode.l10n.t('Fikeya is working'))}"><div class="message-meta"><strong>${escapeHtml(vscode.l10n.t('Fikeya'))}</strong><span class="thinking-dot" aria-hidden="true"></span><span role="status">${escapeHtml(state.agent.progress ? formatRunProgress(state.agent.progress) : vscode.l10n.t('Starting a bounded run'))}</span></div>${renderAutonomousProgress(state.agent.progress)}${multiAgentProgress}</article>`
		: '';
	const outcome = !running && state.agent.status === 'completed' && state.agent.outcome
		? renderChatRunOutcome(state.agent.outcome)
		: '';
	const projectSurface = renderDurableProject(state.project);
	const chatPlan = state.plan.record ? renderChatPlanStrip(state.plan.record, state.plan.status === 'running', planSurface) : '';
	const approvedPlanSteps = state.plan.record?.steps.filter(step => step.status === 'approved') ?? [];
	const planCanResume = !planOperationInProgress && state.plan.record !== undefined
		&& (state.plan.record.status === 'executing' || state.plan.record.status === 'verifying' || (state.plan.record.status === 'awaiting_approval' && approvedPlanSteps.length > 0));
	const planFallbackStage = state.plan.record?.status === 'verifying' ? 4 : state.plan.record?.status === 'executing' ? 2 : 1;
	const planRunProgress = planOperationInProgress
		? `<div class="plan-run-progress"><span role="status">${escapeHtml(state.plan.progress ? formatRunProgress(state.plan.progress) : vscode.l10n.t('Running the approved plan'))}</span>${renderAutonomousProgress(state.plan.progress, planFallbackStage)}</div>`
		: '';
	const planRecoveryActions = planCanResume || planOperationInProgress
		? `<div class="run-recovery-actions" role="group" aria-label="${escapeHtml(vscode.l10n.t('Plan run controls'))}"><span>${escapeHtml(planOperationInProgress ? vscode.l10n.t('Plan execution is active') : vscode.l10n.t('Approved work is ready to continue'))}</span>${planCanResume ? `<button data-plan-action="resume" type="button">${escapeHtml(vscode.l10n.t('Resume plan'))}</button>` : ''}${planOperationInProgress ? `<button class="secondary" data-plan-action="cancel" type="button">${escapeHtml(vscode.l10n.t('Cancel plan'))}</button>` : ''}</div>`
		: '';
	const status = state.providers.length === 0
		? vscode.l10n.t('Add a model to begin')
		: projectOperationInProgress
			? vscode.l10n.t('Chat is paused while the audited project runs')
			: planOperationInProgress
			? vscode.l10n.t('Chat is paused while the current plan runs')
			: agentStatusLabel(state.agent, strings);
	const stopControl = projectOperationInProgress
		? `<button class="secondary" data-project-action="cancel" type="button" aria-label="${escapeHtml(vscode.l10n.t('Cancel project'))}" title="${escapeHtml(vscode.l10n.t('Cancel project'))}"><span aria-hidden="true">■</span></button>`
		: running
			? `<button class="secondary" data-agent-cancel type="button" aria-label="${escapeHtml(strings.cancel)}" title="${escapeHtml(strings.cancel)}"><span aria-hidden="true">■</span></button>`
			: '';
	return `<section class="card agent-surface" data-agent-surface data-drop-label="${escapeHtml(vscode.l10n.t('Drop workspace files here to attach them'))}" aria-label="${escapeHtml(vscode.l10n.t('Fikeya chat'))}">
		<div class="chat-thread" data-chat-thread data-message-count="${state.conversation.length}">${projectSurface}${chatPlan}${planRunProgress}${planRecoveryActions}${conversation}${progress}${outcome}</div>
		<form class="agent-form" data-agent-form autocomplete="off">
			<div class="composer-attachments" data-composer-attachments hidden aria-live="polite"></div>
			<input data-attachment-input type="file" accept="image/png,image/jpeg,image/webp,image/gif,text/*,.c,.cc,.cfg,.cjs,.cmd,.conf,.cpp,.cs,.css,.dart,.go,.h,.hpp,.html,.ini,.java,.js,.json,.jsonc,.jsx,.kt,.md,.mdx,.mjs,.php,.ps1,.py,.rb,.rs,.sh,.sql,.swift,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml" multiple hidden${controlsDisabled ? ' disabled' : ''}>
			<input data-folder-input type="file" webkitdirectory directory multiple hidden${controlsDisabled ? ' disabled' : ''}>
			<label class="field composer"><span class="sr-only">${escapeHtml(strings.prompt)}</span><textarea name="prompt" maxlength="65536" placeholder="${escapeHtml(initialComposerDefinition.placeholder)}"${controlsDisabled ? ' disabled' : ''} required></textarea></label>
			<p class="composer-mode-help" id="composer-mode-help" data-composer-mode-help role="status">${escapeHtml(initialComposerDefinition.behavior)}</p>
			<div class="composer-bar">
				<details class="composer-attach"><summary aria-label="${escapeHtml(vscode.l10n.t('Attach files or images'))}" title="${escapeHtml(vscode.l10n.t('Attach, paste, or drop files'))}"><span aria-hidden="true">＋</span></summary><div class="composer-attach-menu"><button data-attach-files type="button"${controlsDisabled ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Files or images'))}</button><button data-attach-folder type="button"${controlsDisabled ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Folder'))}</button></div></details>
				<details class="composer-mention"><summary aria-label="${escapeHtml(vscode.l10n.t('Mention files'))}" title="${escapeHtml(vscode.l10n.t('Mention up to 10 files'))}"><span aria-hidden="true">@</span></summary><div class="composer-attach-menu"><button data-mention-workspace type="button"${controlsDisabled ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Workspace files'))}</button><button data-mention-computer type="button"${controlsDisabled ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('Files from this computer'))}</button></div></details>
				<label class="field composer-mode"><span class="sr-only">${escapeHtml(vscode.l10n.t('Mode'))}</span><select name="chatMode" aria-label="${escapeHtml(vscode.l10n.t('Chat mode'))}" aria-describedby="composer-mode-help"${controlsDisabled ? ' disabled' : ''}>${composerModeOptions}</select></label>
				<button class="composer-icon" data-audited-project-run type="button"${controlsDisabled ? ' disabled' : ''} aria-label="${escapeHtml(vscode.l10n.t('Run as an audited project'))}" title="${escapeHtml(vscode.l10n.t('Run as an audited project'))}"><span aria-hidden="true">◎</span></button>
				<label class="field inline-field" data-single-provider><span class="sr-only">${escapeHtml(strings.provider)}</span><select name="providerName" aria-label="${escapeHtml(vscode.l10n.t('Model provider'))}" title="${escapeHtml(vscode.l10n.t('Choose a model'))}"${providerControlsDisabled ? ' disabled' : ''}>${providerOptions}</select></label>
				<details class="agent-picker" data-agent-picker hidden><summary>${escapeHtml(vscode.l10n.t('Agents'))}<span data-agent-count>0</span></summary><div class="agent-picker-menu"><strong>${escapeHtml(vscode.l10n.t('Parallel advisory agents'))}</strong><p class="muted">${escapeHtml(vscode.l10n.t('Select independent planning, research, or review agents. Approvals remain serialized.'))}</p>${agentProfileOptions}<label class="field"><span>${escapeHtml(vscode.l10n.t('Maximum parallel agents'))}</span><select name="maxConcurrency"${controlsDisabled ? ' disabled' : ''}><option value="1">1</option><option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></label><button class="secondary" data-command="fikeya.configureAgents" type="button">${escapeHtml(vscode.l10n.t('Configure agents'))}</button></div></details>
				<details class="composer-route"><summary aria-label="${escapeHtml(vscode.l10n.t('Model, context, and chat actions'))}" title="${escapeHtml(vscode.l10n.t('More'))}">•••</summary><div class="composer-route-menu"><div class="composer-menu-controls"><label class="field"><span>${escapeHtml(strings.contextMode)}</span><select name="memoryMode"${controlsDisabled ? ' disabled' : ''}><option value="${agentComposerDefaults.memoryMode}">${escapeHtml(strings.contextAuto)}</option><option value="required">${escapeHtml(strings.contextRequired)}</option><option value="off">${escapeHtml(strings.contextOff)}</option></select></label><label class="field"><span>${escapeHtml(strings.contextBudget)}</span><input name="contextMaxCharacters" type="number" min="${agentComposerConstraints.contextMaxCharacters.minimum}" max="${agentComposerConstraints.contextMaxCharacters.maximum}" step="${agentComposerConstraints.contextMaxCharacters.step}" value="${agentComposerDefaults.contextMaxCharacters}"${controlsDisabled ? ' disabled' : ''} required></label><label class="field"><span>${escapeHtml(strings.maximumOutputTokens)}</span><input name="maxOutputTokens" type="number" min="${agentComposerConstraints.maxOutputTokens.minimum}" max="${agentComposerConstraints.maxOutputTokens.maximum}" step="${agentComposerConstraints.maxOutputTokens.step}" value="${agentComposerDefaults.maxOutputTokens}"${controlsDisabled ? ' disabled' : ''} required></label></div><nav aria-label="${escapeHtml(vscode.l10n.t('Chat actions'))}"><button data-provider-modal-open type="button">${escapeHtml(vscode.l10n.t('Configure models'))}</button><button data-parallel-toggle type="button" aria-pressed="false">${escapeHtml(vscode.l10n.t('Parallel advisory agents'))}</button><button data-command="fikeya.mode.editor" type="button">${escapeHtml(vscode.l10n.t('Focus editor'))}</button><button data-command="fikeya.mode.terminal" type="button">${escapeHtml(vscode.l10n.t('Terminal'))}</button><button data-command="fikeya.mode.review" type="button">${escapeHtml(vscode.l10n.t('Review changes'))}</button><button data-modal-open="context" type="button">${escapeHtml(vscode.l10n.t('Context graph'))}</button><button data-modal-open="usage" type="button">${escapeHtml(vscode.l10n.t('Usage and receipts'))}</button><button data-modal-open="setup" type="button">${escapeHtml(vscode.l10n.t('Models and setup'))}</button><button data-conversation-clear type="button"${interactionBlocked || state.conversation.length === 0 ? ' disabled' : ''}>${escapeHtml(vscode.l10n.t('New chat'))}</button></nav></div></details>
				<div class="actions composer-actions">${!workspaceReady ? `<button data-command="workbench.action.files.openFolder" type="button" aria-label="${escapeHtml(vscode.l10n.t('Open a folder'))}" title="${escapeHtml(vscode.l10n.t('Open a folder'))}"><span aria-hidden="true">↗</span></button>` : state.providers.length === 0 ? `<button data-provider-modal-open type="button" aria-label="${escapeHtml(vscode.l10n.t('Configure a model'))}" title="${escapeHtml(vscode.l10n.t('Add model'))}"><span aria-hidden="true">＋</span></button>` : `<button data-agent-run type="button"${controlsDisabled ? ' disabled' : ''} aria-label="${escapeHtml(vscode.l10n.t('Send message'))}" title="${escapeHtml(vscode.l10n.t('Send message'))}"><span aria-hidden="true">↑</span></button>`}${stopControl}</div>
			</div>
			<div class="composer-foot"><span class="composer-status" role="status">${escapeHtml(status)}</span><span class="sr-only">${escapeHtml(vscode.l10n.t('Enter sends this message and its visible attachments once to the selected model. Shift+Enter inserts a new line. Workspace and process tools still require approval.'))}</span></div>
		</form>
	</section>`;
}

function renderChatPlanStrip(plan: FikeyaPlanRecord, operationRunning: boolean, planSurface: string): string {
	const summary = buildChatPlanSummary(plan);
	const stepLabel = summary.stepKind === 'current'
		? vscode.l10n.t('Current step')
		: summary.stepKind === 'next'
			? vscode.l10n.t('Next step')
			: vscode.l10n.t('Last recorded step');
	const step = summary.step
		? `<div class="chat-plan-step"><span>${escapeHtml(stepLabel)}</span><strong>${escapeHtml(vscode.l10n.t('{0} of {1} · {2}', summary.step.order, summary.totalSteps, summary.step.title))}</strong><span>${escapeHtml(planStepStatusLabel(summary.step.status))}</span></div>`
		: `<div class="chat-plan-step"><span>${escapeHtml(stepLabel)}</span><strong>${escapeHtml(vscode.l10n.t('No recorded step'))}</strong></div>`;
	return `<details class="chat-plan-details" data-chat-plan-details><summary class="chat-plan-strip" aria-label="${escapeHtml(vscode.l10n.t('Current plan'))}"><div class="chat-plan-copy"><span>${escapeHtml(vscode.l10n.t('Current plan'))}</span><strong title="${escapeHtml(summary.title)}">${escapeHtml(summary.title)}</strong><span class="chat-plan-status">${escapeHtml(operationRunning ? vscode.l10n.t('Running') : planStatusLabel(summary.status))}</span></div>${step}<span class="plan-expand">${escapeHtml(vscode.l10n.t('Details'))}</span></summary><div class="chat-plan-body">${planSurface}</div></details>`;
}

function renderConversationMessage(message: FikeyaConversationMessage): string {
	const roleLabel = message.role === 'user'
		? vscode.l10n.t('You')
		: message.role === 'assistant'
			? vscode.l10n.t('Fikeya')
			: vscode.l10n.t('Run status');
	const provider = message.providerName ? `<span>${escapeHtml(message.providerName)}</span>` : '';
	const className = message.role === 'user' ? 'user-message' : message.role === 'assistant' ? 'assistant-message' : 'notice-message';
	const content = renderSafeMarkdown(message.content, { copy: vscode.l10n.t('Copy'), reviewDiff: vscode.l10n.t('Review diff') });
	const attachments = message.attachments?.length
		? `<div class="message-attachments" aria-label="${escapeHtml(vscode.l10n.t('Attachments'))}">${message.attachments.map(attachment => {
			const label = attachment.relativePath ?? attachment.name;
			const icon = attachment.kind === 'text' ? 'FILE' : '▧';
			return `<span class="message-attachment"><span aria-hidden="true">${escapeHtml(icon)}</span><strong title="${escapeHtml(label)}">${escapeHtml(label)}</strong><span>${escapeHtml(formatByteCount(attachment.sizeBytes))}</span></span>`;
		}).join('')}</div>`
		: '';
	const actions = message.role === 'notice' ? '' : renderConversationMessageActions(message.id);
	return `<article class="chat-message ${className}" data-tone="${message.tone ?? 'normal'}"><div class="message-meta"><strong>${escapeHtml(roleLabel)}</strong>${provider}<time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(formatConversationTime(message.createdAt))}</time></div>${attachments}<div class="message-content">${content}</div>${actions}</article>`;
}

function renderConversationMessageActions(messageId: string): string {
	const copyLabel = vscode.l10n.t('Copy message');
	return `<div class="message-actions" role="toolbar" aria-label="${escapeHtml(vscode.l10n.t('Message actions'))}"><button class="message-action" data-copy-message="${escapeHtml(messageId)}" type="button" aria-label="${escapeHtml(copyLabel)}" title="${escapeHtml(copyLabel)}"><svg class="message-action-icon copy-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M5 13H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path></svg><svg class="message-action-icon copied-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-9"></path></svg></button><span class="sr-only" data-copy-status aria-live="polite"></span></div>`;
}

function renderChatRunOutcome(outcome: FikeyaCodingOutcome): string {
	const changedFiles = outcome.changedFiles.length === 0
		? `<span>${escapeHtml(vscode.l10n.t('No files changed'))}</span>`
		: `<ul class="outcome-files">${outcome.changedFiles.slice(0, 24).map(file => `<li><button class="outcome-file" data-open-file="${escapeHtml(file.path)}" type="button" title="${escapeHtml(vscode.l10n.t('Open changed file'))}">${escapeHtml(file.path)}</button></li>`).join('')}</ul>`;
	const passingTests = outcome.tests.filter(test => test.status === 'ok').length;
	return `<details class="chat-run-outcome"${outcome.changedFiles.length > 0 ? ' open' : ''}><summary><strong>${escapeHtml(vscode.l10n.t('Run result'))}</strong><span>${escapeHtml(vscode.l10n.t('{0} files saved · {1}/{2} tests passed', outcome.changedFiles.length, passingTests, outcome.tests.length))}</span></summary><div><p>${escapeHtml(outcome.summary)}</p>${changedFiles}</div></details>`;
}

function formatByteCount(value: number): string {
	return value < 1024 ? `${value} B` : `${Math.round(value / 1024)} KB`;
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
		: `<ul class="outcome-files">${outcome.changedFiles.slice(0, 100).map(file => `<li><button class="outcome-file" data-open-file="${escapeHtml(file.path)}" type="button" title="${escapeHtml(vscode.l10n.t('Open changed file'))}">${escapeHtml(file.path)}</button></li>`).join('')}</ul>`;
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
	readonly matchedComparison: string;
	readonly noMatchedComparison: string;
	readonly baselineBilledTokens: string;
	readonly fikeyaBilledTokens: string;
	readonly tokenDifference: string;
	readonly verifiedSolveRate: string;
	readonly comparisonReceipt: string;
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
		matchedComparison: vscode.l10n.t('Matched Verified Baseline'),
		noMatchedComparison: vscode.l10n.t('No matched verified comparison is recorded. Fikeya will not infer a saving from unrelated calls.'),
		baselineBilledTokens: vscode.l10n.t('Baseline Billed Tokens'),
		fikeyaBilledTokens: vscode.l10n.t('Fikeya Billed Tokens'),
		tokenDifference: vscode.l10n.t('Billed Token Reduction'),
		verifiedSolveRate: vscode.l10n.t('Verified Solve Rate'),
		comparisonReceipt: vscode.l10n.t('Aggregate report receipt:'),
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
		runAgent: vscode.l10n.t('Run Agent'),
		cancel: vscode.l10n.t('Cancel'),
		agentIdle: vscode.l10n.t('Choose a provider and enter a prompt. No network request occurs until you press Send or submit with Enter.'),
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

export function getProviderDefinitions(): readonly ProviderDefinition[] {
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
			credentialType: 'bearer',
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
			id: 'deepseek',
			label: vscode.l10n.t('DeepSeek'),
			detail: vscode.l10n.t('Use DeepSeek models through its OpenAI-compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.deepseek.com/v1',
			secretPrompt: vscode.l10n.t('Enter the DeepSeek API Key')
		},
		{
			id: 'mistral',
			label: vscode.l10n.t('Mistral AI'),
			detail: vscode.l10n.t('Use Mistral models through its OpenAI-compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.mistral.ai/v1',
			secretPrompt: vscode.l10n.t('Enter the Mistral API Key')
		},
		{
			id: 'xai',
			label: vscode.l10n.t('xAI'),
			detail: vscode.l10n.t('Use Grok models through the xAI OpenAI-compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.x.ai/v1',
			secretPrompt: vscode.l10n.t('Enter the xAI API Key')
		},
		{
			id: 'together',
			label: vscode.l10n.t('Together AI'),
			detail: vscode.l10n.t('Use hosted open models through an OpenAI-compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.together.xyz/v1',
			secretPrompt: vscode.l10n.t('Enter the Together AI API Key')
		},
		{
			id: 'fireworks',
			label: vscode.l10n.t('Fireworks AI'),
			detail: vscode.l10n.t('Use serverless open models through an OpenAI-compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
			secretPrompt: vscode.l10n.t('Enter the Fireworks AI API Key')
		},
		{
			id: 'cerebras',
			label: vscode.l10n.t('Cerebras'),
			detail: vscode.l10n.t('Use Cerebras inference through its OpenAI-compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://api.cerebras.ai/v1',
			secretPrompt: vscode.l10n.t('Enter the Cerebras API Key')
		},
		{
			id: 'amazon-bedrock',
			label: vscode.l10n.t('Amazon Bedrock'),
			detail: vscode.l10n.t('Use a Bedrock OpenAI-compatible endpoint with an AWS Bedrock API key.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/v1',
			secretPrompt: vscode.l10n.t('Enter the Amazon Bedrock API Key')
		},
		{
			id: 'azure-ai-foundry',
			label: vscode.l10n.t('Azure AI Foundry Models'),
			detail: vscode.l10n.t('Use an Azure AI Foundry OpenAI-compatible project or deployment endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'bearer',
			defaultBaseUrl: '',
			secretPrompt: vscode.l10n.t('Enter the Azure AI Foundry Token')
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
			id: 'local-openai-compatible',
			label: vscode.l10n.t('Local or No-Auth Compatible'),
			detail: vscode.l10n.t('Use LM Studio, vLLM, LocalAI, or another trusted no-auth OpenAI-compatible endpoint.'),
			runtimeKind: 'openai-compatible',
			credentialType: 'none',
			defaultBaseUrl: 'http://127.0.0.1:1234/v1'
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

async function discoverAzureOpenAIConfiguration(): Promise<{ readonly endpoint: string; readonly deployment: string; readonly label: string } | undefined> {
	const subscriptions = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Discovering Azure subscriptions') },
		() => listAzureSubscriptions()
	);
	if (subscriptions.length === 0) {
		throw new Error(vscode.l10n.t('No enabled Azure subscriptions were found. Run az login, then try again.'));
	}
	const subscription = await vscode.window.showQuickPick(subscriptions.map(item => ({
		label: item.name,
		description: item.id,
		item
	})), { placeHolder: vscode.l10n.t('Choose an Azure subscription') });
	if (!subscription) {
		return undefined;
	}
	const resources = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Discovering Azure OpenAI resources') },
		() => listAzureOpenAIResources(subscription.item.id)
	);
	if (resources.length === 0) {
		throw new Error(vscode.l10n.t('No Azure OpenAI resources were found in {0}.', subscription.item.name));
	}
	const resource = await vscode.window.showQuickPick(resources.map(item => ({
		label: item.name,
		description: item.resourceGroup,
		detail: item.endpoint,
		item
	})), { placeHolder: vscode.l10n.t('Choose an Azure OpenAI resource') });
	if (!resource) {
		return undefined;
	}
	const deployments = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Discovering model deployments') },
		() => listAzureOpenAIDeployments(subscription.item.id, resource.item.resourceGroup, resource.item.name)
	);
	if (deployments.length === 0) {
		throw new Error(vscode.l10n.t('No model deployments were found in {0}.', resource.item.name));
	}
	const deployment = await vscode.window.showQuickPick(deployments.map(item => ({
		label: item.name,
		description: item.model,
		detail: item.version,
		item
	})), { placeHolder: vscode.l10n.t('Choose a model deployment') });
	return deployment ? {
		endpoint: resource.item.endpoint,
		deployment: deployment.item.name,
		label: `Azure ${deployment.item.name}`
	} : undefined;
}

function getWorkspaceName(): string {
	return vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.l10n.t('No Local Workspace');
}

function createConversationMessage(
	role: FikeyaConversationMessage['role'],
	content: string,
	providerName?: string,
	tone: FikeyaConversationMessage['tone'] = 'normal',
	images: readonly FikeyaImageInput[] = [],
	files: readonly FikeyaTextFileInput[] = []
): FikeyaConversationMessage {
	return {
		id: `chat-${Date.now()}-${randomBytes(5).toString('hex')}`,
		role,
		content,
		createdAt: new Date().toISOString(),
		providerName,
		tone,
		...(images.length === 0 && files.length === 0 ? {} : {
			attachments: [
				...images.map(image => ({
					kind: 'image' as const,
					name: image.name,
					mimeType: image.mimeType,
					sizeBytes: image.sizeBytes,
					sha256: `sha256:${createHash('sha256').update(Buffer.from(image.base64Data, 'base64')).digest('hex')}`
				})),
				...files.map(file => ({
					kind: 'text' as const,
					name: file.name,
					mimeType: file.mimeType,
					relativePath: file.relativePath,
					sizeBytes: file.sizeBytes,
					sha256: `sha256:${createHash('sha256').update(file.text, 'utf8').digest('hex')}`
				}))
			]
		})
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
		case 'provider-unreachable':
			return vscode.l10n.t('Fikeya could not reach this provider endpoint. Check that the local server is running or verify the provider URL, then try again.');
		case 'agent-no-progress':
			return vscode.l10n.t('Fikeya stopped before repeating an unchanged model request. Add new project evidence or revise the task, then try again.');
		case 'runtime-error':
			return vscode.l10n.t('The local Fikeya runtime stopped before returning a result. Open the Fikeya output channel for details, then run Fikeya: Run Doctor.');
		case 'cancelled':
			return vscode.l10n.t('The Fikeya run was cancelled before completion. Completed file and tool receipts remain available.');
		case 'none':
			return vscode.l10n.t('The local Fikeya runtime did not return a usable result. Run Fikeya: Run Doctor and try again.');
		default:
			return vscode.l10n.t('Fikeya could not complete the local run. Run Fikeya: Run Doctor and try again.');
	}
}
