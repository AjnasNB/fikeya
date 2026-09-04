const CANONICAL_HOST = 'fikeya.com';
const UPDATE_PATH = /^\/api\/update\/([^/]+)\/([^/]+)\/([0-9a-f]{40})$/i;
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/AjnasNB/fikeya/releases/download/';
const BROWSER_PAPER_PATH = '/papers/fikeya-cockroach-browser.md';

interface UpdateAsset {
	url: string;
	sha256: string;
}

interface UpdateManifest {
	enabled: boolean;
	version: string;
	productVersion: string;
	quality: string;
	authenticodeSubject: string;
	timestamped: boolean;
	assets: Record<string, UpdateAsset>;
}

interface Env {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.hostname === `www.${CANONICAL_HOST}`) {
			url.hostname = CANONICAL_HOST;
			url.protocol = 'https:';
			return Response.redirect(url.toString(), 301);
		}

		const updateMatch = url.pathname.match(UPDATE_PATH);
		if (updateMatch) {
			if (request.method !== 'GET') {
				return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
			}
			return serveUpdate(env, updateMatch[1], updateMatch[2], updateMatch[3]);
		}

		const assetResponse = await env.ASSETS.fetch(request);
		if (url.pathname === BROWSER_PAPER_PATH && assetResponse.ok) {
			const headers = new Headers(assetResponse.headers);
			headers.set('Content-Disposition', 'inline');
			headers.set('Content-Type', 'text/plain; charset=utf-8');
			headers.set('Link', '<https://fikeya.com/papers/fikeya-cockroach-browser/>; rel="canonical"');
			headers.set('X-Robots-Tag', 'noindex, follow');
			return new Response(request.method === 'HEAD' ? null : assetResponse.body, {
				headers,
				status: assetResponse.status,
				statusText: assetResponse.statusText
			});
		}
		return assetResponse;
	}
};

async function serveUpdate(env: Env, platform: string, quality: string, currentCommit: string): Promise<Response> {
	const manifestRequest = new Request(`https://${CANONICAL_HOST}/updates/latest.json`);
	const manifestResponse = await env.ASSETS.fetch(manifestRequest);
	if (!manifestResponse.ok) {
		return new Response(null, { status: 204 });
	}

	let manifest: UpdateManifest;
	try {
		manifest = await manifestResponse.json() as UpdateManifest;
	} catch {
		return new Response(null, { status: 204 });
	}

	const asset = manifest.assets?.[platform];
	const valid = manifest.enabled === true
		&& manifest.quality === quality
		&& /^[0-9a-f]{40}$/i.test(manifest.version)
		&& manifest.version.toLowerCase() !== currentCommit.toLowerCase()
		&& /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.productVersion)
		&& manifest.authenticodeSubject.trim().length > 0
		&& manifest.timestamped === true
		&& typeof asset?.url === 'string'
		&& asset.url.startsWith(RELEASE_DOWNLOAD_PREFIX)
		&& /^[0-9a-f]{64}$/i.test(asset.sha256);
	if (!valid) {
		return new Response(null, { status: 204 });
	}

	return Response.json({
		url: asset.url,
		version: manifest.version,
		productVersion: manifest.productVersion.replace(/^v/, '')
	}, {
		headers: {
			'Cache-Control': 'private, no-store',
			'Content-Security-Policy': "default-src 'none'",
			'X-Content-Type-Options': 'nosniff'
		}
	});
}
