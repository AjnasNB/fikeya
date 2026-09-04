import { Marked, Renderer } from 'marked';

const MAXIMUM_PAPER_BYTES = 512 * 1024;

export function isSafePaperLink(href) {
	if (typeof href !== 'string' || href.length === 0 || /[\\\u0000-\u001f\u007f]/u.test(href) || /%5c/iu.test(href)) {
		return false;
	}
	if (href.startsWith('#')) {
		return true;
	}
	if (href.startsWith('/')) {
		return !href.startsWith('//');
	}
	try {
		const url = new URL(href);
		return url.protocol === 'https:' && url.username === '' && url.password === '';
	} catch {
		return false;
	}
}

function escapeHtml(value) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function headingSlug(value, seen) {
	const base = value
		.replace(/<[^>]+>/gu, '')
		.replace(/&(?:amp|lt|gt|quot|#39);/gu, '')
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-|-$/gu, '') || 'section';
	const count = seen.get(base) ?? 0;
	seen.set(base, count + 1);
	return count === 0 ? base : `${base}-${count + 1}`;
}

function renderMarkdown(markdown) {
	const seenHeadings = new Map();
	let tableIndex = 0;
	const renderer = new Renderer();
	renderer.html = ({ text }) => escapeHtml(text);
	renderer.heading = function ({ tokens, depth }) {
		const content = this.parser.parseInline(tokens);
		return `<h${depth} id="${headingSlug(content, seenHeadings)}">${content}</h${depth}>\n`;
	};
	renderer.link = function ({ href, title, tokens }) {
		const content = this.parser.parseInline(tokens);
		if (!isSafePaperLink(href)) {
			return content;
		}
		const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
		const external = href.startsWith('https://') ? ' rel="noopener noreferrer"' : '';
		return `<a href="${escapeHtml(href)}"${titleAttribute}${external}>${content}</a>`;
	};
	const renderTable = renderer.table;
	renderer.table = function (token) {
		tableIndex += 1;
		return `<div class="paper-table-scroll" role="region" aria-label="Data table ${tableIndex}" tabindex="0">${renderTable.call(this, token)}</div>\n`;
	};
	const parser = new Marked({ gfm: true, renderer });
	return parser.parse(markdown);
}

export function renderBrowserPaper(markdown) {
	if (typeof markdown !== 'string' || markdown.length === 0 || Buffer.byteLength(markdown, 'utf8') > MAXIMUM_PAPER_BYTES) {
		throw new Error('The Fikeya + Cockroach Browser paper must be non-empty and at most 512 KiB.');
	}
	if (/\]\((?:\.\/|\.\.\/)/u.test(markdown)) {
		throw new Error('The published paper cannot contain repository-relative links.');
	}
	const article = renderMarkdown(markdown);
	if (!article.includes('<h1 id="fikeya-cockroach-browser">') || /(?:javascript:|<script\b|\son\w+=)/iu.test(article)) {
		throw new Error('The rendered paper did not satisfy the static HTML safety contract.');
	}
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<meta name="description" content="Fikeya and Cockroach Browser architecture, exact benchmark scope, feature priorities, evaluation plan, target users, and go-to-market strategy.">
		<meta name="robots" content="index, follow, max-image-preview:large">
		<meta name="theme-color" content="#0b0f0e">
		<meta name="color-scheme" content="dark">
		<meta property="og:type" content="article">
		<meta property="og:site_name" content="Fikeya">
		<meta property="og:title" content="Fikeya + Cockroach Browser | Technical and market paper">
		<meta property="og:description" content="A governed browser architecture, exact benchmark scope, product gates, target users, and ninety-day distribution plan.">
		<meta property="og:url" content="https://fikeya.com/papers/fikeya-cockroach-browser/">
		<meta property="og:image" content="https://fikeya.com/fikeya-desktop-beta-agent.jpg">
		<meta property="og:image:alt" content="Fikeya Desktop agent workspace.">
		<meta name="twitter:card" content="summary_large_image">
		<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'none'; connect-src 'self'; upgrade-insecure-requests">
		<title>Fikeya + Cockroach Browser | Technical and market paper</title>
		<link rel="canonical" href="https://fikeya.com/papers/fikeya-cockroach-browser/">
		<link rel="icon" href="/favicon.svg?v=20260825h" type="image/svg+xml">
		<link rel="manifest" href="/site.webmanifest">
		<link rel="stylesheet" href="/styles.css?v=20260903c">
	</head>
	<body class="paper-page">
		<a class="skip-link" href="#paper">Skip to paper</a>
		<header class="site-header"><div class="shell nav-shell"><a class="brand" href="/" aria-label="Fikeya home"><img src="/favicon.svg?v=20260825h" width="30" height="30" alt=""><span>Fikeya</span></a><nav aria-label="Primary navigation"><ul class="nav-links"><li><a href="/">Home</a></li><li><a href="/opensource/" aria-current="true">Open Source</a></li><li><a href="/product/">Product</a></li><li><a href="/proof/">Proof</a></li><li><a href="/docs/">Docs</a></li><li><a href="/enterprise/">Enterprise</a></li><li><a href="/download/">Download</a></li></ul></nav><div class="nav-actions"><a href="https://github.com/sponsors/AjnasNB" rel="noopener noreferrer">Sponsor</a><a class="nav-source" href="https://github.com/AjnasNB/fikeya" rel="noopener noreferrer">GitHub</a></div></div></header>
		<main>
			<section class="paper-masthead"><div class="shell paper-masthead-layout"><div><p class="eyebrow">Technical + market paper · September 2026</p><p class="paper-lede">Architecture, authority, exact benchmark scope, competitive landscape, release gates, target users, evaluation, and distribution: one inspectable document.</p></div><div class="hero-actions"><a class="button button-primary" href="/opensource/">Explore Fikeya</a><a class="button button-text" href="/papers/fikeya-cockroach-browser.md">Markdown source</a></div><dl class="paper-facts"><div><dt>Measured fixture</dt><dd>Pinned Obscura 0.2.1 · constrained non-visual</dd></div><div><dt>20 measured launches after one warmup</dt><dd>29,622,272 bytes · 28.25 MiB complete owned browser process-tree maximum</dd></div><div><dt>Public boundary</dt><dd>30 MiB PASS</dd></div><div class="paper-fact-scope"><dt>Scope boundary</dt><dd>The Node coordinator was measured separately. This excludes Fikeya Desktop, arbitrary or rendered pages, persistent or attached sessions, and Chromium, Firefox, and WebKit memory.</dd></div></dl></div></section>
			<section class="paper-shell"><article class="paper-body" id="paper">${article}</article></section>
		</main>
		<footer class="site-footer"><div class="shell footer-layout"><div class="brand footer-brand"><img src="/favicon.svg?v=20260825h" width="28" height="28" alt=""><span>Fikeya</span></div><p>One evidence-scoped plan for the governed browser product.</p><div><a href="/papers/fikeya-cockroach-browser.md">Markdown</a><a href="https://github.com/AjnasNB/fikeya" rel="noopener noreferrer">Source</a><a href="/opensource/">Open Source</a><a href="/download/">Download</a></div></div></footer>
	</body>
</html>
`;
}

export function renderBrowserIntegrationGuide(markdown) {
	if (typeof markdown !== 'string' || markdown.length === 0 || Buffer.byteLength(markdown, 'utf8') > MAXIMUM_PAPER_BYTES) {
		throw new Error('The Cockroach Browser integration guide must be non-empty and at most 512 KiB.');
	}
	if (/\]\((?:\.\/|\.\.\/)/u.test(markdown)) {
		throw new Error('The published integration guide cannot contain repository-relative links.');
	}
	const article = renderMarkdown(markdown);
	if (!article.includes('<h1 id="cockroach-browser-open-source-integration-map">') || /(?:javascript:|<script\b|\son\w+=)/iu.test(article)) {
		throw new Error('The rendered integration guide did not satisfy the static HTML safety contract.');
	}
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<meta name="description" content="The prioritized open-source protocol, engine, agent, observability, security, extraction, and testing integration map for Fikeya and Cockroach Browser.">
		<meta name="robots" content="index, follow, max-image-preview:large">
		<meta name="theme-color" content="#0b0f0e">
		<meta name="color-scheme" content="dark">
		<meta property="og:type" content="article">
		<meta property="og:site_name" content="Fikeya">
		<meta property="og:title" content="Cockroach Browser | Open-source integration map">
		<meta property="og:description" content="A gated roadmap for browser protocols, engines, agent adapters, evidence, isolation, and conformance.">
		<meta property="og:url" content="https://fikeya.com/docs/cockroach-browser/">
		<meta property="og:image" content="https://fikeya.com/fikeya-desktop-beta-agent.jpg">
		<meta property="og:image:alt" content="Fikeya Desktop agent workspace.">
		<meta name="twitter:card" content="summary_large_image">
		<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'none'; connect-src 'self'; upgrade-insecure-requests">
		<title>Cockroach Browser | Open-source integration map</title>
		<link rel="canonical" href="https://fikeya.com/docs/cockroach-browser/">
		<link rel="icon" href="/favicon.svg?v=20260825h" type="image/svg+xml">
		<link rel="manifest" href="/site.webmanifest">
		<link rel="stylesheet" href="/styles.css?v=20260903c">
	</head>
	<body class="paper-page">
		<a class="skip-link" href="#main">Skip to guide</a>
		<header class="site-header"><div class="shell nav-shell"><a class="brand" href="/" aria-label="Fikeya home"><img src="/favicon.svg?v=20260825h" width="30" height="30" alt=""><span>Fikeya</span></a><nav aria-label="Primary navigation"><ul class="nav-links"><li><a href="/">Home</a></li><li><a href="/opensource/">Open Source</a></li><li><a href="/product/">Product</a></li><li><a href="/proof/">Proof</a></li><li><a href="/docs/" aria-current="true">Docs</a></li><li><a href="/enterprise/">Enterprise</a></li><li><a href="/download/">Download</a></li></ul></nav><div class="nav-actions"><a href="https://github.com/sponsors/AjnasNB" rel="noopener noreferrer">Sponsor</a><a class="nav-source" href="https://github.com/AjnasNB/fikeya" rel="noopener noreferrer">GitHub</a></div></div></header>
		<main id="main">
			<section class="paper-masthead"><div class="shell paper-masthead-layout"><div><p class="eyebrow">Architecture guide · September 2026</p><p class="paper-lede">A prioritized map of what to integrate, where each component belongs, and what must pass before it is described as shipped.</p></div><div class="hero-actions"><a class="button button-primary" href="/docs/">Fikeya docs</a><a class="button button-text" href="/papers/fikeya-cockroach-browser/">Technical paper</a></div><dl class="paper-facts"><div><dt>Current lane</dt><dd>Pinned Obscura 0.2.1 through Cockroach Browser 0.5.0-rc.1</dd></div><div><dt>Verified fixture</dt><dd>29,622,272 bytes · exactly 28.25 MiB</dd></div><div><dt>Core rule</dt><dd>Adapters propose; Cockroach preflights and authorizes</dd></div><div class="paper-fact-scope"><dt>Roadmap boundary</dt><dd>Items are explicitly classified by gate. Listing a technology does not claim that its runtime integration has shipped.</dd></div></dl></div></section>
			<section class="paper-shell"><article class="paper-body" id="guide">${article}</article></section>
		</main>
		<footer class="site-footer"><div class="shell footer-layout"><div class="brand footer-brand"><img src="/favicon.svg?v=20260825h" width="28" height="28" alt=""><span>Fikeya</span></div><p>The governed browser integration roadmap.</p><div><a href="/docs/">Docs</a><a href="/papers/fikeya-cockroach-browser/">Paper</a><a href="/opensource/">Open Source</a><a href="https://github.com/AjnasNB/fikeya" rel="noopener noreferrer">Source</a></div></div></footer>
	</body>
</html>
`;
}
