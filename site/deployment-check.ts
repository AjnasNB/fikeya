// Fikeya product delivery and measurement tooling.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export function preventUpdateReset(live, candidate) {
	if (live?.enabled !== true) return;
	assert(candidate?.enabled === true, 'Refusing to replace a released update feed with a disabled source-candidate feed. Prepare the site with the verified release artifacts first.');
	assert(live.version === candidate.version && live.productVersion === candidate.productVersion,
		'A website-only deployment must preserve the active release. Use the signed release workflow to promote a different release.');
	assert(JSON.stringify(live.assets) === JSON.stringify(candidate.assets), 'Website-only deployment changes active download artifacts.');
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/deployment-check.ts')) {
	const response = await fetch('https://fikeya.com/updates/latest.json', { signal: AbortSignal.timeout(15000) });
	assert(response.ok, 'Cannot verify the existing production update feed; deployment stopped.');
	const live = await response.json();
	const candidate = JSON.parse(await readFile(new URL('./dist/updates/latest.json', import.meta.url), 'utf8'));
	preventUpdateReset(live, candidate);
	console.log('Website deployment preserves the production release feed.');
}
