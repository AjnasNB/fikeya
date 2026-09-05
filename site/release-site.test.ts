// Fikeya product delivery and measurement tooling.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareReleaseSite, releaseSiteMetadata, renderReleasedPage } from './release-site.ts';
import { preventUpdateReset } from './deployment-check.ts';

test('website-only deploys cannot reset or replace an active release', () => {
	preventUpdateReset({enabled: false}, {enabled: false});
	const live = {enabled: true, version: 'a'.repeat(40), productVersion: 'v0.1.0-beta.8', assets: {x: {url: 'artifact'}}};
	preventUpdateReset(live, structuredClone(live));
	assert.throws(() => preventUpdateReset(live, {enabled: false}));
	assert.throws(() => preventUpdateReset(live, {...live, version: 'b'.repeat(40)}));
	assert.throws(() => preventUpdateReset(live, {...live, assets: {}}));
});

test('both website deployment commands preserve the released feed', async () => {
	const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
	for (const name of ['deploy', 'deploy:worker']) {
		assert(pkg.scripts[name].includes('node deployment-check.ts && wrangler'));
	}
});

const expected = { commit: 'a'.repeat(40), version: '0.1.0-beta.8', extensionVersion: '0.1.0-beta.8', signer: 'CN=Fixture signer' };
const fixture = () => ({
	schemaVersion: 1, product: 'Fikeya', commit: expected.commit, version: expected.version,
	artifacts: [
		{ name: 'FikeyaSetup-0.1.0-beta.8-win32-x64.exe', bytes: 10, sha256: 'b'.repeat(64), authenticodeStatus: 'Valid', signer: expected.signer, timestampSigner: 'CN=Fixture timestamp' },
		{ name: 'fikeya-desktop-0.1.0-beta.8-win32-x64.vsix', bytes: 10, sha256: 'c'.repeat(64) },
		{ name: 'fikeya-cli-0.1.0-beta.8.zip', bytes: 10, sha256: 'd'.repeat(64) }
	]
});
test('signed metadata binds all downloads to the exact release', () => {
	const result = releaseSiteMetadata(fixture(), expected);
	assert.equal(result.commit, expected.commit);
	assert.equal(result.assets.cli.url, 'https://github.com/AjnasNB/fikeya/releases/download/v0.1.0-beta.8/fikeya-cli-0.1.0-beta.8.zip');
	const page = renderReleasedPage('<a href="https://github.com/AjnasNB/fikeya/releases/download/v0.1.0-beta.1/fikeya-cli-0.1.0-beta.1.zip">CLI</a>', result);
	assert(page.includes(result.assets.cli.url));
	assert(!page.includes('beta.1'));
});
test('unsigned, mismatched, duplicate and incomplete artifacts never publish a feed', () => {
	for (const mutate of [
		m => { m.commit = 'e'.repeat(40); },
		m => { m.version = '0.1.0-beta.1'; },
		m => { m.artifacts[0].authenticodeStatus = 'NotSigned'; },
		m => { m.artifacts[0].signer = 'CN=Wrong'; },
		m => { m.artifacts[0].timestampSigner = ''; },
		m => { m.artifacts.pop(); },
		m => { m.artifacts.push(m.artifacts[0]); },
		m => { m.artifacts[1].sha256 = 'invalid'; }
	]) {
		const manifest = fixture(); mutate(manifest);
		assert.throws(() => releaseSiteMetadata(manifest, expected));
	}
});

test('release preparation hashes files before updating actual download HTML and feed', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'fikeya-release-site-test-'));
	t.after(() => rm(directory, {recursive: true, force: true}));
	const artifacts = path.join(directory, 'artifacts');
	const output = path.join(directory, 'site');
	await mkdir(artifacts);
	await mkdir(path.join(output, 'updates'), {recursive: true});
	const html = await readFile(new URL('./download/index.html', import.meta.url), 'utf8');
	await writeFile(path.join(output, 'index.html'), html);
	const manifest = fixture();
	for (const item of manifest.artifacts) {
		const contents = Buffer.from(item.name);
		item.bytes = contents.length;
		item.sha256 = createHash('sha256').update(contents).digest('hex');
		await writeFile(path.join(artifacts, item.name), contents);
	}
	await writeFile(path.join(artifacts, 'release-verification.json'), JSON.stringify(manifest));
	const installer = manifest.artifacts[0];
	await writeFile(path.join(artifacts, installer.name), Buffer.alloc(installer.bytes));
	await assert.rejects(prepareReleaseSite(artifacts, expected, output), /checksum mismatch/u);
	assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), html);
	await assert.rejects(readFile(path.join(output, 'updates', 'latest.json')), {code: 'ENOENT'});
	await writeFile(path.join(artifacts, installer.name), installer.name);
	const release = await prepareReleaseSite(artifacts, expected, output);
	const published = await readFile(path.join(output, 'index.html'), 'utf8');
	for (const asset of Object.values(release.assets)) assert(published.includes(asset.url));
	assert(!published.includes('/download/v0.1.0-beta.1/'));
	assert(!published.includes('Unsigned beta;'));
	assert(!published.includes('unpublished source candidate'));
	const feed = JSON.parse(await readFile(path.join(output, 'updates', 'latest.json'), 'utf8'));
	assert.equal(feed.enabled, true);
	assert.equal(feed.version, expected.commit);
	assert.equal(feed.assets['win32-x64-user'].sha256, installer.sha256);
});
