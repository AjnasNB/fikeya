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
		readonly keyboard: { press(key: string): Promise<unknown> };
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
	readonly planTab?: string;
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
	readonly planTabVisible: boolean;
	readonly openPlanVisible: boolean;
	readonly promptVisible: boolean;
	readonly sendVisible: boolean;
	readonly createPlanVisible: boolean;
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

const planSpecification = {
	schemaVersion: 1,
	title: 'Verify the real Fikeya proof workspace',
	steps: [
		{
			stepId: 'inventory-project',
			title: 'Inventory bounded project files',
			toolCall: {
				callId: 'proof-list-files',
				name: 'workspace.list_files',
				arguments: { path: '.' }
			},
			verify: { expectedStatus: 'ok' }
		},
		{
			stepId: 'inspect-readme',
			title: 'Inspect the proof workspace brief',
			dependsOn: ['inventory-project'],
			toolCall: {
				callId: 'proof-read-readme',
				name: 'workspace.read_file',
				arguments: { path: 'README.md' }
			},
			verify: { expectedStatus: 'ok' }
		},
		{
			stepId: 'find-review-boundary',
			title: 'Find the explicit review boundary',
			dependsOn: ['inspect-readme'],
			toolCall: {
				callId: 'proof-search-review',
				name: 'workspace.search_text',
				arguments: { path: '.', query: 'reviewable plan' }
			},
			verify: { expectedStatus: 'ok' }
		}
	]
};

const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

let proofWindowBounds: DesktopWindowBounds | undefined;

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
	await page.evaluate<void>(`window.resizeTo(${proofWindowBounds.width}, ${proofWindowBounds.height})`);
	await waitForFikeya<number>(
		code,
		'window.innerWidth >= 700 ? window.innerWidth : false',
		'The proof window did not return to its wide layout.',
		15_000
	);
	proofWindowBounds = undefined;
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

async function approveExactStep(
	code: ScenarioCode,
	page: ScenarioContext['page'],
	stepId: string
): Promise<IssuedApprovalState> {
	const clicked = await evaluateFikeya<boolean>(code, `(() => {
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
						const chatTab = document.querySelector('[data-surface-tab="chat"]');
						const provider = document.querySelector('[data-agent-form] [name="providerName"]');
						if (!prompt || !chatTab || !provider || !Array.from(provider.options).some(option => option.value === ${JSON.stringify(providerName)})) return false;
						chatTab.click();
						return !document.querySelector('[data-surface-panel="chat"]').hidden;
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
					const metrics = Object.fromEntries(Array.from(document.querySelectorAll('.run-metric')).map(item => [
						item.querySelector('span')?.textContent?.trim(),
						item.querySelector('strong')?.textContent?.trim()
					]));
					const value = {
						assistant,
						chatVisible: !document.querySelector('[data-surface-panel="chat"]')?.hidden,
						planTab: document.querySelector('[data-surface-tab="plan"]')?.textContent?.trim(),
						provider: metrics['Provider / Model'],
						usage: metrics,
						usageBasis: document.querySelector('.usage-basis')?.textContent?.trim()
					};
					return value.chatVisible
						&& value.planTab === 'Plan'
						&& value.assistant === ${JSON.stringify(providerOutput)}
						&& value.provider === ${JSON.stringify(`${providerName} / fikeya-proof-model`)}
						&& value.usage['Input Tokens'] === '60'
						&& value.usage['Cached Input Tokens'] === '12'
						&& value.usage['Output Tokens'] === '15'
						&& value.usageBasis.includes('provider-reported')
						? value
						: false;
				})()`, 'Chat did not render the successful assistant response and exact provider-reported usage.', 90_000);
				return `Completed a real three-call Chat turn through ${state.provider}; visible usage is ${state.usage['Input Tokens']} input, ${state.usage['Cached Input Tokens']} cached input, and ${state.usage['Output Tokens']} output tokens.`;
			}
		},
		{
			id: 'draft-plan',
			title: 'Create a durable draft through the Plan form',
			async run({ code }) {
				const specification = JSON.stringify(JSON.stringify(planSpecification, null, 2));
				const submitted = await evaluateFikeya<boolean>(code, `(() => {
					const planTab = document.querySelector('[data-surface-tab="plan"]');
					planTab?.click();
					const form = document.querySelector('[data-plan-create-form]');
					const textarea = form?.querySelector('[name="specification"]');
					if (!form || !textarea) return false;
					textarea.value = ${specification};
					textarea.dispatchEvent(new Event('input', { bubbles: true }));
					form.requestSubmit();
					return true;
				})()`);
				if (!submitted) {
					throw new Error('The Plan form was not available after selecting the Plan tab.');
				}
				const draft = await waitForFikeya<DraftState>(code, `(() => {
					const surface = document.querySelector('[aria-labelledby="plan-surface-title"]');
					const title = surface?.querySelector('#plan-surface-title')?.textContent?.trim();
					const badge = surface?.querySelector('.badge')?.textContent?.trim();
					const steps = surface?.querySelectorAll('[data-plan-step]').length ?? 0;
					return title === 'Verify the real Fikeya proof workspace' && badge === 'Draft' && steps === 3
						? { title, badge, steps }
						: false;
				})()`, 'The runtime did not persist and render the exact draft plan.', 60_000);
				return `Rendered durable ${draft.badge.toLowerCase()} "${draft.title}" with ${draft.steps} exact steps.`;
			}
		},
		{
			id: 'narrow-chat-panel',
			title: 'Use Chat and its current Plan at a 360px-class panel width',
			async run({ code, page }) {
				proofWindowBounds = await page.evaluate<DesktopWindowBounds>('({ width: window.outerWidth, height: window.outerHeight })');
				await evaluateFikeya<boolean>(code, `(() => {
					const chatTab = document.querySelector('[data-surface-tab="chat"]');
					if (!chatTab) return false;
					chatTab.click();
					return true;
				})()`);
				await resizeFikeyaPanel(code, page, 380);
				const narrow = await waitForFikeya<NarrowPanelState>(code, `(() => {
					const visible = element => {
						if (!element || element.hidden) return false;
						const rect = element.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= window.innerWidth + 1;
					};
					const chatTab = document.querySelector('[data-surface-tab="chat"]');
					const planTab = document.querySelector('[data-surface-tab="plan"]');
					const openPlan = document.querySelector('[data-open-plan]');
					const prompt = document.querySelector('[data-agent-form] [name="prompt"]');
					const send = document.querySelector('[data-agent-run]');
					const moreOptions = document.querySelector('.run-controls > summary');
					const value = {
						viewportWidth: window.innerWidth,
						documentWidth: document.documentElement.scrollWidth,
						bodyWidth: document.body.scrollWidth,
						chatVisible: !document.querySelector('[data-surface-panel="chat"]')?.hidden && visible(chatTab),
						planTabVisible: visible(planTab),
						openPlanVisible: visible(openPlan),
						promptVisible: visible(prompt),
						sendVisible: visible(send),
						moreOptionsVisible: visible(moreOptions)
					};
					return value.viewportWidth >= 340 && value.viewportWidth <= 420
						&& value.documentWidth <= value.viewportWidth + 1
						&& value.bodyWidth <= value.viewportWidth + 1
						&& Object.entries(value).filter(([key]) => key.endsWith('Visible')).every(([, shown]) => shown === true)
						? value
						: false;
				})()`, 'The real Chat panel overflowed or hid a primary control at its narrow width.', 20_000);
				const planOpened = await evaluateFikeya<boolean>(code, `(() => {
					const openPlan = document.querySelector('[data-open-plan]');
					if (!openPlan) return false;
					openPlan.click();
					const panel = document.querySelector('[data-surface-panel="plan"]');
					const review = document.querySelector('[data-plan-action="review"]');
					const rect = review?.getBoundingClientRect();
					const usable = !panel?.hidden && rect && rect.width > 0 && rect.right <= window.innerWidth + 1;
					document.querySelector('[data-surface-tab="chat"]')?.click();
					document.querySelector('[data-agent-form]')?.scrollIntoView({ block: 'end' });
					return Boolean(usable);
				})()`);
				if (!planOpened) {
					throw new Error('Open Plan did not expose the draft review control at the narrow panel width.');
				}
				const optionsReachable = await evaluateFikeya<boolean>(code, `(() => {
					const options = document.querySelector('.run-controls');
					if (!options) return false;
					options.open = true;
					const createPlan = document.querySelector('[data-agent-plan]');
					const rect = createPlan?.getBoundingClientRect();
					return Boolean(rect && rect.width > 0 && rect.right <= window.innerWidth + 1);
				})()`);
				if (!optionsReachable) {
					throw new Error('More chat options did not expose Create plan at the narrow panel width.');
				}
				return `At ${narrow.viewportWidth}px, Chat, Plan, Open Plan, the composer, Send, and the compact More options menu remained usable with no horizontal document overflow.`;
			}
		},
		{
			id: 'narrow-memory-graph',
			title: 'Select a real Qarinah memory node at the narrow panel width',
			async run({ code }) {
				const opened = await evaluateFikeya<boolean>(code, `(() => {
					const contextTab = document.querySelector('[data-surface-tab="context"]');
					if (!contextTab) return false;
					contextTab.click();
					return true;
				})()`);
				if (!opened) {
					throw new Error('The Context tab was not available at the narrow panel width.');
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
					document.querySelector('[data-surface-tab="plan"]')?.click();
					const button = document.querySelector('[data-plan-action="review"]');
					if (!button || button.disabled) return false;
					button.click();
					return true;
				})()`);
				if (!clicked) {
					throw new Error('The immutable review action was not available on the draft.');
				}
				const reviewed = await waitForFikeya<ReviewedState>(code, `(() => {
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
					const button = document.querySelector('[data-plan-action="run"]');
					if (!button || button.disabled) return false;
					button.click();
					return true;
				})()`);
				if (!clicked) {
					throw new Error('The reviewed plan could not be started to its approval boundary.');
				}
				await waitForFikeya<boolean>(code, `(() => {
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
		}
	]
};

module.exports = scenario;
