import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';

const root = new URL('.', import.meta.url);
const requiredFiles = [
	'.assetsignore',
	'.gitignore',
	'_headers',
	'app.js',
	'favicon.svg',
	'index.html',
	'robots.txt',
	'site.webmanifest',
	'styles.css',
	'wrangler.jsonc'
];

const failures = [];
const assert = (condition, message) => {
	if (!condition) {
		failures.push(message);
	}
};

const files = await readdir(root);
for (const file of requiredFiles) {
	assert(files.includes(file), `Missing required file: ${file}`);
}

const html = await readFile(new URL('index.html', root), 'utf8');
const css = await readFile(new URL('styles.css', root), 'utf8');
const js = await readFile(new URL('app.js', root), 'utf8');
const assetsIgnore = await readFile(new URL('.assetsignore', root), 'utf8');
const headers = await readFile(new URL('_headers', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('site.webmanifest', root), 'utf8'));
const wranglerText = await readFile(new URL('wrangler.jsonc', root), 'utf8');

const sourceFiles = files.filter(file => ['.html', '.css', '.js', '.mjs', '.json', '.jsonc', '.txt'].includes(extname(file)));
for (const file of sourceFiles) {
	const source = await readFile(new URL(file, root), 'utf8');
	assert(!source.includes('\u2014'), `${file} contains an em dash`);
	assert(!source.match(/sk-[a-z0-9_-]{12,}/i), `${file} appears to contain an API key`);
	assert(!source.match(/nvapi-[a-z0-9_\\-]{12,}/i), `${file} appears to contain an NVIDIA API key`);
}

assert(html.includes('Content-Security-Policy'), 'Missing Content Security Policy');
assert(!html.match(/<script(?![^>]*\bsrc=)[^>]*>/i), 'Inline script found');
assert(!html.match(/<style\b/i), 'Inline style found');
assert(!html.match(/\sstyle\s*=/i), 'Inline style attribute found');
assert(!html.match(/\bsrc=["']https?:\/\//i), 'Remote asset found');
assert(html.includes('href="#main"'), 'Missing skip link');
assert(html.includes('id="main"'), 'Missing main target');
assert(html.includes('<h1>Keep the work between coding-agent sessions.</h1>'), 'Hero text changed unexpectedly');
assert(html.includes('Public alpha / desktop and CLI'), 'Public alpha status is missing');
assert((html.match(/Interface preview/g) || []).length >= 6, 'Interface previews are not clearly labeled');
assert(html.includes('published six-fixture portable estimate'), 'Benchmark scope qualifier is missing');
assert(html.includes('not provider-billed usage, total cost, model quality, or a universal result'), 'Benchmark disclaimer is missing');
assert(html.includes('https://qarinah.io/docs/benchmarks/'), 'Benchmark methodology link is missing');
assert(html.includes('Browser and crawler access is not bundled or enabled in this alpha.'), 'Connector availability boundary is missing');
assert(!html.includes('npm run setup'), 'Unsupported setup command found');
assert(!html.includes('fikeya run '), 'Unsupported run command found');
assert(!html.includes('fikeya receipt '), 'Unsupported receipt command found');
assert(!html.includes('fikeya memory doctor'), 'Unsupported memory command found');
assert(!html.match(/tabindex=["'][1-9]/i), 'Positive tabindex found');
assert(!html.match(/<img\b(?![^>]*\balt=)/i), 'Image without alt text found');
assert(html.includes('rel="manifest" href="site.webmanifest"'), 'Web manifest link is missing');
assert(html.includes('name="robots" content="index, follow, max-image-preview:large"'), 'Robots metadata is missing');
assert(css.includes('@media (prefers-reduced-motion: reduce)'), 'Reduced motion fallback is missing');
assert(css.includes('@media (max-width: 600px)'), 'Small-screen layout is missing');
assert(!css.includes('gradient('), 'Gradient found in no-gradient visual system');
assert(js.includes("event.key === 'ArrowRight'"), 'Tab keyboard navigation is missing');
assert(headers.includes("frame-ancestors 'none'"), 'Header CSP is missing clickjacking protection');
assert(headers.includes('X-Content-Type-Options: nosniff'), 'nosniff header is missing');
assert(headers.includes('Permissions-Policy:'), 'Permissions Policy header is missing');
assert(manifest.name === 'Fikeya', 'Web manifest name is incorrect');
assert(assetsIgnore.includes('.wrangler'), 'Wrangler local state is not excluded from static assets');
assert(assetsIgnore.includes('node_modules'), 'Dependencies are not excluded from static assets');
assert(wranglerText.includes('"compatibility_date": "2026-08-24"'), 'Cloudflare compatibility date is incorrect');
assert(!wranglerText.match(/account_id|zone_id|api_token|route/i), 'Wrangler config must not contain account, zone, token, or route values');

const hrefs = Array.from(html.matchAll(/href=["']([^"']+)["']/g), match => match[1]);
const ids = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), match => match[1]));
const allowedExternalLinks = new Set([
	'https://github.com/AjnasNB/fikeya',
	'https://qarinah.io/docs/benchmarks/'
]);
for (const href of hrefs) {
	if (href.startsWith('#') && href.length > 1) {
		assert(ids.has(href.slice(1)), `Broken fragment link: ${href}`);
	}
	if (/^https?:\/\//i.test(href)) {
		assert(allowedExternalLinks.has(href), `Unexpected external link: ${href}`);
	}
}

if (failures.length > 0) {
	console.error(`Site validation failed with ${failures.length} issue(s):`);
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exitCode = 1;
} else {
	console.log(`Site validation passed (${sourceFiles.length} source files checked).`);
}
