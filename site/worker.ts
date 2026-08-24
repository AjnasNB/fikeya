const CANONICAL_HOST = 'fikeya.com';

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
			return Response.redirect(url.toString(), 301);
		}

		return env.ASSETS.fetch(request);
	}
};
