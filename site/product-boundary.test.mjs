import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = new URL('./', import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.jsonc', '.md', '.mjs', '.svg', '.ts', '.txt']);
const excludedDirectories = new Set(['dist', 'node_modules']);

async function collectTextFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!excludedDirectories.has(entry.name)) {
				files.push(...await collectTextFiles(new URL(`${entry.name}/`, directory)));
			}
			continue;
		}
		if (textExtensions.has(extname(entry.name))) {
			files.push(new URL(entry.name, directory));
		}
	}
	return files;
}

const publicFiles = [
	new URL('README.md', new URL('../', import.meta.url)),
	...await collectTextFiles(new URL('../docs/fikeya/', import.meta.url)),
	...await collectTextFiles(new URL('./', import.meta.url))
];

const forbiddenPublicDetails = [
	{
		pattern: /\bmaqam\b(?!\.)/i,
		reason: 'contains legacy customer-facing product naming outside an exact maqam.* compatibility identifier'
	},
	{
		pattern: /[a-z]:\\(?:users|skill box)\\/i,
		reason: 'contains a local Windows workspace path'
	},
	{
		pattern: /\/(?:users|home)\/[^\s"')]+/i,
		reason: 'contains a local Unix workspace path'
	},
	{
		pattern: /(?:file|vscode):\/\//i,
		reason: 'contains a local file URI'
	}
];

for (const file of publicFiles) {
	const source = await readFile(file, 'utf8');
	const displayPath = relative(repositoryRoot, fileURLToPath(file)).replaceAll('\\', '/');
	for (const check of forbiddenPublicDetails) {
		assert.doesNotMatch(source, check.pattern, `${displayPath} ${check.reason}`);
	}
}

const enterprisePage = await readFile(new URL('enterprise/index.html', siteRoot), 'utf8');
assert.match(enterprisePage, /Fikeya Endpoint \+ Fikeya Enterprise/, 'Enterprise page must name both Fikeya deployment parts');
assert.match(enterprisePage, /One Fikeya product for model access and agent execution\./, 'Enterprise page must present one customer-facing Fikeya product');
assert.match(enterprisePage, /<strong>Fikeya Endpoint<\/strong>/, 'Enterprise architecture must name the local Fikeya Endpoint');
assert.match(enterprisePage, /<strong>Fikeya Enterprise<\/strong>/, 'Enterprise architecture must name the central Fikeya Enterprise control plane');

const planToProof = await readFile(new URL('../docs/fikeya/PLAN_TO_PROOF.md', import.meta.url), 'utf8');
assert.match(planToProof, /Fikeya is one customer-facing product with two deployment parts:/, 'Product boundary documentation must define one Fikeya product');
assert.match(planToProof, /Fikeya Endpoint runs and enforces agent work close to the repository/, 'Product boundary documentation must define the endpoint responsibility');
assert.match(planToProof, /Fikeya Enterprise supplies the optional private model gateway and central safety\/policy layer/, 'Product boundary documentation must define the enterprise responsibility');

console.log(`Fikeya product-boundary validation passed (${publicFiles.length} public text files checked).`);
