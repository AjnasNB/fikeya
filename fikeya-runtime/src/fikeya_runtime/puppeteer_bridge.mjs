// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Fikeya contributors

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_GUARDS = 128;
const moduleRoot = process.argv[2];
const chromeExecutable = process.argv[3] || undefined;
const expectedPackage = process.argv[4];
const expectedVersion = process.argv[5];
const expectedLockSha256 = process.argv[6];
const pendingGuards = new Map();
let browser;
let context;
let page;
let cdp;
let guardSequence = 0;

const send = value => {
	const payload = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
		process.stdout.write(`${JSON.stringify({ type: 'fatal', reason: 'oversized' })}\n`);
		process.exitCode = 2;
		return;
	}
	process.stdout.write(payload);
};

const boundedText = value => {
	const bytes = Buffer.from(String(value), 'utf8');
	if (bytes.length <= MAX_SNAPSHOT_BYTES) {
		return bytes.toString('utf8');
	}
	return bytes.subarray(0, MAX_SNAPSHOT_BYTES).toString('utf8');
};

const withTimeout = async (promise, timeoutMs) => {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

let puppeteer;
let puppeteerVersion;
let puppeteerPackage;
try {
	if (!moduleRoot) {
		throw new Error('module root is required');
	}
	if (!['puppeteer', 'puppeteer-core'].includes(expectedPackage) || !expectedVersion
		|| !/^[a-f0-9]{64}$/.test(expectedLockSha256)) {
		throw new Error('reviewed package provenance is required');
	}
	const lockBytes = readFileSync(resolve(moduleRoot, 'package-lock.json'));
	if (createHash('sha256').update(lockBytes).digest('hex') !== expectedLockSha256) {
		throw new Error('package lock changed');
	}
	const reviewedRequire = createRequire(resolve(moduleRoot, 'package.json'));
	puppeteer = reviewedRequire(expectedPackage);
	puppeteerVersion = reviewedRequire(`${expectedPackage}/package.json`).version;
	puppeteerPackage = expectedPackage;
	if (puppeteerVersion !== expectedVersion) {
		throw new Error('package version changed');
	}
} catch {
	send({ type: 'unavailable' });
	process.exitCode = 2;
}

const requestPermission = url => new Promise(resolveGuard => {
	if (pendingGuards.size >= MAX_PENDING_GUARDS) {
		resolveGuard(false);
		return;
	}
	guardSequence += 1;
	const requestId = `guard-${guardSequence}`;
	const timer = setTimeout(() => {
		pendingGuards.delete(requestId);
		resolveGuard(false);
	}, 30000);
	pendingGuards.set(requestId, allow => {
		clearTimeout(timer);
		resolveGuard(allow === true);
	});
	send({ type: 'guard', requestId, url });
});

const ensurePage = async () => {
	if (page) {
		return;
	}
	browser = await puppeteer.launch({
		headless: true,
		...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
		args: [
			'--disable-background-networking',
			'--disable-component-update',
			'--disable-extensions',
			'--disable-sync',
			'--no-default-browser-check',
			'--no-first-run',
		],
	});
	context = await browser.createBrowserContext();
	page = await context.newPage();
	await page.setJavaScriptEnabled(true);
	await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
	await page.setRequestInterception(true);
	page.on('request', request => {
		void requestPermission(request.url()).then(async allow => {
			try {
				if (allow) {
					await request.continue();
				} else {
					await request.abort('blockedbyclient');
				}
			} catch {
				// Navigation teardown can settle an intercepted request first.
			}
		});
	});
	page.on('dialog', dialog => void dialog.dismiss().catch(() => undefined));
	page.on('popup', popup => void popup.close().catch(() => undefined));
	cdp = await page.createCDPSession();
	await cdp.send('Network.enable');
	await cdp.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] });
	await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
};

const closeResources = async () => {
	for (const resolveGuard of pendingGuards.values()) {
		resolveGuard(false);
	}
	pendingGuards.clear();
	if (context) {
		await context.close().catch(() => undefined);
	}
	if (browser) {
		await browser.close().catch(() => undefined);
	}
	browser = undefined;
	context = undefined;
	page = undefined;
	cdp = undefined;
};

const requireString = (value, name) => {
	if (typeof value !== 'string') {
		throw new Error(`${name} must be a string`);
	}
	return value;
};

const requireInteger = (value, name) => {
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${name} must be an integer`);
	}
	return value;
};

const runOperation = async (operation, args, timeoutMs) => {
	if (operation === 'close') {
		await closeResources();
		return null;
	}
	await ensurePage();
	if (operation === 'navigate') {
		await page.goto(requireString(args.url, 'url'), { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
		return null;
	}
	if (operation === 'currentUrl') {
		return page.url();
	}
	if (operation === 'inspect') {
		const kind = requireString(args.kind, 'kind');
		if (kind === 'accessible') {
			const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
			return boundedText(JSON.stringify(snapshot));
		}
		if (kind !== 'text') {
			throw new Error('invalid snapshot kind');
		}
		return boundedText(await page.$eval('body', body => body.innerText));
	}
	if (operation === 'click') {
		await page.click(requireString(args.selector, 'selector'));
		return null;
	}
	if (operation === 'type') {
		const selector = requireString(args.selector, 'selector');
		const text = requireString(args.text, 'text');
		await page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
		await page.focus(selector);
		if (args.clear === true) {
			await page.$eval(selector, element => {
				if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
					element.value = '';
					element.dispatchEvent(new Event('input', { bubbles: true }));
				} else if (element instanceof HTMLElement && element.isContentEditable) {
					element.textContent = '';
					element.dispatchEvent(new Event('input', { bubbles: true }));
				} else {
					throw new Error('element is not editable');
				}
			});
		}
		await page.keyboard.type(text);
		return null;
	}
	if (operation === 'scroll') {
		const deltaX = requireInteger(args.deltaX, 'deltaX');
		const deltaY = requireInteger(args.deltaY, 'deltaY');
		await page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: deltaX, y: deltaY });
		return null;
	}
	if (operation === 'screenshot') {
		const bytes = Buffer.from(await page.screenshot({ type: 'png', fullPage: false, captureBeyondViewport: false }));
		if (bytes.length > MAX_SCREENSHOT_BYTES) {
			throw new Error('screenshot is oversized');
		}
		return bytes.toString('base64');
	}
	if (operation === 'wait') {
		const milliseconds = requireInteger(args.milliseconds, 'milliseconds');
		await new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
		return null;
	}
	throw new Error('unknown operation');
};

let commandChain = Promise.resolve();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
	if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
		void closeResources().finally(() => process.exit(2));
		return;
	}
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		void closeResources().finally(() => process.exit(2));
		return;
	}
	if (message?.type === 'guardResult') {
		const pending = pendingGuards.get(message.requestId);
		if (pending) {
			pendingGuards.delete(message.requestId);
			pending(message.allow === true);
		}
		return;
	}
	commandChain = commandChain.then(async () => {
		const requestId = message?.requestId;
		try {
			if (message?.type !== 'command' || typeof requestId !== 'string' || typeof message.operation !== 'string'
				|| typeof message.arguments !== 'object' || message.arguments === null || !Number.isSafeInteger(message.timeoutMs)
				|| message.timeoutMs < 1 || message.timeoutMs > 30000) {
				throw new Error('invalid command');
			}
			const value = await withTimeout(
				runOperation(message.operation, message.arguments, message.timeoutMs),
				message.timeoutMs,
			);
			send({ type: 'result', requestId, ok: true, value });
		} catch {
			send({ type: 'result', requestId, ok: false });
		}
	});
});
input.on('close', () => void closeResources());

if (puppeteer) {
	send({
		type: 'ready',
		package: puppeteerPackage,
		version: String(puppeteerVersion),
		lockSha256: expectedLockSha256,
	});
}
