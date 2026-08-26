/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'));
const readText = relative => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
const distribution = readJson('fikeya-distribution.json');
const productVersion = distribution.version;
const match = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(productVersion);
if (!match) throw new Error(`Unsupported product version: ${productVersion}`);
const pythonVersion = `${match[1]}.${match[2]}.${match[3]}b${match[4]}`;

const checks = [
	['fikeya-runtime/pyproject.toml', /^version = "([^"]+)"$/m, pythonVersion],
	['fikeya-agent-core/pyproject.toml', /^version = "([^"]+)"$/m, pythonVersion],
	['integrations/fikeya-interop/pyproject.toml', /^version = "([^"]+)"$/m, pythonVersion],
	['fikeya-runtime/src/fikeya_runtime/__init__.py', /^__version__ = "([^"]+)"$/m, pythonVersion]
];
for (const [relative, pattern, expected] of checks) {
	const actual = pattern.exec(readText(relative))?.[1];
	if (actual !== expected) throw new Error(`${relative} declares ${actual ?? 'no version'}; expected ${expected} from fikeya-distribution.json`);
}

const extension = readJson('extensions/fikeya-desktop/package.json');
const extensionLock = readJson('extensions/fikeya-desktop/package-lock.json');
if (extension.version !== productVersion || extensionLock.version !== productVersion || extensionLock.packages?.['']?.version !== productVersion) {
	throw new Error('The Desktop extension and lockfile must use the product version from fikeya-distribution.json.');
}

const components = readJson('scripts/fikeya/components.json').components;
for (const id of ['agent-core', 'runtime']) {
	const actual = components.find(component => component.id === id)?.version;
	if (actual !== pythonVersion) throw new Error(`components.json ${id} version ${actual ?? 'missing'} must be ${pythonVersion}.`);
}

console.log(`Fikeya version alignment verified: ${productVersion} / Python ${pythonVersion}`);
