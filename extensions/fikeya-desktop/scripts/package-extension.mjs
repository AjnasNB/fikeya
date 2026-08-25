/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(extensionRoot, '..', '..');
const stagingRoot = path.join(extensionRoot, '.package', 'extension');
const artifactRoot = path.join(extensionRoot, 'artifacts');
const runtimeBuildRoot = path.join(extensionRoot, '.runtime-build');
const sourcePackage = await readJson(path.join(extensionRoot, 'package.json'));
const lock = await readJson(path.join(extensionRoot, 'package-lock.json'));
const qarinahPackagePath = path.join(extensionRoot, 'node_modules', 'qarinah');
const qarinahPackage = await readJson(path.join(qarinahPackagePath, 'package.json'));
const qarinahLock = lock.packages?.['node_modules/qarinah'];
const ignoreLock = lock.packages?.['node_modules/ignore'];
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH ?? '1767225600';
const vsixTarget = process.env.FIKEYA_VSIX_TARGET ?? currentVsixTarget();

if (!/^\d{10}$/.test(sourceDateEpoch) || Number(sourceDateEpoch) < 315_532_800) {
	throw new Error('SOURCE_DATE_EPOCH must be a ten-digit Unix timestamp no earlier than 1980-01-01.');
}

assertPinnedPackage('qarinah', sourcePackage.devDependencies?.qarinah, qarinahPackage.version, qarinahLock);
assertPinnedPackage('ignore', qarinahPackage.dependencies?.ignore, ignoreLock?.version, ignoreLock);
if (sourcePackage.license !== 'AGPL-3.0-or-later') {
	throw new Error('The extension package must retain its AGPL-3.0-or-later license identity.');
}

await rm(path.dirname(stagingRoot), { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });

const pythonCommand = process.env.FIKEYA_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const runtimeBuild = spawnSync(pythonCommand, [
	path.join(extensionRoot, 'scripts', 'build-fikeya-runtime.py'),
	'--extension-root',
	extensionRoot,
	'--repository-root',
	repositoryRoot,
	'--target',
	vsixTarget
], {
	cwd: extensionRoot,
	env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true
});
if (runtimeBuild.status !== 0) {
	throw new Error(`Standalone Fikeya Runtime build failed.\n${boundedOutput(runtimeBuild.stderr || runtimeBuild.stdout)}`);
}
const pythonRuntimeBuildReceipt = await readJson(path.join(runtimeBuildRoot, 'build-receipt.json'));
if (pythonRuntimeBuildReceipt.target !== vsixTarget || pythonRuntimeBuildReceipt.schemaVersion !== 'fikeya.desktop-python-runtime-build.v1') {
	throw new Error('Standalone Fikeya Runtime build receipt does not match the requested VSIX target.');
}

const packagedManifest = { ...sourcePackage };
delete packagedManifest.devDependencies;
delete packagedManifest.scripts;
packagedManifest.repository = {
	type: 'git',
	url: 'https://github.com/AjnasNB/fikeya.git',
	directory: 'extensions/fikeya-desktop'
};
await writeJson(path.join(stagingRoot, 'package.json'), packagedManifest);

await copyRequired('package.nls.json');
await copyRequired('README.md');
await copyRequired(path.join('media', 'fikeya.svg'));
await copyRequired(path.join('themes', 'fikeya-dark-color-theme.json'));
for (const file of ['extension.js', 'memory.js', 'messageValidation.js', 'runtime.js', 'sessionCapture.js']) {
	await copyRequired(path.join('out', file));
}
await copyInto(path.join(repositoryRoot, 'fikeya-runtime', 'LICENSE'), path.join(stagingRoot, 'LICENSE'));
await copyInto(path.join(qarinahPackagePath, 'LICENSE'), path.join(stagingRoot, 'third_party', 'qarinah', 'LICENSE'));
await copyInto(path.join(qarinahPackagePath, 'NOTICE'), path.join(stagingRoot, 'third_party', 'qarinah', 'NOTICE'));
await copyInto(path.join(qarinahPackagePath, 'THIRD_PARTY_NOTICES.md'), path.join(stagingRoot, 'third_party', 'qarinah', 'THIRD_PARTY_NOTICES.md'));
await copyInto(path.join(extensionRoot, 'node_modules', 'ignore', 'LICENSE-MIT'), path.join(stagingRoot, 'third_party', 'ignore', 'LICENSE-MIT'));

const runtimeExecutableSource = path.join(runtimeBuildRoot, 'dist', pythonRuntimeBuildReceipt.executable);
const runtimeExecutableTarget = path.join(stagingRoot, 'runtime', pythonRuntimeBuildReceipt.executable);
await copyInto(runtimeExecutableSource, runtimeExecutableTarget);
const packagedRuntimeLicenses = [];
for (const item of pythonRuntimeBuildReceipt.packages) {
	if (!item || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(item.name)
		|| !/^licenses\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(item.licenseFile)) {
		throw new Error('Standalone Fikeya Runtime build receipt contains an unsafe license path.');
	}
	const packagedPath = path.join('third_party', 'python-runtime', item.name, path.basename(item.licenseFile));
	await copyInto(path.join(runtimeBuildRoot, item.licenseFile), path.join(stagingRoot, packagedPath));
	packagedRuntimeLicenses.push({ ...item, licenseFile: packagedPath.replaceAll('\\', '/') });
}
const pythonLicensePath = path.join('third_party', 'python-runtime', 'python', 'LICENSE.txt');
await copyInto(path.join(runtimeBuildRoot, pythonRuntimeBuildReceipt.pythonLicenseFile), path.join(stagingRoot, pythonLicensePath));
const bundledPythonRuntimeReceipt = {
	...pythonRuntimeBuildReceipt,
	schemaVersion: 'fikeya.desktop-bundled-python-runtime.v1',
	executable: `runtime/${pythonRuntimeBuildReceipt.executable}`,
	executableSha256: await sha256File(runtimeExecutableTarget),
	packages: packagedRuntimeLicenses,
	pythonLicenseFile: pythonLicensePath.replaceAll('\\', '/')
};
await writeJson(path.join(stagingRoot, 'runtime', 'fikeya-runtime.json'), bundledPythonRuntimeReceipt);

// The VSIX and the Code OSS desktop build consume different extension trees. Keep the
// generated, ignored desktop runtime in sync with the exact executable inspected below.
// This prevents a successful VSIX build from leaving an older runtime in a subsequent
// native desktop installer.
const desktopRuntimeRoot = path.join(extensionRoot, 'runtime');
await mkdir(desktopRuntimeRoot, { recursive: true });
await copyInto(runtimeExecutableSource, path.join(desktopRuntimeRoot, pythonRuntimeBuildReceipt.executable));
await writeJson(path.join(desktopRuntimeRoot, 'fikeya-runtime.json'), bundledPythonRuntimeReceipt);

const bundledSidecar = path.join(stagingRoot, 'sidecar', 'qarinah-memory-view.mjs');
await mkdir(path.dirname(bundledSidecar), { recursive: true });
const buildResult = await build({
	entryPoints: [path.join(extensionRoot, 'sidecar', 'qarinah-memory-view.mjs')],
	outfile: bundledSidecar,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	alias: {
		'fikeya-qarinah-dashboard': path.join(qarinahPackagePath, 'src', 'dashboard.js'),
		'fikeya-qarinah-compiler': path.join(qarinahPackagePath, 'src', 'compiler.js'),
		'fikeya-qarinah-redact': path.join(qarinahPackagePath, 'src', 'redact.js'),
		'fikeya-qarinah-store': path.join(qarinahPackagePath, 'src', 'store.js'),
		'fikeya-qarinah-workspace': path.join(qarinahPackagePath, 'src', 'workspace.js')
	},
	metafile: true,
	legalComments: 'none',
	sourcemap: false,
	logLevel: 'warning'
});

const bundledInputs = Object.keys(buildResult.metafile.inputs).map(input => input.replaceAll('\\', '/')).sort();
const unexpectedDependency = bundledInputs.find(input => input.includes('node_modules/')
	&& !input.includes('node_modules/qarinah/src/')
	&& !input.endsWith('node_modules/ignore/index.js'));
if (unexpectedDependency) {
	throw new Error(`Unexpected runtime dependency in Qarinah bundle: ${unexpectedDependency}`);
}
if (!bundledInputs.some(input => input.endsWith('node_modules/qarinah/src/dashboard.js'))) {
	throw new Error('The bundled sidecar does not contain the pinned Qarinah dashboard runtime.');
}
if (!bundledInputs.some(input => input.endsWith('node_modules/qarinah/src/compiler.js'))) {
	throw new Error('The bundled sidecar does not contain the pinned Qarinah context compiler.');
}
if (!bundledInputs.some(input => input.endsWith('node_modules/qarinah/src/store.js'))) {
	throw new Error('The bundled sidecar does not contain the pinned Qarinah event store.');
}
if (!bundledInputs.some(input => input.endsWith('node_modules/qarinah/src/redact.js'))) {
	throw new Error('The bundled sidecar does not contain the pinned Qarinah redactor.');
}
if (!bundledInputs.some(input => input.endsWith('node_modules/qarinah/src/workspace.js'))) {
	throw new Error('The bundled sidecar does not contain the pinned Qarinah workspace runtime.');
}

const runtimeReceipt = {
	schemaVersion: 'fikeya.desktop-bundled-runtime.v1',
	entrypoint: 'sidecar/qarinah-memory-view.mjs',
	bundleSha256: await sha256File(bundledSidecar),
	packages: [
		packageReceipt('qarinah', qarinahPackage.version, qarinahPackage.license, qarinahLock.integrity),
		packageReceipt('ignore', ignoreLock.version, ignoreLock.license, ignoreLock.integrity)
	],
	inputFiles: bundledInputs.map(input => path.relative(extensionRoot, path.resolve(extensionRoot, input)).replaceAll('\\', '/'))
};
await writeJson(path.join(stagingRoot, 'sidecar', 'qarinah-runtime.json'), runtimeReceipt);

const artifactPath = path.join(artifactRoot, `fikeya-desktop-${sourcePackage.version}-${vsixTarget}.vsix`);
await rm(artifactPath, { force: true });
const vscePath = path.join(extensionRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
const packaged = spawnSync(process.execPath, [vscePath, 'package', '--no-dependencies', '--target', vsixTarget, '--out', artifactPath], {
	cwd: stagingRoot,
	env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true
});
if (packaged.status !== 0) {
	throw new Error(`VSIX packaging failed.\n${boundedOutput(packaged.stderr || packaged.stdout)}`);
}

process.stdout.write(`${JSON.stringify({
	artifactPath,
	sha256: await sha256File(artifactPath),
	target: vsixTarget,
	runtimeSha256: await sha256File(runtimeExecutableTarget),
	qarinahVersion: qarinahPackage.version,
	qarinahIntegrity: qarinahLock.integrity
}, null, 2)}\n`);

async function copyRequired(relativePath) {
	return copyInto(path.join(extensionRoot, relativePath), path.join(stagingRoot, relativePath));
}

async function copyInto(source, target) {
	await mkdir(path.dirname(target), { recursive: true });
	await copyFile(source, target);
}

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sha256File(filePath) {
	return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
}

function assertPinnedPackage(name, declaredVersion, installedVersion, lockedPackage) {
	if (!lockedPackage || declaredVersion !== installedVersion || lockedPackage.version !== installedVersion
		|| typeof lockedPackage.integrity !== 'string' || !lockedPackage.integrity.startsWith('sha512-')) {
		throw new Error(`${name} must be installed from the exact integrity-pinned package lock.`);
	}
}

function packageReceipt(name, version, license, integrity) {
	return { name, version, license, integrity };
}

function boundedOutput(value) {
	return String(value).replaceAll(extensionRoot, '<extension>').slice(0, 4_096);
}

function currentVsixTarget() {
	const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
	if (process.platform === 'win32') {
		return `win32-${architecture}`;
	}
	if (process.platform === 'darwin') {
		return `darwin-${architecture}`;
	}
	if (process.platform === 'linux') {
		return `linux-${architecture}`;
	}
	throw new Error(`Unsupported VSIX platform: ${process.platform}/${process.arch}`);
}
