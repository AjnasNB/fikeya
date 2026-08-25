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
	'sitemap.xml',
	'site.webmanifest',
	'styles.css',
	'worker.ts',
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
const robots = await readFile(new URL('robots.txt', root), 'utf8');
const sitemap = await readFile(new URL('sitemap.xml', root), 'utf8');
const wranglerText = await readFile(new URL('wrangler.jsonc', root), 'utf8');
const workerWranglerText = await readFile(new URL('wrangler.worker.jsonc', root), 'utf8');
const worker = (await import(new URL('worker.ts', root))).default;

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
assert(html.includes('<h1>Build with your model.<span>Spend fewer tokens.</span></h1>'), 'Token-focused hero text is missing');
assert(!html.match(/\bany model\b/i), 'Unsupported any-model claim found');
assert(html.includes('selects task-relevant project evidence instead of replaying the whole repository'), 'Task-relevant context positioning is missing');
assert(html.includes('inspect measured token and verification receipts'), 'Measured receipt wording is missing');
assert(html.includes('signed Desktop installers and a verified native update feed remain stable-release gates.'), 'Packaging and update release gates are missing');
assert(!html.includes('reproducible VSIX packaging'), 'Unproven cross-platform reproducibility claim is present');
assert(html.includes('Fikeya 0.1.0-beta.1 · Desktop, VS Code extension, and CLI'), 'Public beta status is missing');
assert(!html.includes('stable release available'), 'The site must not claim a stable release before the release gates pass');
assert(html.includes('src="/fikeya-desktop-beta-graph.jpg"'), 'Real memory capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-editor.jpg"'), 'Real editor capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-agent.jpg"'), 'Real agent capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-terminal.jpg"'), 'Real terminal capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-review.jpg"'), 'Real review capture is missing');
assert(html.includes('fikeya provider list --json'), 'Provider discovery command is missing');
assert(!html.includes('Keep the work between coding-agent sessions'), 'Stale session-handoff positioning found');
assert(!html.includes('Keep the work. Change the session.'), 'Stale session-handoff closing copy found');
assert(html.includes('published Qarinah six-fixture portable context estimate'), 'Benchmark scope qualifier is missing');
assert(html.includes('not provider-billed usage, total cost, model quality, or a universal result'), 'Benchmark disclaimer is missing');
assert(html.includes('https://qarinah.io/docs/benchmarks/'), 'Benchmark methodology link is missing');
assert(html.includes('Tool executables are installed separately and remain disabled by default.'), 'Connector availability boundary is missing');
assert(html.includes('OpenAI / Codex models'), 'OpenAI and Codex-capable model path is missing');
assert(html.includes('Google Gemini'), 'Gemini provider path is missing');
assert(html.includes('Vertex AI'), 'Vertex provider path is missing');
assert(html.includes('Hugging Face'), 'Hugging Face provider path is missing');
assert(html.includes('Groq'), 'Groq provider path is missing');
assert(html.includes('Lab Mode'), 'Lab mode is missing');
assert(html.includes('href="#top">Home</a>'), 'Home navigation is missing');
assert(!html.includes('install surfaces'), 'Generic install-surface count is still present');
assert(!html.includes('provider paths</span>'), 'Generic provider-path count is still present');
assert(html.includes('The companion editor extension stays intentionally smaller'), 'Extension and Desktop boundary is missing');
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
assert(css.includes('font-family: "IBM Plex Sans"'), 'Self-hosted IBM Plex Sans is missing');
assert(css.includes('font-family: "IBM Plex Mono"'), 'Self-hosted IBM Plex Mono is missing');
assert(!css.includes('gradient('), 'Gradient found in no-gradient visual system');
assert(js.includes("event.key === 'ArrowRight'"), 'Tab keyboard navigation is missing');
assert(headers.includes("frame-ancestors 'none'"), 'Header CSP is missing clickjacking protection');
assert(headers.includes('X-Content-Type-Options: nosniff'), 'nosniff header is missing');
assert(headers.includes('Permissions-Policy:'), 'Permissions Policy header is missing');
assert(manifest.name === 'Fikeya', 'Web manifest name is incorrect');
assert(robots.includes('Sitemap: https://fikeya.com/sitemap.xml'), 'Robots sitemap declaration is missing');
assert(sitemap.includes('<loc>https://fikeya.com/</loc>'), 'Canonical sitemap location is missing');
assert(assetsIgnore.includes('.wrangler'), 'Wrangler local state is not excluded from static assets');
assert(assetsIgnore.includes('node_modules'), 'Dependencies are not excluded from static assets');
assert(wranglerText.includes('"compatibility_date": "2026-08-24"'), 'Cloudflare compatibility date is incorrect');
assert(!wranglerText.match(/account_id|zone_id|api_token|route/i), 'Wrangler config must not contain account, zone, token, or route values');
assert(workerWranglerText.includes('"main": "./worker.ts"'), 'Worker entry point is missing');
assert(workerWranglerText.includes('"binding": "ASSETS"'), 'Static asset binding is missing');
assert(workerWranglerText.includes('"run_worker_first": true'), 'Worker must run before static assets so hostname redirects execute');
assert(!workerWranglerText.match(/account_id|zone_id|api_token/i), 'Worker config must not contain account, zone, or token values');

const redirectResponse = await worker.fetch(new Request('https://www.fikeya.com/docs/?q=1'), {
	ASSETS: { fetch: async () => new Response('asset') }
});
assert(redirectResponse.status === 301, 'www canonical redirect status is incorrect');
assert(redirectResponse.headers.get('location') === 'https://fikeya.com/docs/?q=1', 'www canonical redirect target is incorrect');
const insecureRedirectResponse = await worker.fetch(new Request('http://www.fikeya.com/docs/?q=1'), {
	ASSETS: { fetch: async () => new Response('asset') }
});
assert(insecureRedirectResponse.status === 301, 'HTTP www canonical redirect status is incorrect');
assert(insecureRedirectResponse.headers.get('location') === 'https://fikeya.com/docs/?q=1', 'HTTP www canonical redirect must enforce HTTPS');
const assetResponse = await worker.fetch(new Request('https://fikeya.com/'), {
	ASSETS: { fetch: async () => new Response('asset') }
});
assert(assetResponse.status === 200 && await assetResponse.text() === 'asset', 'Apex requests must reach the static asset binding');

const hrefs = Array.from(html.matchAll(/href=["']([^"']+)["']/g), match => match[1]);
const ids = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), match => match[1]));
const allowedExternalLinks = new Set([
	'https://fikeya.com/',
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
