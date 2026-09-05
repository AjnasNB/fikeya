// Fikeya product delivery and measurement tooling.
import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseSiteMetadata, renderReleasedPage } from './release-site.ts';
import { preventUpdateReset } from './deployment-check.ts';

test('website-only deploys cannot reset or replace an active release', () => {
	preventUpdateReset({enabled: false}, {enabled: false});
	const live = {enabled: true, version: 'a'.repeat(40), productVersion: 'v0.1.0-beta.8', assets: {x: {url: 'artifact'}}};
	preventUpdateReset(live, structuredClone(live));
	assert.throws(() => preventUpdateReset(live, {enabled: false}));
	assert.throws(() => preventUpdateReset(live, {...live, version: 'b'.repeat(40)}));
	assert.throws(() => preventUpdateReset(live, {...live, assets: {}}));
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
