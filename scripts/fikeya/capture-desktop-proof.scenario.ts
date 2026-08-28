/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

interface ScenarioTarget {
	readonly targetId: string;
	readonly type: string;
	readonly url: string;
}

interface ScenarioCode {
	readonly driver: {
		getCDPTargets(): Promise<readonly ScenarioTarget[]>;
		evaluateCDPTargetFrame<T>(targetId: string, frameUrlPattern: string, expression: string): Promise<T>;
	};
}

interface ScenarioContext {
	readonly code: ScenarioCode;
	readonly page: {
		waitForSelector(selector: string, options: { readonly state: 'visible'; readonly timeout: number }): Promise<unknown>;
		evaluate<T>(expression: string): Promise<T>;
		readonly keyboard: {
			press(key: string): Promise<unknown>;
			type(text: string): Promise<unknown>;
		};
	};
	readonly workbench: {
		readonly quickaccess: {
			openFile(filePath: string): Promise<unknown>;
			runCommand(commandId: string): Promise<unknown>;
		};
	};
}

interface Scenario {
	readonly id: string;
	readonly title: string;
	readonly source: string;
	readonly workspacePath: string;
	readonly userSettings: Readonly<Record<string, string | number | boolean>>;
	readonly recordVideo?: boolean;
	readonly stepPauseMs: number;
	readonly steps: readonly {
		readonly id: string;
		readonly title: string;
		run(context: ScenarioContext): Promise<string | void> | string | void;
	}[];
}

interface ChatState {
	readonly chatVisible: boolean;
	readonly assistant: string;
	readonly provider: string;
	readonly usage: Readonly<Record<string, string>>;
	readonly usageBasis: string;
	readonly modes: readonly string[];
}

interface ImageChatState {
	readonly assistant: string;
	readonly attachment: string;
	readonly status: string;
}

interface MultitaskState {
	readonly status: string;
	readonly selectedAgents: number;
	readonly messageCount: number;
	readonly results: readonly {
		readonly label: string;
		readonly content: string;
	}[];
}

interface MultitaskLiveState {
	readonly heading: string;
	readonly agents: readonly {
		readonly name: string;
		readonly status: string;
	}[];
}

interface DraftState {
	readonly title: string;
	readonly badge: string;
	readonly steps: number;
}

interface DesktopWindowBounds {
	readonly width: number;
	readonly height: number;
}

interface NarrowPanelState {
	readonly viewportWidth: number;
	readonly documentWidth: number;
	readonly bodyWidth: number;
	readonly chatVisible: boolean;
	readonly currentPlanVisible: boolean;
	readonly promptVisible: boolean;
	readonly sendVisible: boolean;
	readonly modeVisible: boolean;
	readonly contextOptionsVisible: boolean;
	readonly moreActionsVisible: boolean;
	readonly fiveModesAvailable: boolean;
	readonly composerAnchored: boolean;
}

interface ShortComposerState {
	readonly viewportHeight: number;
	readonly confirmationTop: number;
	readonly confirmationBottom: number;
	readonly promptBottom: number;
	readonly footerTop: number;
	readonly sendOnceVisible: boolean;
	readonly cancelVisible: boolean;
}

interface NarrowGraphState {
	readonly viewportWidth: number;
	readonly documentWidth: number;
	readonly bodyWidth: number;
	readonly canvasLeft: number;
	readonly canvasRight: number;
	readonly canvasWidth: number;
	readonly nodeCount: number;
	readonly hasSelectedNode: boolean;
	readonly selectedTitle: string;
	readonly selectedEvidence: string;
}

interface ReviewedState {
	readonly badge: string;
	readonly approvals: number;
}

interface ApprovalState {
	readonly badge: string;
	readonly selectedStatus: string;
	readonly digest: string;
	readonly approve: string;
}

interface IssuedApprovalState {
	readonly badge: string;
	readonly selectedStatus: string;
	readonly approval: string;
	readonly expiresAt: string;
}

interface VerifiedStepState {
	readonly badge: string;
	readonly stepId: string;
	readonly executionSha256: string;
	readonly verificationSha256: string;
	readonly check: string;
}

interface CompletedPlanState {
	readonly badge: string;
	readonly planId: string;
	readonly recordSha256: string;
	readonly steps: readonly {
		readonly stepId: string;
		readonly status: string;
		readonly toolCallSha256: string;
		readonly approval: string;
		readonly expiresAt: string;
		readonly executionSha256: string;
		readonly verificationSha256: string;
		readonly checks: readonly string[];
	}[];
}

const workspacePath = process.env.FIKEYA_CAPTURE_WORKSPACE;
if (!workspacePath || !path.isAbsolute(workspacePath)) {
	throw new Error('FIKEYA_CAPTURE_WORKSPACE must name the absolute disposable proof workspace.');
}
const providerName = process.env.FIKEYA_CAPTURE_PROVIDER_NAME;
const providerOutput = process.env.FIKEYA_CAPTURE_PROVIDER_OUTPUT;
if (!providerName || !providerOutput) {
	throw new Error('FIKEYA_CAPTURE_PROVIDER_NAME and FIKEYA_CAPTURE_PROVIDER_OUTPUT must describe the deterministic proof provider.');
}
const runtimeExecutable = process.env.FIKEYA_CAPTURE_RUNTIME_EXECUTABLE;
if (!runtimeExecutable || !path.isAbsolute(runtimeExecutable)) {
	throw new Error('FIKEYA_CAPTURE_RUNTIME_EXECUTABLE must name the absolute packaged local runtime.');
}

const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

let proofWindowBounds: DesktopWindowBounds | undefined;
let proofPanelWidth: number | undefined;

async function waitFor<T>(predicate: () => Promise<T | false | undefined> | T | false | undefined, message: string, timeoutMilliseconds = 45_000): Promise<T> {
	const deadline = Date.now() + timeoutMilliseconds;
	let detail: T | false | string | undefined;
	do {
		try {
			detail = await predicate();
			if (detail) {
				return detail;
			}
		} catch (error) {
			detail = error instanceof Error ? error.message : String(error);
		}
		await pause(200);
	} while (Date.now() < deadline);
	throw new Error(`${message}${detail ? ` Last observation: ${String(detail)}` : ''}`);
}

async function fikeyaTarget(code: ScenarioCode) {
	return waitFor<ScenarioTarget>(async () => {
		const targets = await code.driver.getCDPTargets();
		return targets.find(target => target.type === 'iframe' && target.url.includes('extensionId=fikeya.fikeya-desktop'));
	}, 'The Fikeya extension webview target did not appear.');
}

async function evaluateFikeya<T>(code: ScenarioCode, expression: string): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			const target = await fikeyaTarget(code);
			return await code.driver.evaluateCDPTargetFrame<T>(target.targetId, 'fake.html', expression);
		} catch (error) {
			lastError = error;
			await pause(200);
		}
	}
	throw lastError;
}

async function waitForFikeya<T>(code: ScenarioCode, expression: string, message: string, timeoutMilliseconds?: number): Promise<T> {
	return waitFor(
		() => evaluateFikeya<T>(code, expression),
		message,
		timeoutMilliseconds
	);
}

async function resizeFikeyaPanel(
	code: ScenarioCode,
	page: ScenarioContext['page'],
	targetWidth: number
): Promise<number> {
	const minimumPanelWidth = 340;
	const maximumPanelWidth = 420;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const viewportWidth = await evaluateFikeya<number>(code, 'window.innerWidth');
		if (viewportWidth >= minimumPanelWidth && viewportWidth <= maximumPanelWidth) {
			return viewportWidth;
		}
		const bounds = await page.evaluate<DesktopWindowBounds>('({ width: window.outerWidth, height: window.outerHeight })');
		const adjustedWidth = Math.max(420, bounds.width + targetWidth - viewportWidth);
		await page.evaluate<void>(`window.resizeTo(${Math.round(adjustedWidth)}, ${Math.max(760, Math.round(bounds.height))})`);
		await pause(500);
	}
	const viewportWidth = await evaluateFikeya<number>(code, 'window.innerWidth');
	throw new Error(`The Electron window could not produce a 340-420px Fikeya panel; observed ${viewportWidth}px.`);
}

async function restoreProofWindow(code: ScenarioCode, page: ScenarioContext['page']): Promise<void> {
	if (!proofWindowBounds) {
		return;
	}
	const expectedPanelWidth = Math.max(421, (proofPanelWidth ?? 421) - 8);
	await page.evaluate<void>(`window.resizeTo(${proofWindowBounds.width}, ${proofWindowBounds.height})`);
	await waitForFikeya<number>(
		code,
		`window.innerWidth >= ${expectedPanelWidth} ? window.innerWidth : false`,
		'The proof window did not return to its wide layout.',
		15_000
	);
	proofWindowBounds = undefined;
	proofPanelWidth = undefined;
}

async function runWorkbenchCommand(
	workbench: ScenarioContext['workbench'],
	page: ScenarioContext['page'],
	commandId: string
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await workbench.quickaccess.runCommand(commandId);
			return;
		} catch (error) {
			lastError = error;
			await page.keyboard.press('Escape');
			await pause(500);
		}
	}
	throw lastError;
}

async function waitForQuickInput(page: ScenarioContext['page'], expectedTitle: string): Promise<string> {
	return waitFor(
		() => page.evaluate<string | false>(`(() => {
			const widget = document.querySelector('.quick-input-widget');
			const title = widget?.querySelector('.quick-input-title')?.textContent?.trim() ?? '';
			const bounds = widget?.getBoundingClientRect();
			return bounds && bounds.width > 0 && bounds.height > 0 && title === ${JSON.stringify(expectedTitle)} ? title : false;
		})()`),
		`The '${expectedTitle}' Quick Input did not appear.`,
		20_000
	);
}

async function acceptQuickInput(page: ScenarioContext['page'], title: string, filterOrValue?: string): Promise<void> {
	await waitForQuickInput(page, title);
	if (filterOrValue) {
		const focused = await page.evaluate<boolean>(`(() => {
			const widget = document.querySelector('.quick-input-widget');
			const input = widget?.querySelector('.quick-input-box input');
			if (!input) return false;
			input.focus();
			return document.activeElement === input;
		})()`);
		if (!focused) {
			throw new Error(`The '${title}' Quick Input could not receive keyboard focus.`);
		}
		await page.keyboard.press('Control+A');
		await page.keyboard.type(filterOrValue);
		await waitFor(
			() => page.evaluate<boolean>(`document.querySelector('.quick-input-widget .quick-input-box input')?.value === ${JSON.stringify(filterOrValue)}`),
			`The '${title}' Quick Input did not receive its exact value.`,
			10_000
		);
	}
	await page.keyboard.press('Enter');
	await waitFor(
		() => page.evaluate<boolean>(`(() => {
			const widget = document.querySelector('.quick-input-widget');
			const currentTitle = widget?.querySelector('.quick-input-title')?.textContent?.trim() ?? '';
			const bounds = widget?.getBoundingClientRect();
			return !bounds || bounds.width === 0 || bounds.height === 0 || currentTitle !== ${JSON.stringify(title)};
		})()`),
		`The '${title}' Quick Input did not accept its selection.`,
		10_000
	);
}

async function acceptQuickPickPosition(page: ScenarioContext['page'], title: string, position: number): Promise<void> {
	await waitForQuickInput(page, title);
	await page.keyboard.press('Home');
	for (let index = 0; index < position; index += 1) {
		await page.keyboard.press('ArrowDown');
	}
	await page.keyboard.press('Enter');
	await waitFor(
		() => page.evaluate<boolean>(`(() => {
			const widget = document.querySelector('.quick-input-widget');
			const currentTitle = widget?.querySelector('.quick-input-title')?.textContent?.trim() ?? '';
			const bounds = widget?.getBoundingClientRect();
			return !bounds || bounds.width === 0 || bounds.height === 0 || currentTitle !== ${JSON.stringify(title)};
		})()`),
		`The '${title}' Quick Pick did not accept row ${position + 1}.`,
		10_000
	);
}

async function configureProofAgent(
	code: ScenarioCode,
	page: ScenarioContext['page'],
	displayName: string,
	role: 'Planner' | 'Researcher' | 'Reviewer',
	instruction: string
): Promise<void> {
	const opened = await evaluateFikeya<boolean>(code, `(() => {
		const button = document.querySelector('[data-agent-picker] [data-command="fikeya.configureAgents"]');
		if (!button) return false;
		button.click();
		return true;
	})()`);
	if (!opened) {
		throw new Error('The real Multitask agent configuration action was not available.');
	}
	await acceptQuickInput(page, 'Fikeya parallel agents');
	await acceptQuickInput(page, 'Agent name', displayName);
	await acceptQuickPickPosition(page, 'Agent role', role === 'Planner' ? 0 : role === 'Researcher' ? 1 : 2);
	await acceptQuickPickPosition(page, 'Agent model', 0);
	await acceptQuickInput(page, 'Agent instruction', instruction);
	await waitForFikeya<boolean>(code, `(() => {
		return Array.from(document.querySelectorAll('[data-agent-picker] .agent-choice strong'))
			.some(item => item.textContent?.trim() === ${JSON.stringify(displayName)});
	})()`, `The '${displayName}' advisory profile was not rendered in the Multitask picker.`, 20_000);
}

async function approveExactStep(
	code: ScenarioCode,
	page: ScenarioContext['page'],
	stepId: string
): Promise<IssuedApprovalState> {
	const clicked = await evaluateFikeya<boolean>(code, `(() => {
		const plan = document.querySelector('.chat-plan-details');
		if (!plan) return false;
		plan.open = true;
		const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
		const step = surface?.querySelector('[data-plan-step="${stepId}"]');
		if (!step) return false;
		step.click();
		const button = surface?.querySelector('[data-plan-action="approve-step"][data-plan-action-step="${stepId}"]');
		if (!button || button.disabled) return false;
		button.click();
		return true;
	})()`);
	if (!clicked) {
		throw new Error(`The exact approval action was not available for ${stepId}.`);
	}
	// Exact approval is a modal person-in-the-loop boundary. The isolated proof
	// fixture accepts only the single visible action after the scenario has
	// already asserted the exact step identifier and its immutable tool digest.
	await pause(500);
	await page.keyboard.press('Enter');
	const state = await waitForFikeya<IssuedApprovalState>(code, `(() => {
		const plan = document.querySelector('.chat-plan-details');
		if (plan) plan.open = true;
		const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
		const step = surface?.querySelector('[data-plan-step="${stepId}"]');
		step?.click();
		const detail = surface?.querySelector('[data-plan-detail="${stepId}"]:not([hidden])');
		const receipt = detail ? Array.from(detail.querySelectorAll('.receipt dd')).map(item => item.textContent?.trim() ?? '') : [];
		const expiresAt = detail?.querySelector('time')?.getAttribute('datetime') ?? '';
		const value = {
			badge: surface?.querySelector('.badge')?.textContent?.trim() ?? '',
			selectedStatus: step?.querySelector('.plan-step-status')?.textContent?.trim() ?? '',
			approval: receipt[1] ?? '',
			expiresAt
		};
		return value.badge === 'Awaiting Approval'
			&& value.selectedStatus === 'Approved'
			&& /^apr_[a-z0-9]+ · unused$/.test(value.approval)
			&& !Number.isNaN(Date.parse(value.expiresAt))
			&& Date.parse(value.expiresAt) > Date.now()
			&& receipt[3] === 'No execution receipt'
			&& receipt[4] === 'No verification receipt'
			? value
			: false;
	})()`, `The exact approval reference for ${stepId} was not issued with an unused, unexpired receipt.`, 60_000);
	await evaluateFikeya<boolean>(code, `(() => {
		const receipt = document.querySelector('[data-plan-detail="${stepId}"]:not([hidden]) .receipt');
		if (!receipt) return false;
		receipt.scrollIntoView({ block: 'center' });
		return true;
	})()`);
	return state;
}

async function resumeApprovedStep(code: ScenarioCode): Promise<void> {
	const clicked = await evaluateFikeya<boolean>(code, `(() => {
		const plan = document.querySelector('.chat-plan-details');
		if (plan) plan.open = true;
		const button = document.querySelector('[data-plan-action="resume"]');
		if (!button || button.disabled) return false;
		button.click();
		return true;
	})()`);
	if (!clicked) {
		throw new Error('The approved plan step could not be resumed.');
	}
}

async function waitForVerifiedStep(
	code: ScenarioCode,
	stepId: string,
	nextStepId?: string
): Promise<VerifiedStepState> {
	const state = await waitForFikeya<VerifiedStepState>(code, `(() => {
		const plan = document.querySelector('.chat-plan-details');
		if (plan) plan.open = true;
		const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
		const step = surface?.querySelector('[data-plan-step="${stepId}"]');
		step?.click();
		const detail = surface?.querySelector('[data-plan-detail="${stepId}"]:not([hidden])');
		const receipt = detail ? Array.from(detail.querySelectorAll('.receipt dd')).map(item => item.textContent?.trim() ?? '') : [];
		const execution = /^ok · (sha256:[0-9a-f]{64})$/.exec(receipt[3] ?? '');
		const verification = /^passed · (sha256:[0-9a-f]{64})$/.exec(receipt[4] ?? '');
		const check = detail?.querySelector('.plan-lines li')?.textContent?.trim() ?? '';
		const next = ${nextStepId ? `surface?.querySelector('[data-plan-step="${nextStepId}"] .plan-step-status')?.textContent?.trim()` : '"none"'};
		const value = {
			badge: surface?.querySelector('.badge')?.textContent?.trim() ?? '',
			stepId: '${stepId}',
			executionSha256: execution?.[1] ?? '',
			verificationSha256: verification?.[1] ?? '',
			check
		};
		return step?.querySelector('.plan-step-status')?.textContent?.trim() === 'Succeeded'
			&& /^apr_[a-z0-9]+ · consumed$/.test(receipt[1] ?? '')
			&& execution && verification
			&& check.startsWith('✓ tool_status · ')
			&& ${nextStepId ? 'next === "Awaiting Approval"' : 'value.badge === "Succeeded"'}
			? value
			: false;
	})()`, `The safe ${stepId} operation did not expose execution and verification receipts.`, 60_000);
	await evaluateFikeya<boolean>(code, `(() => {
		const receipt = document.querySelector('[data-plan-detail="${stepId}"]:not([hidden]) .receipt');
		if (!receipt) return false;
		receipt.scrollIntoView({ block: 'center' });
		return true;
	})()`);
	return state;
}

function writeCompletedPlanProof(planId: string): void {
	const output = execFileSync(runtimeExecutable, [
		'plan',
		'show',
		planId,
		'--workspace',
		workspacePath,
		'--json'
	], {
		encoding: 'utf8',
		env: process.env,
		windowsHide: true
	});
	const payload = JSON.parse(output);
	fs.writeFileSync(
		path.join(workspacePath, '.fikeya', 'desktop-plan-proof.json'),
		`${JSON.stringify({
			schemaVersion: 'fikeya.desktop-plan-proof.v1',
			capturedAt: new Date().toISOString(),
			plan: payload.plan,
			receipt: payload.receipt,
			recordSha256: payload.recordSha256
		}, null, 2)}\n`,
		'utf8'
	);
}

const scenario: Scenario = {
	id: 'fikeya-chat-plan-proof',
	title: 'Fikeya Chat to reviewable durable Plan',
	source: 'https://github.com/AjnasNB/fikeya',
	workspacePath,
	// Playwright 1.61's Electron video recorder leaves the Electron 42 Windows
	// page protocol-unresponsive before the workbench can be observed. The proof
	// remains fully exercised and retains screenshots, trace, logs, and report.
	recordVideo: process.platform !== 'win32',
	userSettings: {
		'workbench.colorTheme': 'Fikeya Dark',
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'workbench.startupEditor': 'none',
		'window.commandCenter': false
	},
	stepPauseMs: 900,
	steps: [
		{
			id: 'successful-chat',
			title: 'Complete a real Chat turn through the deterministic provider',
			async run({ code, page, workbench }) {
				await workbench.quickaccess.openFile(path.join(workspacePath, 'README.md'));
				await page.keyboard.press('Escape');
				await pause(500);
				await runWorkbenchCommand(workbench, page, 'fikeya.open');
				await page.waitForSelector('iframe.webview.ready', { state: 'visible', timeout: 60_000 });
				await page.keyboard.press('Escape');
				await runWorkbenchCommand(workbench, page, 'fikeya.initializeWorkspace');
				await waitFor(
					() => fs.existsSync(path.join(workspacePath, '.fikeya', 'state.sqlite3')),
					'Fikeya Runtime did not initialize the disposable proof workspace.',
					60_000
				);
				await runWorkbenchCommand(workbench, page, 'fikeya.open');
				await waitForFikeya<boolean>(
					code,
					`(() => {
						const prompt = document.querySelector('[data-agent-form] [name="prompt"]');
						const mode = document.querySelector('[data-agent-form] [name="chatMode"]');
						const provider = document.querySelector('[data-agent-form] [name="providerName"]');
						if (!prompt || !mode || !provider || !Array.from(provider.options).some(option => option.value === ${JSON.stringify(providerName)})) return false;
						return !document.querySelector('[data-surface-panel="chat"]')?.hidden
							&& Array.from(mode.options).map(option => option.value).join(',') === 'ask,plan,build,review,research';
					})()`,
					'The real Fikeya Chat composer did not become ready.',
					60_000
				);
				const submitted = await evaluateFikeya<boolean>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const prompt = document.querySelector('[data-agent-form] [name="prompt"]');
					const provider = document.querySelector('[data-agent-form] [name="providerName"]');
					const contextBudget = document.querySelector('[data-agent-form] [name="contextMaxCharacters"]');
					if (!form || !prompt || !provider || !contextBudget) return false;
					provider.value = ${JSON.stringify(providerName)};
					provider.dispatchEvent(new Event('change', { bubbles: true }));
					// The control has min=512 and step=256. Use a value on that exact
					// lattice so native form validation cannot suppress requestSubmit().
					contextBudget.value = '12032';
					contextBudget.dispatchEvent(new Event('input', { bubbles: true }));
					prompt.value = 'Inspect this proof workspace and explain what the bounded project evidence verifies.';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					if (!form.checkValidity()) return false;
					form.requestSubmit();
					const confirmation = document.querySelector('[data-network-confirmation]');
					const sendOnce = document.querySelector('[data-network-confirm]');
					if (!confirmation || confirmation.hidden || !sendOnce) return false;
					sendOnce.click();
					return true;
				})()`);
				if (!submitted) {
					throw new Error('The real Chat composer could not submit the deterministic provider turn.');
				}
				const state = await waitForFikeya<ChatState>(code, `(() => {
					const assistant = Array.from(document.querySelectorAll('.assistant-message .message-content')).at(-1)?.textContent?.trim();
					const providerField = document.querySelector('[data-agent-form] [name="providerName"]');
					const modeField = document.querySelector('[data-agent-form] [name="chatMode"]');
					const selectedProvider = providerField?.options?.[providerField.selectedIndex]?.textContent?.trim();
					document.querySelector('[data-modal-open="usage"]')?.click();
					const usageDialog = document.querySelector('[data-workspace-modal="usage"]');
					const metrics = Object.fromEntries(Array.from(usageDialog?.querySelectorAll('.statistics-metric') ?? []).map(item => [
						item.querySelector('span')?.textContent?.trim(),
						item.querySelector('strong')?.textContent?.trim()
					]));
					const usageBasis = usageDialog?.querySelector('.receipt')?.textContent?.trim() ?? '';
					usageDialog?.querySelector('[data-modal-close]')?.click();
					const value = {
						assistant,
						chatVisible: !document.querySelector('[data-surface-panel="chat"]')?.hidden,
						modes: Array.from(modeField?.options ?? []).map(option => option.value),
						provider: selectedProvider,
						usage: metrics,
						usageBasis
					};
					return value.chatVisible
						&& value.modes.join(',') === 'ask,plan,build,review,research'
						&& value.assistant === ${JSON.stringify(providerOutput)}
						&& value.provider === ${JSON.stringify(`${providerName} | fikeya-proof-model`)}
						&& value.usage['Input Tokens'] === '60'
						&& value.usage['Cached Input Tokens'] === '12'
						&& value.usage['Output Tokens'] === '15'
						&& value.usageBasis.includes('provider-reported')
						? value
						: false;
				})()`, 'Chat did not render the successful assistant response and exact provider-reported usage.', 90_000);
				await configureProofAgent(code, page, 'Proof Planner', 'Planner', 'Return a bounded plan from cited project evidence.');
				await configureProofAgent(code, page, 'Proof Reviewer', 'Reviewer', 'Return an independent review from cited project evidence.');
				return `Completed a real three-call Chat turn through ${state.provider}; visible usage is ${state.usage['Input Tokens']} input, ${state.usage['Cached Input Tokens']} cached input, and ${state.usage['Output Tokens']} output tokens. Configured two advisory agents through the native UI.`;
			}
		},
		{
			id: 'pasted-image-chat',
			title: 'Paste an image into Chat and deliver it to the selected model',
			async run({ code }) {
				const attached = await evaluateFikeya<boolean>(code, `(() => {
					const prompt = document.querySelector('[data-agent-form] [name="prompt"]');
					if (!prompt) return false;
					const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlD8AAAAASUVORK5CYII=';
					const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
					const transfer = new DataTransfer();
					transfer.items.add(new File([bytes], 'proof-pixel.png', { type: 'image/png' }));
					const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
					prompt.dispatchEvent(event);
					return true;
				})()`);
				if (!attached) {
					throw new Error('The Chat textarea did not accept a pasted image event.');
				}
				await waitForFikeya<boolean>(code, `document.querySelectorAll('[data-composer-attachments] .composer-attachment').length === 1`, 'The pasted image preview did not render.', 15_000);
				const submitted = await evaluateFikeya<boolean>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const prompt = form?.querySelector('[name="prompt"]');
					const provider = form?.querySelector('[name="providerName"]');
					const mode = form?.querySelector('[name="chatMode"]');
					if (!form || !prompt || !provider || !mode) return false;
					mode.value = 'build';
					mode.dispatchEvent(new Event('change', { bubbles: true }));
					provider.value = ${JSON.stringify(providerName)};
					provider.dispatchEvent(new Event('change', { bubbles: true }));
					prompt.value = 'Inspect this attached image together with the bounded project evidence.';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					form.requestSubmit();
					const confirmation = form.querySelector('[data-network-confirmation]');
					const sendOnce = form.querySelector('[data-network-confirm]');
					if (!confirmation || confirmation.hidden || !sendOnce) return false;
					sendOnce.click();
					return true;
				})()`);
				if (!submitted) {
					throw new Error('The pasted-image Chat turn could not be submitted.');
				}
				const state = await waitForFikeya<ImageChatState>(code, `(() => {
					const assistant = Array.from(document.querySelectorAll('.assistant-message .message-content')).at(-1)?.textContent?.trim() ?? '';
					const attachment = Array.from(document.querySelectorAll('.user-message .message-attachment strong')).at(-1)?.textContent?.trim() ?? '';
					const status = document.querySelector('.composer-status')?.textContent?.trim() ?? '';
					return assistant === ${JSON.stringify(providerOutput)} && attachment === 'proof-pixel.png' && status.toLowerCase().includes('completed')
						? { assistant, attachment, status }
						: false;
				})()`, 'The pasted image did not complete a visible multimodal Chat turn.', 90_000);
				return `Pasted ${state.attachment}, rendered its bounded attachment receipt, and completed the real provider-backed Chat turn.`;
			}
		},
		{
			id: 'mentioned-file-chat',
			title: 'Mention a workspace file and deliver its bounded content to the selected model',
			async run({ code, page }) {
				const opened = await evaluateFikeya<boolean>(code, `(() => {
					const mention = document.querySelector('[data-mention-workspace]');
					if (!mention) return false;
					mention.click();
					return true;
				})()`);
				if (!opened) {
					throw new Error('The workspace-file mention action was not available.');
				}
				const pickerTitle = 'Add workspace files to this message';
				await waitForQuickInput(page, pickerTitle);
				const focused = await page.evaluate<boolean>(`(() => {
					const input = document.querySelector('.quick-input-widget .quick-input-box input');
					if (!input) return false;
					input.focus();
					return document.activeElement === input;
				})()`);
				if (!focused) {
					throw new Error('The workspace-file mention picker could not receive focus.');
				}
				await page.keyboard.press('Control+A');
				await page.keyboard.type('README.md');
				await waitFor(
					() => page.evaluate<boolean>(`document.querySelectorAll('.quick-input-list .monaco-list-row').length === 1`),
					'The workspace-file mention picker did not narrow to README.md.',
					10_000
				);
				await page.keyboard.press('ArrowDown');
				await page.keyboard.press('Space');
				await page.keyboard.press('Enter');
				await waitForFikeya<boolean>(code, `(() => {
					const prompt = document.querySelector('[data-agent-form] [name="prompt"]');
					const file = document.querySelector('[data-composer-attachments] .composer-attachment.file strong');
					return file?.textContent?.trim() === 'README.md' && prompt?.value.includes('@README.md');
				})()`, 'README.md was not attached through the workspace mention flow.', 20_000);
				const submitted = await evaluateFikeya<boolean>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const prompt = form?.querySelector('[name="prompt"]');
					const provider = form?.querySelector('[name="providerName"]');
					const mode = form?.querySelector('[name="chatMode"]');
					if (!form || !prompt || !provider || !mode) return false;
					mode.value = 'build';
					mode.dispatchEvent(new Event('change', { bubbles: true }));
					provider.value = ${JSON.stringify(providerName)};
					provider.dispatchEvent(new Event('change', { bubbles: true }));
					prompt.value += ' Explain the evidence in this mentioned file.';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					if (!form.checkValidity()) return false;
					form.requestSubmit();
					const confirmation = form.querySelector('[data-network-confirmation]');
					const sendOnce = form.querySelector('[data-network-confirm]');
					if (!confirmation || confirmation.hidden || !sendOnce) return false;
					sendOnce.click();
					return true;
				})()`);
				if (!submitted) {
					throw new Error('The mentioned-file Chat turn could not be submitted.');
				}
				const state = await waitForFikeya<ImageChatState>(code, `(() => {
					const assistant = Array.from(document.querySelectorAll('.assistant-message .message-content')).at(-1)?.textContent?.trim() ?? '';
					const attachment = Array.from(document.querySelectorAll('.user-message .message-attachment strong')).at(-1)?.textContent?.trim() ?? '';
					const status = document.querySelector('.composer-status')?.textContent?.trim() ?? '';
					return assistant === ${JSON.stringify(providerOutput)} && attachment === 'README.md' && status.toLowerCase().includes('completed')
						? { assistant, attachment, status }
						: false;
				})()`, 'The mentioned workspace file did not complete a visible provider-backed Chat turn.', 90_000);
				return `Mentioned ${state.attachment} through @, delivered its bounded UTF-8 content, and completed the real provider-backed Chat turn.`;
			}
		},
		{
			id: 'completed-multitask',
			title: 'Complete a bounded two-agent Multitask batch through the real UI',
			async run({ code, page }) {
				const submitted = await evaluateFikeya<boolean>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const prompt = form?.querySelector('[name="prompt"]');
					const mode = form?.querySelector('[name="chatMode"]');
					if (!form || !prompt || !mode) return false;
					mode.value = 'review';
					mode.dispatchEvent(new Event('change', { bubbles: true }));
					const parallelToggle = form.querySelector('[data-parallel-toggle]');
					if (!parallelToggle) return false;
					parallelToggle.click();
					const choices = Array.from(form.querySelectorAll('[data-agent-picker] .agent-choice'));
					const expected = new Set(['Proof Planner', 'Proof Reviewer']);
					if (choices.length !== 2 || choices.some(choice => !expected.has(choice.querySelector('strong')?.textContent?.trim() ?? ''))) return false;
					for (const choice of choices) {
						const input = choice.querySelector('input[name="selectedAgentId"]');
						if (!input) return false;
						input.checked = true;
						input.dispatchEvent(new Event('change', { bubbles: true }));
					}
					prompt.value = 'Inspect the proof workspace in parallel and return one bounded advisory result each.';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					if (!form.checkValidity()) return false;
					form.requestSubmit();
					const confirmation = form.querySelector('[data-network-confirmation]');
					const sendOnce = form.querySelector('[data-network-confirm]');
					if (!confirmation || confirmation.hidden || !sendOnce) return false;
					sendOnce.click();
					return true;
				})()`);
				if (!submitted) {
					throw new Error('The real Multitask composer could not submit the selected two-agent batch.');
				}
				const live = await waitForFikeya<MultitaskLiveState>(code, `(() => {
					const progress = document.querySelector('.multi-agent-live');
					const heading = progress?.querySelector(':scope > strong')?.textContent?.trim() ?? '';
					const agents = Array.from(progress?.querySelectorAll('li') ?? []).map(item => ({
						name: item.querySelector('strong')?.textContent?.trim() ?? '',
						status: item.querySelector('span')?.textContent?.trim() ?? ''
					}));
					const expected = new Set(['Proof Planner', 'Proof Reviewer']);
					return progress && agents.length === 2
						&& agents.every(item => expected.has(item.name) && /Queued|Running|Planning|Acting|Reviewing/.test(item.status))
						? { heading, agents }
						: false;
				})()`, 'The real in-flight multi-agent progress surface was never visible.', 30_000);

				const completed = await waitForFikeya<MultitaskState>(code, `(() => {
					const expectedLabels = new Set([
						${JSON.stringify(`Proof Planner · ${providerName}`)},
						${JSON.stringify(`Proof Reviewer · ${providerName}`)}
					]);
					const results = Array.from(document.querySelectorAll('.assistant-message')).map(message => ({
						label: message.querySelector('.message-meta span')?.textContent?.trim() ?? '',
						content: message.querySelector('.message-content')?.textContent?.trim() ?? ''
					})).filter(item => expectedLabels.has(item.label));
					const status = document.querySelector('.composer-status')?.textContent?.trim() ?? '';
					const selectedAgents = document.querySelectorAll('[data-agent-picker] input[name="selectedAgentId"]:checked').length;
					const messageCount = Number(document.querySelector('[data-chat-thread]')?.getAttribute('data-message-count') ?? '0');
					const complete = status.toLowerCase().includes('completed')
						&& selectedAgents === 2
						&& messageCount >= 5
						&& results.length === 2
						&& results.every(item => item.content === ${JSON.stringify(providerOutput)});
					return complete ? { status, selectedAgents, messageCount, results } : false;
				})()`, 'The bounded Multitask batch did not render two completed, provider-labelled advisory results.', 120_000);
				return `Observed ${live.heading}, then completed a bounded ${completed.selectedAgents}-agent Multitask batch through the UI; ${completed.results.map(item => item.label).join(' and ')} each rendered the exact verified provider result.`;
			}
		},
		{
			id: 'draft-plan',
			title: 'Create a durable draft through Plan mode',
			async run({ code }) {
				const submitted = await evaluateFikeya<boolean>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const mode = document.querySelector('[data-agent-form] [name="chatMode"]');
					const prompt = document.querySelector('[data-agent-form] [name="prompt"]');
					const provider = document.querySelector('[data-agent-form] [name="providerName"]');
					if (!form || !mode || !prompt || !provider || !Array.from(mode.options).some(option => option.value === 'plan')) return false;
					mode.value = 'plan';
					mode.dispatchEvent(new Event('change', { bubbles: true }));
					provider.value = ${JSON.stringify(providerName)};
					provider.dispatchEvent(new Event('change', { bubbles: true }));
					prompt.value = 'Create an exact three-step draft that inventories the project, reads README.md, and searches for the reviewable plan boundary.';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					if (!form.checkValidity()) return false;
					form.requestSubmit();
					const confirmation = form.querySelector('[data-network-confirmation]');
					const sendOnce = form.querySelector('[data-network-confirm]');
					if (!confirmation || confirmation.hidden || !sendOnce) return false;
					sendOnce.click();
					return true;
				})()`);
				if (!submitted) {
					throw new Error('Plan mode was not available in the fixed Chat composer.');
				}
				const draft = await waitForFikeya<DraftState>(code, `(() => {
					const inlinePlan = document.querySelector('.chat-plan-details');
					if (inlinePlan) inlinePlan.open = true;
					const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
					const title = surface?.querySelector('#plan-surface-title')?.textContent?.trim();
					const badge = surface?.querySelector('.badge')?.textContent?.trim();
					const steps = surface?.querySelectorAll('[data-plan-step]').length ?? 0;
					return title === 'Verify the real Fikeya proof workspace' && badge === 'Draft' && steps === 3
						? { title, badge, steps }
						: false;
				})()`, 'The runtime did not persist and render the exact draft plan.', 60_000);
				return `Selected Plan in the fixed composer and rendered durable ${draft.badge.toLowerCase()} "${draft.title}" inline with ${draft.steps} exact steps.`;
			}
		},
		{
			id: 'short-composer-confirmation',
			title: 'Confirm provider access from a short fixed composer without overlap',
			async run({ code, page }) {
				proofWindowBounds ??= await page.evaluate<DesktopWindowBounds>('({ width: window.outerWidth, height: window.outerHeight })');
				proofPanelWidth ??= await evaluateFikeya<number>(code, 'window.innerWidth');
				await page.evaluate<void>('window.resizeTo(window.outerWidth, 620)');
				await waitForFikeya<number>(code, 'window.innerHeight <= 620 && window.innerHeight >= 320 ? window.innerHeight : false', 'The proof window did not reach the short composer layout.', 15_000);
				const state = await waitForFikeya<ShortComposerState>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const prompt = form?.querySelector('[name="prompt"]');
					const mode = form?.querySelector('[name="chatMode"]');
					const confirmation = form?.querySelector('[data-network-confirmation]');
					const sendOnce = form?.querySelector('[data-network-confirm]');
					const cancel = form?.querySelector('[data-network-cancel]');
					const footer = form?.querySelector('.composer-foot');
					if (!form || !prompt || !mode || !confirmation || !sendOnce || !cancel || !footer) return false;
					mode.value = 'build';
					mode.dispatchEvent(new Event('change', { bubbles: true }));
					prompt.value = 'Verify the short composer confirmation without contacting the provider.';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					form.requestSubmit();
					confirmation.scrollIntoView({ block: 'nearest' });
					const confirmationRect = confirmation.getBoundingClientRect();
					const promptRect = prompt.getBoundingClientRect();
					const footerRect = footer.getBoundingClientRect();
					const visible = element => {
						const rect = element.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
					};
					const value = {
						viewportHeight: window.innerHeight,
						confirmationTop: confirmationRect.top,
						confirmationBottom: confirmationRect.bottom,
						promptBottom: promptRect.bottom,
						footerTop: footerRect.top,
						sendOnceVisible: visible(sendOnce),
						cancelVisible: visible(cancel)
					};
					return !confirmation.hidden
						&& confirmationRect.top >= promptRect.bottom - 1
						&& confirmationRect.bottom <= footerRect.top + 1
						&& value.sendOnceVisible && value.cancelVisible
						? value
						: false;
				})()`, 'The short composer confirmation was hidden, clipped, or overlapped another composer control.', 20_000);
				await evaluateFikeya<boolean>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const prompt = form?.querySelector('[name="prompt"]');
					const cancel = form?.querySelector('[data-network-cancel]');
					if (!prompt || !cancel) return false;
					cancel.click();
					prompt.value = '';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					return true;
				})()`);
				return `At ${state.viewportHeight}px high, the one-message network confirmation remained fully visible between the prompt and footer with both confirmation actions usable.`;
			}
		},
		{
			id: 'narrow-chat-panel',
			title: 'Use Chat and its current Plan at a 360px-class panel width',
			async run({ code, page }) {
				proofWindowBounds ??= await page.evaluate<DesktopWindowBounds>('({ width: window.outerWidth, height: window.outerHeight })');
				await resizeFikeyaPanel(code, page, 380);
				const narrow = await waitForFikeya<NarrowPanelState>(code, `(() => {
					const visible = element => {
						if (!element || element.hidden) return false;
						const rect = element.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= window.innerWidth + 1;
					};
					const currentPlan = document.querySelector('.chat-plan-details > summary');
					const prompt = document.querySelector('[data-agent-form] [name="prompt"]');
					const send = document.querySelector('[data-agent-run]');
					const mode = document.querySelector('[data-agent-form] [name="chatMode"]');
					const moreActions = document.querySelector('.composer-route > summary');
					const form = document.querySelector('[data-agent-form]');
					const formRect = form?.getBoundingClientRect();
					const value = {
						viewportWidth: window.innerWidth,
						documentWidth: document.documentElement.scrollWidth,
						bodyWidth: document.body.scrollWidth,
						chatVisible: !document.querySelector('[data-surface-panel="chat"]')?.hidden,
						currentPlanVisible: visible(currentPlan),
						promptVisible: visible(prompt),
						sendVisible: visible(send),
						modeVisible: visible(mode),
						moreActionsVisible: visible(moreActions),
						fiveModesAvailable: Array.from(mode?.options ?? []).map(option => option.value).join(',') === 'ask,plan,build,review,research',
						composerAnchored: Boolean(formRect && formRect.bottom <= window.innerHeight + 1 && formRect.bottom >= window.innerHeight - 36)
					};
					return value.viewportWidth >= 340 && value.viewportWidth <= 420
						&& value.documentWidth <= value.viewportWidth + 1
						&& value.bodyWidth <= value.viewportWidth + 1
						&& Object.entries(value).filter(([key]) => key.endsWith('Visible') || key === 'fiveModesAvailable' || key === 'composerAnchored').every(([, shown]) => shown === true)
						? value
						: false;
				})()`, 'The real Chat panel overflowed or hid a primary control at its narrow width.', 20_000);
				const planOpened = await evaluateFikeya<boolean>(code, `(() => {
					const plan = document.querySelector('.chat-plan-details');
					if (!plan) return false;
					plan.open = true;
					const review = document.querySelector('[data-plan-action="review"]');
					const rect = review?.getBoundingClientRect();
					const usable = plan.open && rect && rect.width > 0 && rect.right <= window.innerWidth + 1;
					plan.open = false;
					document.querySelector('[data-agent-form]')?.scrollIntoView({ block: 'end' });
					return Boolean(usable);
				})()`);
				if (!planOpened) {
					throw new Error('The inline Plan did not expose the draft review control at the narrow panel width.');
				}
				const optionsReachable = await evaluateFikeya<boolean>(code, `(() => {
					const options = document.querySelector('.composer-route');
					if (!options) return false;
					options.open = true;
					const contextBudget = options.querySelector('[name="contextMaxCharacters"]');
					const rect = contextBudget?.getBoundingClientRect();
					return Boolean(rect && rect.width > 0 && rect.right <= window.innerWidth + 1);
				})()`);
				if (!optionsReachable) {
					throw new Error('Context and output options were not reachable from the fixed composer at the narrow panel width.');
				}
				return `At ${narrow.viewportWidth}px, Chat, the inline Plan, fixed composer, Send, Agent/Plan/Research/Multitask selector, and compact context/actions menus remained usable with no horizontal document overflow.`;
			}
		},
		{
			id: 'narrow-memory-graph',
			title: 'Select a real Qarinah memory node at the narrow panel width',
			async run({ code }) {
				const opened = await evaluateFikeya<boolean>(code, `(() => {
					const trigger = document.querySelector('[data-modal-open="context"]');
					if (!trigger) return false;
					trigger.click();
					return Boolean(document.querySelector('[data-workspace-modal="context"]')?.open);
				})()`);
				if (!opened) {
					throw new Error('The Context graph overlay was not available from the compact chat actions.');
				}
				await waitForFikeya<number>(code, `(() => {
					const nodes = document.querySelectorAll('.graph-node');
					return nodes.length > 0 ? nodes.length : false;
				})()`, 'The real Qarinah graph did not render any nodes.', 30_000);
				const graph = await evaluateFikeya<NarrowGraphState>(code, `(() => {
					const canvas = document.querySelector('[data-memory-graph]');
					const nodes = Array.from(document.querySelectorAll('.graph-node'));
					if (!canvas || nodes.length === 0) throw new Error('The rendered graph disappeared before inspection.');
					let selectedTitle = '';
					let selectedEvidence = '';
					for (const node of nodes) {
						node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
						selectedTitle = document.querySelector('[data-graph-title]')?.textContent?.trim() ?? '';
						selectedEvidence = document.querySelector('[data-graph-detail="evidence"]')?.textContent?.trim() ?? '';
						if (/^sha256:[0-9a-f]{64}$/.test(selectedEvidence)) break;
					}
					const rect = canvas.getBoundingClientRect();
					const selected = document.querySelector('.graph-node[data-selected="true"]');
					return {
						viewportWidth: window.innerWidth,
						documentWidth: document.documentElement.scrollWidth,
						bodyWidth: document.body.scrollWidth,
						canvasLeft: rect.left,
						canvasRight: rect.right,
						canvasWidth: rect.width,
						nodeCount: nodes.length,
						hasSelectedNode: Boolean(selected),
						selectedTitle,
						selectedEvidence
					};
				})()`);
				const failures = [
					graph.canvasWidth > 0 ? undefined : 'canvas has no width',
					graph.canvasLeft >= -1 ? undefined : `canvas begins at ${graph.canvasLeft}px`,
					graph.canvasRight <= graph.viewportWidth + 1 ? undefined : `canvas ends at ${graph.canvasRight}px beyond ${graph.viewportWidth}px`,
					graph.documentWidth <= graph.viewportWidth + 1 ? undefined : `document is ${graph.documentWidth}px for a ${graph.viewportWidth}px viewport`,
					graph.bodyWidth <= graph.viewportWidth + 1 ? undefined : `body is ${graph.bodyWidth}px for a ${graph.viewportWidth}px viewport`,
					graph.hasSelectedNode ? undefined : 'no node is selected',
					graph.selectedTitle && graph.selectedTitle !== 'Choose a node' ? undefined : 'selected node title is missing',
					/^sha256:[0-9a-f]{64}$/u.test(graph.selectedEvidence) ? undefined : `selected evidence is ${JSON.stringify(graph.selectedEvidence)}`
				].filter((failure): failure is string => Boolean(failure));
				if (failures.length > 0) {
					throw new Error(`The real Qarinah graph failed its narrow-panel proof: ${failures.join('; ')}. Diagnostics: ${JSON.stringify(graph)}`);
				}
				return `At ${graph.viewportWidth}px, selected "${graph.selectedTitle}" from ${graph.nodeCount} real graph nodes with evidence ${graph.selectedEvidence}.`;
			}
		},
		{
			id: 'reviewed-plan',
			title: 'Review the immutable plan without approving tools',
			async run({ code, page }) {
				await restoreProofWindow(code, page);
				const clicked = await evaluateFikeya<boolean>(code, `(() => {
					document.querySelector('[data-workspace-modal="context"]')?.querySelector('[data-modal-close]')?.click();
					const plan = document.querySelector('.chat-plan-details');
					if (!plan) return false;
					plan.open = true;
					const button = document.querySelector('[data-plan-action="review"]');
					if (!button || button.disabled) return false;
					button.click();
					return true;
				})()`);
				if (!clicked) {
					throw new Error('The immutable review action was not available on the draft.');
				}
				const reviewed = await waitForFikeya<ReviewedState>(code, `(() => {
					const plan = document.querySelector('.chat-plan-details');
					if (plan) plan.open = true;
					const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
					const badge = surface?.querySelector('.badge')?.textContent?.trim();
					const start = surface?.querySelector('[data-plan-action="run"]')?.textContent?.trim();
					const approvals = surface?.querySelectorAll('[data-plan-action="approve-step"]').length ?? 0;
					return badge === 'Reviewed' && start === 'Start to approval' && approvals === 3
						? { badge, approvals }
						: false;
				})()`, 'The reviewed plan state did not return from durable runtime storage.', 60_000);
				return `${reviewed.badge} is visible with ${reviewed.approvals} exact, still-unapproved steps.`;
			}
		},
		{
			id: 'awaiting-approval',
			title: 'Stop at the first exact approval boundary',
			async run({ code }) {
				const clicked = await evaluateFikeya<boolean>(code, `(() => {
					const plan = document.querySelector('.chat-plan-details');
					if (plan) plan.open = true;
					const button = document.querySelector('[data-plan-action="run"]');
					if (!button || button.disabled) return false;
					button.click();
					return true;
				})()`);
				if (!clicked) {
					throw new Error('The reviewed plan could not be started to its approval boundary.');
				}
				await waitForFikeya<boolean>(code, `(() => {
					const plan = document.querySelector('.chat-plan-details');
					if (plan) plan.open = true;
					const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
					if (surface?.querySelector('.badge')?.textContent?.trim() !== 'Awaiting Approval') return false;
					const step = Array.from(surface.querySelectorAll('[data-plan-step]')).find(candidate =>
						candidate.querySelector('.plan-step-status')?.textContent?.trim() === 'Awaiting Approval'
					);
					if (!step) return false;
					step.click();
					return true;
				})()`, 'The runtime did not expose the first exact step awaiting approval.', 60_000);
				const proof = await waitForFikeya<ApprovalState>(code, `(() => {
					const plan = document.querySelector('.chat-plan-details');
					if (plan) plan.open = true;
					const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
					const badge = surface?.querySelector('.badge')?.textContent?.trim();
					const selected = surface?.querySelector('[data-plan-step][aria-selected="true"]');
					const selectedStatus = selected?.querySelector('.plan-step-status')?.textContent?.trim();
					const digest = surface?.querySelector('.plan-detail:not([hidden]) .receipt code')?.textContent?.trim();
					const execution = surface?.querySelector('.plan-detail:not([hidden]) .receipt')?.textContent ?? '';
					const approve = surface?.querySelector('[data-plan-action="approve-step"]')?.textContent?.trim();
					return badge === 'Awaiting Approval' && selectedStatus === 'Awaiting Approval'
						&& /^sha256:[0-9a-f]{64}$/.test(digest ?? '')
						&& execution.includes('No execution receipt') && approve === 'Approve this exact step'
						? { badge, selectedStatus, digest, approve }
						: false;
				})()`, 'The plan did not stop before execution at its exact approval boundary.', 60_000);
				return `${proof.badge}; ${proof.selectedStatus}; tool-call evidence ${proof.digest}. No tool was approved or executed.`;
			}
		},
		{
			id: 'exact-step-approved',
			title: 'Issue one exact, expiring approval reference',
			async run({ code, page }) {
				const approved = await approveExactStep(code, page, 'inventory-project');
				return `${approved.selectedStatus} through ${approved.approval}; the unused single-use reference expires at ${approved.expiresAt}.`;
			}
		},
		{
			id: 'first-step-verified',
			title: 'Execute and verify one safe read-only workspace operation',
			async run({ code }) {
				await resumeApprovedStep(code);
				const verified = await waitForVerifiedStep(code, 'inventory-project', 'inspect-readme');
				return `The safe read-only tool executed as ${verified.executionSha256} and verification passed as ${verified.verificationSha256}; ${verified.check}.`;
			}
		},
		{
			id: 'succeeded-plan',
			title: 'Complete all exact approvals and retain proof receipts',
			async run({ code, page }) {
				await approveExactStep(code, page, 'inspect-readme');
				await resumeApprovedStep(code);
				await waitForVerifiedStep(code, 'inspect-readme', 'find-review-boundary');
				await approveExactStep(code, page, 'find-review-boundary');
				await resumeApprovedStep(code);
				await waitForVerifiedStep(code, 'find-review-boundary');
				const completed = await waitForFikeya<CompletedPlanState>(code, `(() => {
					const plan = document.querySelector('.chat-plan-details');
					if (plan) plan.open = true;
					const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
					const planMeta = surface?.querySelector('.plan-heading p')?.textContent?.trim() ?? '';
					const planId = /Durable plan (pln_[a-z0-9]+) /.exec(planMeta)?.[1] ?? '';
					const receipts = Array.from(surface?.querySelectorAll('[data-plan-step]') ?? []).map(step => {
						step.click();
						const stepId = step.getAttribute('data-plan-step') ?? '';
						const detail = surface?.querySelector('[data-plan-detail="' + stepId + '"]:not([hidden])');
						const values = detail ? Array.from(detail.querySelectorAll('.receipt dd')).map(item => item.textContent?.trim() ?? '') : [];
						return {
							stepId,
							status: step.querySelector('.plan-step-status')?.textContent?.trim() ?? '',
							toolCallSha256: values[0] ?? '',
							approval: values[1] ?? '',
							expiresAt: detail?.querySelector('time')?.getAttribute('datetime') ?? '',
							executionSha256: /^ok · (sha256:[0-9a-f]{64})$/.exec(values[3] ?? '')?.[1] ?? '',
							verificationSha256: /^passed · (sha256:[0-9a-f]{64})$/.exec(values[4] ?? '')?.[1] ?? '',
							checks: Array.from(detail?.querySelectorAll('.plan-lines li') ?? []).map(item => item.textContent?.trim() ?? '')
						};
					});
					const recordSha256 = Array.from(surface?.querySelectorAll('.compact-receipt dd code') ?? []).at(-1)?.textContent?.trim() ?? '';
					const valid = surface?.querySelector('.badge')?.textContent?.trim() === 'Succeeded'
						&& /^pln_[a-z0-9]+$/.test(planId)
						&& /^sha256:[0-9a-f]{64}$/.test(recordSha256)
						&& receipts.length === 3
						&& receipts.every(item => item.status === 'Succeeded'
							&& /^sha256:[0-9a-f]{64}$/.test(item.toolCallSha256)
							&& /^apr_[a-z0-9]+ · consumed$/.test(item.approval)
							&& !Number.isNaN(Date.parse(item.expiresAt))
							&& /^sha256:[0-9a-f]{64}$/.test(item.executionSha256)
							&& /^sha256:[0-9a-f]{64}$/.test(item.verificationSha256)
							&& item.checks.length > 0
							&& item.checks.every(check => check.startsWith('✓ ')));
					return valid ? { badge: 'Succeeded', planId, recordSha256, steps: receipts } : false;
				})()`, 'The completed plan did not retain exact approval, execution, verification, and evidence hashes.', 60_000);
				await evaluateFikeya<boolean>(code, `(() => {
					const receipt = document.querySelector('[data-plan-detail="find-review-boundary"]:not([hidden]) .receipt');
					if (!receipt) return false;
					receipt.scrollIntoView({ block: 'center' });
					return true;
				})()`);
				writeCompletedPlanProof(completed.planId);
				return `${completed.badge}: ${completed.steps.length} safe steps retained consumed approvals, tool-call hashes, execution hashes, verification hashes, and passing checks in record ${completed.recordSha256}.`;
			}
		},
		{
			id: 'editor-terminal-layout',
			title: 'Keep Editor UI Chat full-height beside the bottom terminal',
			async run({ code, page }) {
				const switched = await evaluateFikeya<boolean>(code, `(() => {
					const select = document.querySelector('[data-layout-switch]');
					if (!(select instanceof HTMLSelectElement)) return false;
					select.value = 'editor';
					select.dispatchEvent(new Event('change', { bubbles: true }));
					return true;
				})()`);
				if (!switched) {
					throw new Error('The Project UI dropdown did not expose Editor + Chat.');
				}
				await waitFor(
					() => page.evaluate<boolean>(`(() => {
						const auxiliary = document.querySelector('.part.auxiliarybar');
						const rect = auxiliary?.getBoundingClientRect();
						return Boolean(rect && rect.width > 0 && rect.height > 0);
					})()`),
					'The Editor UI did not move Fikeya Chat into the secondary sidebar.',
					30_000
				);
				await waitForFikeya<boolean>(code, `Boolean(document.querySelector('[data-agent-form]'))`, 'The Editor UI Chat composer did not become ready.', 20_000);
				await page.keyboard.press('Control+Backquote');
				const layout = await waitFor(
					() => page.evaluate<{ panelTop: number; panelRight: number; chatLeft: number; chatBottom: number } | false>(`(() => {
						const panel = document.querySelector('.part.panel');
						const auxiliary = document.querySelector('.part.auxiliarybar');
						const panelRect = panel?.getBoundingClientRect();
						const auxiliaryRect = auxiliary?.getBoundingClientRect();
						if (!panelRect || !auxiliaryRect || panelRect.width <= 0 || panelRect.height <= 0 || auxiliaryRect.width <= 0 || auxiliaryRect.height <= 0) return false;
						return panelRect.right <= auxiliaryRect.left + 1 && auxiliaryRect.bottom >= panelRect.bottom - 1
							? { panelTop: panelRect.top, panelRight: panelRect.right, chatLeft: auxiliaryRect.left, chatBottom: auxiliaryRect.bottom }
							: false;
					})()`),
					'The bottom terminal overlapped or shortened the Fikeya Chat sidebar.',
					30_000
				);
				const composerAnchored = await waitForFikeya<boolean>(code, `(() => {
					const form = document.querySelector('[data-agent-form]');
					const rect = form?.getBoundingClientRect();
					return Boolean(rect && rect.width > 0 && rect.bottom <= window.innerHeight + 1 && rect.bottom >= window.innerHeight - 36);
				})()`, 'The Fikeya Chat composer was not anchored after the terminal opened.', 20_000);
				return `Terminal stopped at x=${Math.round(layout.panelRight)} before Chat began at x=${Math.round(layout.chatLeft)}; Chat retained its full-height bottom at y=${Math.round(layout.chatBottom)} with composer anchored=${composerAnchored}.`;
			}
		}
	]
};

module.exports = scenario;
