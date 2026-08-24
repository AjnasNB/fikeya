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
	|| pythonRuntimeReceipt.packages?.find?.(item => item.name === 'keyring')?.version !== '25.7.0') {
	throw new Error('Bundled standalone Fikeya Runtime receipt is incomplete or targets a different platform.');
}
const runtimeHash = `sha256:${createHash('sha256').update(entries.get(expectedRuntimeEntry)).digest('hex')}`;
if (runtimeHash !== pythonRuntimeReceipt.executableSha256) {
	throw new Error('Bundled standalone Fikeya Runtime hash does not match its receipt.');
}
const declaredRuntimeLicenses = [pythonRuntimeReceipt.pythonLicenseFile, ...pythonRuntimeReceipt.packages.map(item => item.licenseFile)];
for (const licensePath of declaredRuntimeLicenses) {
	if (typeof licensePath !== 'string' || !entries.has(`extension/${licensePath}`) || entries.get(`extension/${licensePath}`).length === 0) {
		throw new Error(`Bundled standalone Fikeya Runtime license is missing: ${licensePath}`);
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
				if (/\/$/.test(entry.fileName)) {
					archive.readEntry();
					return;
				}
				const entryLimit = /extension\/runtime\/fikeya-runtime(?:\.exe)?$/.test(entry.fileName)
					? 16 * 1024 * 1024
					: 4 * 1024 * 1024;
				if (entry.uncompressedSize > entryLimit) {
					reject(new Error(`VSIX entry exceeds the four-megabyte inspection limit: ${entry.fileName}`));
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
