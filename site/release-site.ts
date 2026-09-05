// Fikeya product delivery and measurement tooling.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const releaseRoot = 'https://github.com/AjnasNB/fikeya/releases';
export function releaseSiteMetadata(manifest, { commit, version, extensionVersion, signer }) {
	assert(manifest?.schemaVersion === 1 && manifest.product === 'Fikeya', 'Invalid release manifest.');
	assert(/^[a-f0-9]{40}$/u.test(commit) && manifest.commit === commit, 'Release commit mismatch.');
	assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version) && manifest.version === version, 'Release version mismatch.');
	assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(extensionVersion), 'Invalid extension version.');
	assert(typeof signer === 'string' && signer.trim(), 'Expected signer is required.');
	const names = {
		desktop: `FikeyaSetup-${version}-win32-x64.exe`,
		extension: `fikeya-desktop-${extensionVersion}-win32-x64.vsix`,
		cli: `fikeya-cli-${version}.zip`
	};
	const assets = {};
	for (const [kind, name] of Object.entries(names)) {
		const candidates = manifest.artifacts.filter(item => item.name === name);
		assert(candidates.length === 1, `Missing or duplicate ${kind} artifact.`);
		const item = candidates[0];
		assert(Number.isSafeInteger(item.bytes) && item.bytes > 0 && /^[a-f0-9]{64}$/u.test(item.sha256), 'Invalid artifact measurement.');
		if (kind === 'desktop') {
			assert(item.authenticodeStatus === 'Valid' && item.signer === signer, 'Trusted installer signer mismatch.');
			assert(typeof item.timestampSigner === 'string' && item.timestampSigner.trim(), 'Trusted timestamp is required.');
		}
		assets[kind] = { name, bytes: item.bytes, sha256: item.sha256, url: `${releaseRoot}/download/v${version}/${name}` };
	}
	return { version, commit, signer, releaseUrl: `${releaseRoot}/tag/v${version}`, assets };
}

export function renderReleasedPage(html, release) {
	const oldRoot = `${releaseRoot}/download/v0.1.0-beta.1/`;
	return html
		.replaceAll(oldRoot + 'FikeyaSetup-0.1.0-beta.1-win32-x64.exe', release.assets.desktop.url)
		.replaceAll(oldRoot + 'fikeya-desktop-0.1.0-win32-x64.vsix', release.assets.extension.url)
		.replaceAll(oldRoot + 'fikeya-cli-0.1.0-beta.1.zip', release.assets.cli.url)
		.replaceAll(`${releaseRoot}/tag/v0.1.0-beta.1`, release.releaseUrl)
		.replaceAll(/Fikeya 0\.1\.0-beta\.8 source candidate/gu, `Fikeya ${release.version} public beta`)
		.replaceAll('Beta.8 remains an unpublished source candidate until trusted signing and every stable-release gate pass; beta.1 remains the latest published binary.', `The current published beta is ${release.version}. Downloads and the update feed reference the same verified release commit.`)
		.replaceAll('The current Windows installer is not Authenticode-signed, so Windows can show an unknown-publisher warning.', 'The current Windows installer has a verified, timestamped Authenticode signature. Windows reputation prompts may still appear.')
		.replaceAll('Checksums and provenance are available. Trusted signing is not yet complete.', 'Checksums, provenance, and a signed Windows installer.')
		.replaceAll('Unsigned beta; SignPath application pending', 'Timestamped Authenticode signature verified')
		.replaceAll('Review the unknown-publisher warning honestly. Cancel if the file hash does not match.', 'Check the verified publisher and file hash. Cancel if either differs from the release manifest.')
		.replaceAll('Windows will continue to show an unknown-publisher warning until the installer is Authenticode-signed with a trusted certificate.', 'The published installer has a verified Authenticode signature; Windows reputation prompts may still appear.');
}

async function hashFile(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}

export async function prepareReleaseSite(artifactDirectory, expected) {
	const site = path.dirname(fileURLToPath(import.meta.url));
	const dist = path.join(site, 'dist');
	const manifest = JSON.parse((await readFile(path.join(artifactDirectory, 'release-verification.json'), 'utf8')).replace(/^\uFEFF/u, ''));
	const release = releaseSiteMetadata(manifest, expected);
	// Hash the actual artifacts, not merely manifest claims. The protected release
	// job separately verifies Authenticode with Windows before invoking this step.
	for (const asset of Object.values(release.assets)) {
		const file = path.join(artifactDirectory, asset.name);
		const stat = await lstat(file);
		assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.bytes, 'Artifact size/type mismatch.');
		assert(await hashFile(file) === asset.sha256, 'Artifact checksum mismatch.');
	}
	const walk = async directory => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(target);
			else if (entry.isFile() && entry.name.endsWith('.html')) {
				await writeFile(target, renderReleasedPage(await readFile(target, 'utf8'), release));
			}
		}
	};
	await walk(dist);
	await writeFile(path.join(dist, 'updates', 'latest.json'), JSON.stringify({
		enabled: true, version: release.commit, productVersion: `v${release.version}`,
		quality: 'stable', authenticodeSubject: release.signer, timestamped: true,
		assets: { 'win32-x64-user': { url: release.assets.desktop.url, sha256: release.assets.desktop.sha256 } }
	}, null, 2));
	await writeFile(path.join(dist, 'release.json'), JSON.stringify(release, null, 2));
	return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const site = path.dirname(fileURLToPath(import.meta.url));
	const distribution = JSON.parse(await readFile(path.join(site, '..', 'fikeya-distribution.json'), 'utf8'));
	const extension = JSON.parse(await readFile(path.join(site, '..', 'extensions', 'fikeya-desktop', 'package.json'), 'utf8'));
	const release = await prepareReleaseSite(path.resolve(process.argv[2]), {
		commit: process.env.GITHUB_SHA, version: distribution.version,
		extensionVersion: extension.version, signer: process.env.FIKEYA_EXPECTED_SIGNER_SUBJECT
	});
	console.log(`Prepared website, download links, and update feed for ${release.version} at ${release.commit}.`);
}
