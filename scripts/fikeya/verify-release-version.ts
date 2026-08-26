/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const expectedTag = process.argv[2];

if (!expectedTag || !/^v\d+\.\d+\.\d+-beta\.\d+$/.test(expectedTag)) {
	throw new Error('Usage: node scripts/fikeya/verify-release-version.ts v<major>.<minor>.<patch>-beta.<number>');
}

const distribution = JSON.parse(readFileSync(path.join(repositoryRoot, 'fikeya-distribution.json'), 'utf8'));
const publicVersion = expectedTag.slice(1);
assert.equal(distribution.version, publicVersion, 'Git tag and fikeya-distribution.json must agree');
assert.match(distribution.desktopNumericVersion, /^\d+\.\d+\.\d+\.\d+$/, 'Desktop numeric version must have four fields');

const betaMatch = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(publicVersion);
assert.ok(betaMatch, 'The public prerelease must use the beta version convention');
const pythonVersion = `${betaMatch[1]}.${betaMatch[2]}.${betaMatch[3]}b${betaMatch[4]}`;
const desktopNumericVersion = `${betaMatch[1]}.${betaMatch[2]}.${betaMatch[3]}.${betaMatch[4]}`;
assert.equal(distribution.desktopNumericVersion, desktopNumericVersion, 'Desktop numeric version must match the public beta');

const readText = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
const readJson = (relativePath: string) => JSON.parse(readText(relativePath));
const projectVersion = (relativePath: string) => {
	const match = /^version = "([^"]+)"$/m.exec(readText(relativePath));
	assert.ok(match, `Missing project version in ${relativePath}`);
	return match[1];
};

assert.equal(projectVersion('fikeya-agent-core/pyproject.toml'), pythonVersion);
assert.equal(projectVersion('fikeya-runtime/pyproject.toml'), pythonVersion);
assert.equal(projectVersion('integrations/fikeya-interop/pyproject.toml'), pythonVersion);

const runtimeProject = readText('fikeya-runtime/pyproject.toml');
assert.ok(runtimeProject.includes(`fikeya-agent-core==${pythonVersion}`), 'Runtime dependency must match Agent Core');

const extension = readJson('extensions/fikeya-desktop/package.json');
const extensionLock = readJson('extensions/fikeya-desktop/package-lock.json');
assert.equal(extension.version, extensionLock.version, 'VSIX manifest and lock version must agree');
assert.equal(extension.version, extensionLock.packages?.['']?.version, 'VSIX root lock entry must agree');

const components = readJson('scripts/fikeya/components.json');
const componentVersions = new Map(components.components.map((component: { id: string; version: string }) => [component.id, component.version]));
assert.equal(componentVersions.get('agent-core'), pythonVersion);
assert.equal(componentVersions.get('runtime'), pythonVersion);

process.stdout.write(`${JSON.stringify({
	ok: true,
	tag: expectedTag,
	publicVersion,
	desktopNumericVersion: distribution.desktopNumericVersion,
	pythonVersion,
	extensionVersion: extension.version
})}\n`);
