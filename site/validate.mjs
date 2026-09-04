import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';

import { isSafePaperLink, renderBrowserIntegrationGuide, renderBrowserPaper } from './paper.mjs';
import { hasExactSecureHref } from './url-validation.ts';

const root = new URL('.', import.meta.url);
const requiredFiles = [
	'.assetsignore',
	'.gitignore',
	'_headers',
	'app.js',
	'favicon.svg',
	'fikeya-live-chat.png',
	'fikeya-live-context-graph.png',
	'fikeya-plan-awaiting-approval-real.png',
	'fikeya-plan-draft-real.png',
	'fikeya-plan-exact-approval-real.png',
	'fikeya-plan-executed-verified-real.png',
	'fikeya-plan-lifecycle-proof.json',
	'fikeya-plan-reviewed-real.png',
	'fikeya-plan-succeeded-real.png',
	'docs',
	'download',
	'enterprise',
	'index.html',
	'opensource',
	'paper.mjs',
	'product',
	'proof',
	'privacy',
	'robots.txt',
	'sitemap.xml',
	'site.webmanifest',
	'signing',
	'styles.css',
	'updates',
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
const pagePaths = [
	'docs/index.html',
	'download/index.html',
	'enterprise/index.html',
	'opensource/index.html',
	'product/index.html',
	'proof/index.html',
	'privacy/index.html',
	'signing/index.html'
];
const pageDocuments = new Map(await Promise.all(pagePaths.map(async pagePath => [
	pagePath,
	await readFile(new URL(pagePath, root), 'utf8')
])));
const css = await readFile(new URL('styles.css', root), 'utf8');
const js = await readFile(new URL('app.js', root), 'utf8');
const assetsIgnore = await readFile(new URL('.assetsignore', root), 'utf8');
const headers = await readFile(new URL('_headers', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('site.webmanifest', root), 'utf8'));
const robots = await readFile(new URL('robots.txt', root), 'utf8');
const sitemap = await readFile(new URL('sitemap.xml', root), 'utf8');
const updateManifest = JSON.parse(await readFile(new URL('updates/latest.json', root), 'utf8'));
const wranglerText = await readFile(new URL('wrangler.jsonc', root), 'utf8');
const workerWranglerText = await readFile(new URL('wrangler.worker.jsonc', root), 'utf8');
const worker = (await import(new URL('worker.ts', root))).default;
const browserPaperMarkdown = await readFile(new URL('../docs/FIKEYA_COCKROACH_BROWSER_PAPER.md', root), 'utf8');
const browserIntegrationGuideMarkdown = await readFile(new URL('../docs/fikeya/COCKROACH_BROWSER_OPEN_SOURCE_INTEGRATIONS.md', root), 'utf8');
let browserPaperHtml = '';
let browserIntegrationGuideHtml = '';
try {
	browserPaperHtml = renderBrowserPaper(browserPaperMarkdown);
	browserIntegrationGuideHtml = renderBrowserIntegrationGuide(browserIntegrationGuideMarkdown);
} catch (error) {
	assert(false, `Browser documentation rendering failed: ${error instanceof Error ? error.message : String(error)}`);
}

const sourceFiles = files.filter(file => ['.html', '.css', '.js', '.mjs', '.json', '.jsonc', '.txt'].includes(extname(file)));
const sourceEntries = [...sourceFiles, ...pagePaths];
for (const sourceEntry of sourceEntries) {
	const source = await readFile(new URL(sourceEntry, root), 'utf8');
	assert(!source.includes('\u2014'), `${sourceEntry} contains an em dash`);
	assert(!source.match(/sk-[a-z0-9_-]{12,}/i), `${sourceEntry} appears to contain an API key`);
	assert(!source.match(/nvapi-[a-z0-9_\\-]{12,}/i), `${sourceEntry} appears to contain an NVIDIA API key`);
}

for (const [pagePath, page] of pageDocuments) {
	assert(page.includes('Content-Security-Policy'), `${pagePath} is missing its Content Security Policy`);
	assert(page.includes('href="#main"'), `${pagePath} is missing its skip link`);
	assert(page.includes('id="main"'), `${pagePath} is missing its main target`);
	assert(!page.match(/<script(?![^>]*\bsrc=)[^>]*>/i), `${pagePath} contains an inline script`);
	assert(!page.match(/<style\b/i), `${pagePath} contains an inline style element`);
	assert(!page.match(/\sstyle\s*=/i), `${pagePath} contains an inline style attribute`);
	assert(!page.match(/\bsrc=["']https?:\/\//i), `${pagePath} contains a remote asset`);
	assert(!page.match(/<img\b(?![^>]*\balt=)/i), `${pagePath} contains an image without alt text`);
	assert(!page.match(/tabindex=["'][1-9]/i), `${pagePath} contains a positive tabindex`);
	assert(page.includes('href="/opensource/"'), `${pagePath} is missing Open Source navigation`);
}

assert(html.includes('Content-Security-Policy'), 'Missing Content Security Policy');
assert(!html.match(/<script(?![^>]*\bsrc=)[^>]*>/i), 'Inline script found');
assert(!html.match(/<style\b/i), 'Inline style found');
assert(!html.match(/\sstyle\s*=/i), 'Inline style attribute found');
assert(!html.match(/\bsrc=["']https?:\/\//i), 'Remote asset found');
assert(html.includes('href="#main"'), 'Missing skip link');
assert(html.includes('id="main"'), 'Missing main target');
assert(html.includes('<h1>Build with your model.<span>Spend fewer tokens.</span></h1>'), 'Spend-fewer-tokens hero text is missing');
assert(html.includes('<meta property="og:image" content="https://fikeya.com/fikeya-live-chat.png">'), 'Real Chat capture is not the homepage social image');
assert(html.includes('No Fikeya editor subscription.'), 'Editor subscription boundary is missing');
assert(html.toLowerCase().includes('provider usage remains between you and the provider you choose'), 'Provider-cost boundary is missing from the free editor banner');
assert(!html.match(/\bany model\b/i), 'Unsupported any-model claim found');
assert(html.includes('selects task-relevant project evidence instead of replaying the whole repository'), 'Task-relevant context positioning is missing');
assert(html.includes('inspect measured token and verification receipts'), 'Measured receipt wording is missing');
assert(html.includes('The product target is lower billed input tokens on matched coding tasks, not an unqualified savings claim.'), 'Matched-task token target boundary is missing');
assert(html.includes('Windows will continue to show an unknown-publisher warning until the installer is Authenticode-signed with a trusted certificate.'), 'Authenticode release gate is missing');
assert(!html.includes('reproducible VSIX packaging'), 'Unproven cross-platform reproducibility claim is present');
assert(html.includes('Fikeya 0.1.0-beta.8 source candidate · Desktop, VS Code extension, and CLI'), 'Current source candidate status is missing');
const downloadPage = pageDocuments.get('download/index.html') ?? '';
assert(downloadPage.includes('Beta.8 remains an unpublished source candidate'), 'Download page lost the current unpublished source-candidate boundary');
assert(downloadPage.includes('beta.1 remains the latest published binary'), 'Download page lost the latest published binary boundary');
assert(!downloadPage.includes('Beta.7 remains'), 'Download page contains stale beta.7 release copy');
assert(html.includes('Plan, challenge, build, challenge again, then prove the result.'), 'Durable Project mode is missing');
assert(!html.includes('stable release available'), 'The site must not claim a stable release before the release gates pass');
assert(html.includes('src="/qarinah-standalone-graph.png"'), 'Standalone Qarinah graph capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-editor.jpg"'), 'Real editor capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-agent.jpg"'), 'Real agent capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-terminal.jpg"'), 'Real terminal capture is missing');
assert(html.includes('src="/fikeya-desktop-beta-review.jpg"'), 'Real review capture is missing');
assert(html.includes('src="/fikeya-live-chat.png"'), 'Real right-side chat capture is missing');
assert(html.includes('src="/fikeya-live-context-graph.png"'), 'Real Context graph capture is missing');
assert(html.includes('Real Chat, a real graph, and measured local usage.'), 'Evidence-honest live proof heading is missing');
assert(html.includes('explicit unavailable-context state'), 'Homepage Chat proof must disclose unavailable project context');
assert(html.includes('A separate initialized workspace capture shows Qarinah reporting six cited items'), 'Homepage must separate Chat and Qarinah graph proof scopes');
assert(html.includes('76 bounded nodes and 201 visible links'), 'Measured live graph scope is missing');
assert(html.includes('fikeya-cli-proof-20260825165749.ajnasnb.workers.dev/health'), 'Live CLI to Wrangler proof is missing');
assert(html.includes('2026-08-25-cli-wrangler.md'), 'CLI to Wrangler verification receipt is missing');
const proofPage = pageDocuments.get('proof/index.html') ?? '';
assert(proofPage.includes('The capture explicitly shows that no project context was attached'), 'Proof page must not attribute Qarinah retrieval to the Chat capture');
assert(proofPage.includes('A separate initialized workspace reported six cited items'), 'Proof page must scope cited items to the graph capture');
assert(proofPage.includes('Plan-to-proof fixture'), 'Plan-to-proof evaluation is missing from the proof page');
assert(proofPage.includes('3,606 of 8,000 characters used'), 'Measured Qarinah budget result is missing from the proof page');
assert(proofPage.includes('tokens remain explicitly not measured'), 'No-model token boundary is missing from the proof page');
assert(proofPage.includes('src="/fikeya-plan-draft-real.png"'), 'Real draft capture is missing from the proof page');
assert(proofPage.includes('src="/fikeya-plan-reviewed-real.png"'), 'Real reviewed-plan capture is missing from the proof page');
assert(proofPage.includes('src="/fikeya-plan-awaiting-approval-real.png"'), 'Real approval-boundary capture is missing from the proof page');
assert(proofPage.includes('src="/fikeya-plan-exact-approval-real.png"'), 'Real exact-approval receipt capture is missing from the proof page');
assert(proofPage.includes('src="/fikeya-plan-executed-verified-real.png"'), 'Real execution-and-verification capture is missing from the proof page');
assert(proofPage.includes('src="/fikeya-plan-succeeded-real.png"'), 'Real succeeded-plan capture is missing from the proof page');
assert(proofPage.includes('href="/fikeya-plan-lifecycle-proof.json"'), 'Content-free Desktop plan receipt download is missing');
assert(proofPage.includes('three read-only workspace tools'), 'Safe Desktop proof tool boundary is missing');
const productPage = pageDocuments.get('product/index.html') ?? '';
for (const stage of ['01</span><strong>Draft', '02</span><strong>Review', '03</span><strong>Approval', '04</span><strong>Execute', '05</span><strong>Verify']) {
	assert(productPage.includes(stage), `Product page is missing workflow stage: ${stage}`);
}
assert(productPage.includes('three read-only workspace tools reached Succeeded'), 'Product page is missing the verified safe-capture boundary');
const openSourcePage = pageDocuments.get('opensource/index.html') ?? '';
assert(openSourcePage.includes('<meta name="robots" content="noindex, follow">'), 'Open Source homepage alias must not compete in search indexes');
assert(openSourcePage.includes('<meta property="og:url" content="https://fikeya.com/">'), 'Open Source social URL must identify the canonical homepage');
assert(openSourcePage.includes('<link rel="canonical" href="https://fikeya.com/">'), 'Open Source alias must canonicalize to the homepage');
assert(openSourcePage.includes('href="/favicon.svg?v=20260825h"'), 'Open Source favicon must use a root-absolute URL');
assert(openSourcePage.includes('href="/site.webmanifest"'), 'Open Source manifest must use a root-absolute URL');
assert(openSourcePage.includes('href="/styles.css?v=20260903c"'), 'Open Source stylesheet must use a root-absolute URL');
assert(openSourcePage.includes('src="/app.js?v=20260825k"'), 'Open Source script must use a root-absolute URL');
assert(openSourcePage.includes('href="/opensource/" aria-current="page"'), 'Open Source navigation state is missing');
assert(openSourcePage.includes('<h1>Build with your model.<span>Spend fewer tokens.</span></h1>'), 'Open Source route must preserve the current homepage');
assert(openSourcePage.includes('28.25</strong><span>MiB max RSS</span>'), 'Open Source route is missing the measured Cockroach Browser result');
assert(openSourcePage.includes('href="/papers/fikeya-cockroach-browser/"'), 'Open Source route is missing the readable Fikeya + Cockroach paper');
assert(!openSourcePage.includes('28.30 MiB') && !openSourcePage.includes('25 MiB target'), 'Open Source route must stay focused on the verified passing integration result');
assert(html.includes('fikeya provider list --json'), 'Provider discovery command is missing');
assert(!html.includes('Keep the work between coding-agent sessions'), 'Stale session-handoff positioning found');
assert(!html.includes('Keep the work. Change the session.'), 'Stale session-handoff closing copy found');
assert(html.includes('published Qarinah six-fixture portable context estimate'), 'Benchmark scope qualifier is missing');
assert(html.includes('not provider-billed usage, total cost, model quality, or a universal result'), 'Benchmark disclaimer is missing');
assert(hasExactSecureHref(html, 'https://qarinah.io/docs/benchmarks/'), 'Benchmark methodology link is missing');
assert(html.includes('Tool executables are installed separately and remain disabled by default.'), 'Connector availability boundary is missing');
assert(pageDocuments.get('docs/index.html')?.includes('When Qarinah context is enabled and available'), 'Documentation must scope Qarinah recompilation to enabled, available context');
assert(pageDocuments.get('docs/index.html')?.includes('href="/docs/cockroach-browser/"'), 'Documentation index is missing the Cockroach Browser integration guide');
assert(pageDocuments.get('docs/index.html')?.includes('Direct Cockroach action dispatch and browser-session creation remain gated integration work.'), 'Documentation index lost the current Cockroach dispatch boundary');
assert(openSourcePage.includes('href="/docs/cockroach-browser/"'), 'Open Source route is missing the Cockroach Browser integration guide');
assert(html.includes('id="browser-engines"'), 'Homepage is missing the multi-engine browser control');
assert(openSourcePage.includes('id="browser-engines"'), 'Open Source route is missing the multi-engine browser control');
for (const engine of ['chromium', 'firefox', 'webkit', 'obscura', 'lightpanda']) {
	assert(html.includes(`data-engine-choice value="${engine}"`), `Homepage is missing the ${engine} selection lane`);
	assert(openSourcePage.includes(`data-engine-detail="${engine}"`), `Open Source route is missing the ${engine} capability card`);
}
assert(html.includes('data-engine-selection-summary'), 'Homepage engine selection summary is missing');
assert(js.includes("[data-engine-picker]"), 'Engine selection behavior is missing');
assert(css.includes('.engine-control'), 'Multi-engine browser control styles are missing');
assert(html.includes('28.25</strong><span>MiB max RSS</span>'), 'Measured Cockroach Browser maximum is missing');
assert(html.includes('<dt>Verdict</dt><dd>30 MiB PASS</dd>'), 'Measured Cockroach Browser PASS verdict is missing');
assert(html.includes('<dt>Exact maximum</dt><dd>29,622,272 bytes</dd>'), 'Exact Cockroach Browser maximum is missing');
assert(html.includes('href="/papers/fikeya-cockroach-browser/"'), 'Readable Fikeya + Cockroach paper link is missing');
assert(html.includes('30 MiB verification run; 20 measured launches after one warmup, pinned Obscura 0.2.1 constrained non-visual fixture'), 'Cockroach Browser benchmark scope is missing');
assert(html.includes('This is the maximum complete owned browser process-tree RSS in the 30 MiB verification run for that fixture.'), 'Cockroach Browser process-tree scope is missing');
assert(html.includes('It is not Fikeya Desktop, whole-app, rendered-page, arbitrary-site, or full-engine memory.'), 'Cockroach Browser memory boundary is missing');
assert(hasExactSecureHref(html, 'https://github.com/AjnasNB/cockroach-browser/blob/v0.5.0-rc.1/docs/benchmarks/obscura-non-visual-2026-09-03.md'), 'Cockroach Browser benchmark link is missing');
assert(hasExactSecureHref(html, 'https://github.com/AjnasNB/cockroach-browser/releases/tag/v0.5.0-rc.1'), 'Cockroach Browser release link is missing');
assert(!html.includes('28.30 MiB'), 'The homepage must not mix the passing integration highlight with a separate target result');
assert(!html.includes('25 MiB target'), 'The homepage must stay focused on the verified passing integration result');
assert(html.includes('OpenAI / Codex models'), 'OpenAI and Codex-capable model path is missing');
assert(html.includes('Google Gemini'), 'Gemini provider path is missing');
assert(html.includes('Vertex AI'), 'Vertex provider path is missing');
assert(html.includes('Hugging Face'), 'Hugging Face provider path is missing');
assert(html.includes('Groq'), 'Groq provider path is missing');
assert(html.includes('Lab Mode'), 'Lab mode is missing');
assert(html.includes('href="/">Home</a>'), 'Home navigation is missing');
assert(html.includes('href="/opensource/">Open Source</a>'), 'Open Source navigation is missing');
assert(html.includes('href="/download/">Download the public beta</a>'), 'Primary download action is missing');
assert(!html.includes('install surfaces'), 'Generic install-surface count is still present');
assert(!html.includes('provider paths</span>'), 'Generic provider-path count is still present');
assert(html.includes('The companion editor extension stays intentionally smaller'), 'Extension and Desktop boundary is missing');
assert(hasExactSecureHref(html, 'https://github.com/sponsors/AjnasNB'), 'GitHub Sponsors link is missing');
assert(html.includes('id="contributors"'), 'Contributor attribution section is missing');
assert(html.includes('Fikeya-owned product code is AGPL-3.0-or-later'), 'Mixed-license attribution is missing');
assert(html.includes('FikeyaSetup-0.1.0-beta.1-win32-x64.exe'), 'Windows beta download is missing');
assert(html.includes('fikeya-desktop-0.1.0-win32-x64.vsix'), 'VSIX beta download is missing');
assert(html.includes('fikeya-cli-0.1.0-beta.1.zip'), 'CLI beta download is missing');
assert(html.includes('unknown-publisher warning until the installer is Authenticode-signed'), 'Unsigned beta warning is missing');
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
assert(/<loc>https:\/\/fikeya\.com\/<\/loc>\s*<lastmod>2026-09-03<\/lastmod>/u.test(sitemap), 'Homepage sitemap freshness must match the published proof content');
for (const route of ['product', 'proof', 'docs', 'enterprise', 'download', 'privacy', 'signing']) {
	assert(sitemap.includes(`<loc>https://fikeya.com/${route}/</loc>`), `Sitemap is missing /${route}/`);
}
assert(!sitemap.includes('<loc>https://fikeya.com/opensource/</loc>'), 'Homepage alias must not duplicate the canonical URL in the sitemap');
assert(sitemap.includes('<loc>https://fikeya.com/papers/fikeya-cockroach-browser/</loc>'), 'Sitemap is missing the readable browser paper');
assert(sitemap.includes('<loc>https://fikeya.com/docs/cockroach-browser/</loc>'), 'Sitemap is missing the Cockroach Browser integration guide');
assert(browserPaperHtml.includes('<link rel="canonical" href="https://fikeya.com/papers/fikeya-cockroach-browser/">'), 'Browser paper canonical URL is missing');
assert(browserPaperHtml.includes('<h1 id="fikeya-cockroach-browser">Fikeya + Cockroach Browser</h1>'), 'Browser paper title did not render');
assert(browserPaperHtml.includes('29,622,272 bytes, exactly 28.25 MiB'), 'Browser paper lost the exact measured result');
assert(browserPaperHtml.includes('20 measured launches after one warmup'), 'Browser paper masthead lost the measured launch count');
assert(browserPaperHtml.includes('28.25 MiB complete owned browser process-tree maximum'), 'Browser paper masthead lost the process-tree measurement scope');
assert(browserPaperHtml.includes('The Node coordinator was measured separately.'), 'Browser paper masthead lost the coordinator exclusion');
assert(browserPaperHtml.includes('href="/papers/fikeya-cockroach-browser.md"'), 'Browser paper is missing its Markdown source link');
assert(!/href="(?:\.\/|\.\.\/)/u.test(browserPaperHtml), 'Rendered browser paper contains a broken repository-relative link');
assert(Array.from(browserPaperHtml.matchAll(/href="([^"]+)"/gu), match => match[1]).every(isSafePaperLink), 'Rendered browser paper contains an unsupported or off-origin-relative link');
assert(!isSafePaperLink('//evil.example/path') && !isSafePaperLink('/\\evil.example/path') && !isSafePaperLink('/%5cevil.example/path'), 'Paper link policy must reject browser-normalized off-origin paths');
assert((browserPaperHtml.match(/class="paper-table-scroll" role="region" aria-label="Data table \d+" tabindex="0"/gu) ?? []).length === 5, 'Every overflowing paper table must be keyboard-scrollable');
assert(browserIntegrationGuideHtml.includes('<link rel="canonical" href="https://fikeya.com/docs/cockroach-browser/">'), 'Browser integration guide canonical URL is missing');
assert(browserIntegrationGuideHtml.includes('<h1 id="cockroach-browser-open-source-integration-map">Cockroach Browser open-source integration map</h1>'), 'Browser integration guide title did not render');
assert(browserIntegrationGuideHtml.includes('29,622,272 bytes, exactly 28.25 MiB'), 'Browser integration guide lost the exact measured result');
assert(browserIntegrationGuideHtml.includes('does not dispatch Cockroach Browser actions or create browser sessions'), 'Browser integration guide lost the current dispatch boundary');
assert(browserIntegrationGuideHtml.includes('Gate 5: isolation and labs'), 'Browser integration guide lost its gated delivery order');
assert((browserIntegrationGuideHtml.match(/class="paper-table-scroll" role="region" aria-label="Data table \d+" tabindex="0"/gu) ?? []).length === 3, 'Every integration guide table must be keyboard-scrollable');
assert(!/href="(?:\.\/|\.\.\/)/u.test(browserIntegrationGuideHtml), 'Rendered browser integration guide contains a broken repository-relative link');
assert(Array.from(browserIntegrationGuideHtml.matchAll(/href="([^"]+)"/gu), match => match[1]).every(isSafePaperLink), 'Rendered browser integration guide contains an unsupported or off-origin-relative link');
assert(css.includes('.paper-body'), 'Readable browser paper styles are missing');
assert(headers.includes('X-Robots-Tag: noindex, follow'), 'Raw Markdown paper must be excluded from search indexing');
assert(headers.includes('Link: <https://fikeya.com/papers/fikeya-cockroach-browser/>; rel="canonical"'), 'Raw Markdown paper canonical response header is missing');
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
const paperResponse = await worker.fetch(new Request('https://fikeya.com/papers/fikeya-cockroach-browser.md'), {
	ASSETS: { fetch: async () => new Response('# Fikeya + Cockroach Browser', { headers: { 'Content-Type': 'application/octet-stream' } }) }
});
assert(paperResponse.status === 200, 'Browser paper must reach the static asset binding');
assert(paperResponse.headers.get('content-type') === 'text/plain; charset=utf-8', 'Browser paper must render inline as UTF-8 text');
assert(paperResponse.headers.get('content-disposition') === 'inline', 'Browser paper must not be forced to download');
assert(paperResponse.headers.get('x-robots-tag') === 'noindex, follow', 'Browser paper source must not compete with the readable HTML route');
assert(paperResponse.headers.get('link') === '<https://fikeya.com/papers/fikeya-cockroach-browser/>; rel="canonical"', 'Browser paper source canonical header is incorrect');
assert((await paperResponse.text()).startsWith('# Fikeya + Cockroach Browser'), 'Browser paper response content is missing');

assert(updateManifest.enabled === false, 'The source update manifest must stay disabled until a signed release is available');
assert(updateManifest.timestamped === false, 'The disabled update manifest must not claim a timestamped signature');
const disabledUpdateResponse = await worker.fetch(new Request('https://fikeya.com/api/update/win32-x64-user/stable/1111111111111111111111111111111111111111'), {
	ASSETS: { fetch: async () => Response.json(updateManifest) }
});
assert(disabledUpdateResponse.status === 204, 'Disabled update manifests must return no update');
const signedUpdate = {
	...updateManifest,
	enabled: true,
	version: '2222222222222222222222222222222222222222',
	productVersion: 'v0.1.0-beta.3',
	authenticodeSubject: 'CN=Ajnas N B',
	timestamped: true,
	assets: {
		'win32-x64-user': {
			url: 'https://github.com/AjnasNB/fikeya/releases/download/v0.1.0-beta.3/FikeyaSetup-0.1.0-beta.3-win32-x64.exe',
			sha256: 'a'.repeat(64)
		}
	}
};
const signedUpdateResponse = await worker.fetch(new Request('https://fikeya.com/api/update/win32-x64-user/stable/1111111111111111111111111111111111111111'), {
	ASSETS: { fetch: async () => Response.json(signedUpdate) }
});
assert(signedUpdateResponse.status === 200, 'A valid signed update manifest must return an update');
const signedUpdatePayload = await signedUpdateResponse.json();
assert(signedUpdatePayload.version === signedUpdate.version, 'Update response commit is incorrect');
assert(signedUpdatePayload.productVersion === '0.1.0-beta.3', 'Update response product version is incorrect');
const unsignedUpdateResponse = await worker.fetch(new Request('https://fikeya.com/api/update/win32-x64-user/stable/1111111111111111111111111111111111111111'), {
	ASSETS: { fetch: async () => Response.json({ ...signedUpdate, authenticodeSubject: '' }) }
});
assert(unsignedUpdateResponse.status === 204, 'An unsigned update manifest must fail closed');
const updatePostResponse = await worker.fetch(new Request('https://fikeya.com/api/update/win32-x64-user/stable/1111111111111111111111111111111111111111', { method: 'POST' }), {
	ASSETS: { fetch: async () => Response.json(signedUpdate) }
});
assert(updatePostResponse.status === 405, 'The update endpoint must reject non-GET requests');

const allowedExternalLinks = new Set([
	'https://fikeya.com/',
	'https://fikeya.com/opensource/',
	'https://fikeya.com/product/',
	'https://fikeya.com/proof/',
	'https://fikeya.com/docs/',
	'https://fikeya.com/enterprise/',
	'https://fikeya.com/download/',
	'https://fikeya.com/privacy/',
	'https://fikeya.com/signing/',
	'https://github.com/AjnasNB',
	'https://github.com/AjnasNB/fikeya',
	'https://github.com/AjnasNB/fikeya/security/policy',
	'https://github.com/cognifyrdotco',
	'https://github.com/AjnasNB/fikeya/tree/main/docs/fikeya/verification',
	'https://github.com/sponsors/AjnasNB',
	'https://github.com/AjnasNB/fikeya/releases/tag/v0.1.0-beta.1',
	'https://github.com/AjnasNB/fikeya/releases/download/v0.1.0-beta.1/FikeyaSetup-0.1.0-beta.1-win32-x64.exe',
	'https://github.com/AjnasNB/fikeya/releases/download/v0.1.0-beta.1/fikeya-desktop-0.1.0-win32-x64.vsix',
	'https://github.com/AjnasNB/fikeya/releases/download/v0.1.0-beta.1/fikeya-cli-0.1.0-beta.1.zip',
	'https://github.com/AjnasNB/fikeya/blob/main/docs/fikeya/verification/2026-08-25-cli-wrangler.md',
	'https://github.com/AjnasNB/fikeya/tree/main/bench/fikeya-plan-proof',
	'https://github.com/AjnasNB/fikeya/blob/main/bench/fikeya-plan-proof/results/latest.json',
	'https://github.com/AjnasNB/cockroach-browser/blob/v0.5.0-rc.1/docs/benchmarks/obscura-non-visual-2026-09-03.md',
	'https://github.com/AjnasNB/cockroach-browser/releases/tag/v0.5.0-rc.1',
	'https://fikeya-cli-proof-20260825165749.ajnasnb.workers.dev/health',
	'https://qarinah.io/docs/benchmarks/'
]);

for (const [pagePath, page] of new Map([['index.html', html], ...pageDocuments])) {
	const hrefs = Array.from(page.matchAll(/href=["']([^"']+)["']/g), match => match[1]);
	const ids = new Set(Array.from(page.matchAll(/\bid=["']([^"']+)["']/g), match => match[1]));
	for (const href of hrefs) {
		if (href.startsWith('#') && href.length > 1) {
			assert(ids.has(href.slice(1)), `${pagePath} has a broken fragment link: ${href}`);
		}
		if (/^https?:\/\//i.test(href)) {
			assert(allowedExternalLinks.has(href), `${pagePath} has an unexpected external link: ${href}`);
		}
	}
}

if (failures.length > 0) {
	console.error(`Site validation failed with ${failures.length} issue(s):`);
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exitCode = 1;
} else {
	console.log(`Site validation passed (${sourceEntries.length} source files checked).`);
}
