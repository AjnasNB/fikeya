/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs');
const path = require('path');

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

const workspacePath = process.env.FIKEYA_CAPTURE_WORKSPACE;
if (!workspacePath || !path.isAbsolute(workspacePath)) {
	throw new Error('FIKEYA_CAPTURE_WORKSPACE must name the absolute disposable proof workspace.');
}
const providerName = process.env.FIKEYA_CAPTURE_PROVIDER_NAME;
const providerOutput = process.env.FIKEYA_CAPTURE_PROVIDER_OUTPUT;
if (!providerName || !providerOutput) {
	throw new Error('FIKEYA_CAPTURE_PROVIDER_NAME and FIKEYA_CAPTURE_PROVIDER_OUTPUT must describe the deterministic proof provider.');
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
					const consent = document.querySelector('[data-network-consent]');
					if (!form || !prompt || !provider || !contextBudget || !consent) return false;
					provider.value = ${JSON.stringify(providerName)};
					provider.dispatchEvent(new Event('change', { bubbles: true }));
					// The control has min=512 and step=256. Use a value on that exact
					// lattice so native form validation cannot suppress requestSubmit().
					contextBudget.value = '12032';
					contextBudget.dispatchEvent(new Event('input', { bubbles: true }));
					prompt.value = 'Inspect this proof workspace and explain what the bounded project evidence verifies.';
					prompt.dispatchEvent(new Event('input', { bubbles: true }));
					consent.checked = true;
					consent.dispatchEvent(new Event('change', { bubbles: true }));
					if (!form.checkValidity()) return false;
					form.requestSubmit();
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
			id: 'reviewed-plan',
			title: 'Review the immutable plan without approving tools',
			async run({ code }) {
				const clicked = await evaluateFikeya<boolean>(code, `(() => {
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
		}
	]
};

module.exports = scenario;
