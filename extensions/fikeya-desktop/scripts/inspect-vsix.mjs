/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDirectory, '..');
const sourceManifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
const vsixTarget = process.env.FIKEYA_VSIX_TARGET ?? currentVsixTarget();
const artifactPath = path.resolve(process.argv[2] ?? path.join(extensionRoot, 'artifacts', `fikeya-desktop-${sourceManifest.version}-${vsixTarget}.vsix`));
const entries = await readZipEntries(artifactPath);
const names = [...entries.keys()].sort();

const requiredEntries = [
	'extension/package.json',
	'extension/package.nls.json',
	'extension/readme.md',
	'extension/LICENSE.txt',
	'extension/media/fikeya.svg',
	'extension/out/extension.js',
	'extension/out/imageInputs.js',
	'extension/out/memory.js',
	'extension/out/messageValidation.js',
	'extension/out/runtime.js',
	`extension/runtime/${process.platform === 'win32' ? 'fikeya-runtime.exe' : 'fikeya-runtime'}`,
	'extension/runtime/fikeya-runtime.json',
	'extension/sidecar/qarinah-memory-view.mjs',
	'extension/sidecar/qarinah-runtime.json',
	'extension/third_party/qarinah/LICENSE',
	'extension/third_party/qarinah/NOTICE',
	'extension/third_party/qarinah/THIRD_PARTY_NOTICES.md',
	'extension/third_party/ignore/LICENSE-MIT'
];
for (const required of requiredEntries) {
	if (!entries.has(required)) {
		throw new Error(`VSIX is missing required entry: ${required}`);
	}
}

const forbiddenEntry = names.find(name => /(^|\/)(?:src|test|tests|node_modules|coverage|\.cache|__pycache__|\.qarinah|\.codex)(?:\/|$)/i.test(name)
	|| /(?:\.map|\.ts|\.tsx|\.jsonl|\.sqlite(?:3)?|\.db|\.env|\.pem|\.key|credentials?\.json)$/i.test(name));
if (forbiddenEntry) {
	throw new Error(`VSIX contains forbidden development, ledger, or credential material: ${forbiddenEntry}`);
}

const packageManifest = parseJsonEntry(entries, 'extension/package.json');
if (packageManifest.scripts !== undefined || packageManifest.devDependencies !== undefined || packageManifest.main !== './out/extension') {
	throw new Error('Packaged manifest must exclude build dependencies and retain the compiled extension entrypoint.');
}
if (packageManifest.engines?.vscode !== '^1.110.0') {
	throw new Error('Packaged VSIX must retain the supported VS Code API baseline.');
}
const extensionLicense = entries.get('extension/LICENSE.txt').toString('utf8');
const qarinahLicense = entries.get('extension/third_party/qarinah/LICENSE').toString('utf8');
if (!extensionLicense.includes('GNU AFFERO GENERAL PUBLIC LICENSE') || !extensionLicense.includes('Version 3, 19 November 2007')) {
	throw new Error('VSIX does not contain the full AGPL-3.0 license for the Fikeya-owned extension.');
}
if (!qarinahLicense.includes('Apache License') || !qarinahLicense.includes('Version 2.0, January 2004')) {
	throw new Error('VSIX does not contain Qarinah\'s Apache-2.0 license.');
}
if (entries.get('extension/third_party/qarinah/NOTICE').length === 0) {
	throw new Error('VSIX does not contain Qarinah\'s notice text.');
}
const secretPattern = /(?:sk-or-v1-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
for (const [name, contents] of entries) {
	if (/\.(?:js|mjs|json|md|txt|nls|xml)$/i.test(name) || /(?:LICENSE|NOTICE)$/i.test(name)) {
		if (secretPattern.test(contents.toString('utf8'))) {
			throw new Error(`VSIX contains material resembling a credential: ${name}`);
		}
	}
}
const receipt = parseJsonEntry(entries, 'extension/sidecar/qarinah-runtime.json');
if (receipt.schemaVersion !== 'fikeya.desktop-bundled-runtime.v1'
	|| receipt.packages?.find?.(item => item.name === 'qarinah')?.version !== '0.4.0') {
	throw new Error('Bundled Qarinah runtime receipt is missing or not pinned to 0.4.0.');
}
const bundleHash = `sha256:${createHash('sha256').update(entries.get('extension/sidecar/qarinah-memory-view.mjs')).digest('hex')}`;
if (receipt.bundleSha256 !== bundleHash) {
	throw new Error('Bundled Qarinah runtime hash does not match its receipt.');
}
const pythonRuntimeReceipt = parseJsonEntry(entries, 'extension/runtime/fikeya-runtime.json');
const expectedRuntimeEntry = `extension/${pythonRuntimeReceipt.executable}`;
if (pythonRuntimeReceipt.schemaVersion !== 'fikeya.desktop-bundled-python-runtime.v1'
	|| pythonRuntimeReceipt.target !== vsixTarget || !entries.has(expectedRuntimeEntry)
	|| pythonRuntimeReceipt.packages?.find?.(item => item.name === 'keyring')?.version !== '25.7.0'
	|| pythonRuntimeReceipt.packages?.find?.(item => item.name === 'azure-identity')?.version !== '1.25.3') {
	throw new Error('Bundled standalone Fikeya Runtime receipt is incomplete or targets a different platform.');
}
if (vsixTarget === 'win32-x64') {
	const browser = pythonRuntimeReceipt.browser;
	if (browser?.schemaVersion !== 'fikeya.desktop-browser-payload.v1'
		|| browser.name !== 'chromium-headless-shell'
		|| browser.playwrightVersion !== '1.62.0'
		|| browser.browserVersion !== '151.0.7922.34'
		|| browser.revision !== '1234'
		|| browser.archivePrefix !== 'playwright/driver/package/.local-browsers'
		|| browser.executablePath !== 'chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
		|| browser.executableSha256 !== 'sha256:ce4635cd0e5dc0e21494542a701f347e91c1f1d821970578d97ed8df4ced50ef'
		|| browser.fileCount !== 299
		|| browser.payloadBytes !== 287_667_597
		|| browser.payloadSha256 !== 'sha256:a3ef07d44788de282bfddfd28350b230e9a795a441be39cce585fbca363338dc'
		|| pythonRuntimeReceipt.packages?.find?.(item => item.name === 'playwright')?.version !== '1.62.0'
		|| pythonRuntimeReceipt.packages?.find?.(item => item.name === 'chromium-headless-shell')?.version !== '151.0.7922.34') {
		throw new Error('Bundled Windows browser payload is incomplete or not pinned to the reviewed release.');
	}
}
const runtimeHash = `sha256:${createHash('sha256').update(entries.get(expectedRuntimeEntry)).digest('hex')}`;
if (runtimeHash !== pythonRuntimeReceipt.executableSha256) {
	throw new Error('Bundled standalone Fikeya Runtime hash does not match its receipt.');
}
const declaredRuntimeLicenses = [
	{ path: pythonRuntimeReceipt.pythonLicenseFile, sha256: pythonRuntimeReceipt.pythonLicenseSha256 },
	...pythonRuntimeReceipt.packages.flatMap(item => {
		const files = Array.isArray(item.licenseFiles) ? item.licenseFiles : [item.licenseFile];
		return files.map(licensePath => ({ path: licensePath, sha256: item.licenseSha256?.[licensePath] }));
	})
];
for (const license of declaredRuntimeLicenses) {
	if (typeof license.path !== 'string' || !entries.has(`extension/${license.path}`) || entries.get(`extension/${license.path}`).length === 0) {
		throw new Error(`Bundled standalone Fikeya Runtime license is missing: ${license.path}`);
	}
	const digest = `sha256:${createHash('sha256').update(entries.get(`extension/${license.path}`)).digest('hex')}`;
	if (license.sha256 !== digest) {
		throw new Error(`Bundled standalone Fikeya Runtime license hash is invalid: ${license.path}`);
	}
}

const artifactBytes = (await stat(artifactPath)).size;
const artifactSha256 = `sha256:${createHash('sha256').update(await readFile(artifactPath)).digest('hex')}`;
const report = {
	schemaVersion: 'fikeya.desktop-vsix-inspection.v1',
	artifactPath,
	artifactBytes,
	artifactSha256,
	entryCount: names.length,
	qarinahVersion: '0.4.0',
	bundleSha256: bundleHash,
	runtimeTarget: pythonRuntimeReceipt.target,
	runtimeSha256: runtimeHash,
	browserVersion: pythonRuntimeReceipt.browser?.browserVersion ?? null,
	browserPayloadSha256: pythonRuntimeReceipt.browser?.payloadSha256 ?? null,
	forbiddenEntries: 0
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function parseJsonEntry(zipEntries, name) {
	try {
		return JSON.parse(zipEntries.get(name).toString('utf8'));
	} catch {
		throw new Error(`VSIX entry is not valid JSON: ${name}`);
	}
}

function readZipEntries(filePath) {
	return new Promise((resolve, reject) => {
			yauzl.open(filePath, { lazyEntries: true }, (openError, archive) => {
			if (openError || !archive) {
				reject(openError ?? new Error('Unable to open VSIX archive.'));
				return;
			}
			const result = new Map();
			archive.on('error', reject);
			archive.on('end', () => resolve(result));
			archive.on('entry', entry => {
				const parts = entry.fileName.split('/');
				if (entry.fileName.includes('\\') || entry.fileName.startsWith('/') || parts.includes('..')) {
					reject(new Error(`VSIX contains an unsafe entry path: ${entry.fileName}`));
					archive.close();
					return;
				}
				if (/\/$/.test(entry.fileName)) {
					archive.readEntry();
					return;
				}
				if (result.has(entry.fileName)) {
					reject(new Error(`VSIX contains a duplicate entry: ${entry.fileName}`));
					archive.close();
					return;
				}
				const entryLimit = /extension\/runtime\/fikeya-runtime(?:\.exe)?$/.test(entry.fileName)
					? 192 * 1024 * 1024
					: 4 * 1024 * 1024;
				if (entry.uncompressedSize > entryLimit) {
					reject(new Error(`VSIX entry exceeds its inspection limit: ${entry.fileName}`));
					archive.close();
					return;
				}
				archive.openReadStream(entry, (streamError, stream) => {
					if (streamError || !stream) {
						reject(streamError ?? new Error(`Unable to inspect ${entry.fileName}.`));
						return;
					}
					const chunks = [];
					stream.on('data', chunk => chunks.push(chunk));
					stream.on('error', reject);
					stream.on('end', () => {
						result.set(entry.fileName, Buffer.concat(chunks));
						archive.readEntry();
					});
				});
			});
			archive.readEntry();
		});
	});
}

function currentVsixTarget() {
	const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
	if (process.platform === 'win32') return `win32-${architecture}`;
	if (process.platform === 'darwin') return `darwin-${architecture}`;
	if (process.platform === 'linux') return `linux-${architecture}`;
	throw new Error(`Unsupported VSIX platform: ${process.platform}/${process.arch}`);
}
