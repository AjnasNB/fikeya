const quotedHrefPattern = /\bhref\s*=\s*(["'])([^"'<>]*)\1/gi;

/**
 * Return true only when an HTML document contains the exact secure absolute URL.
 *
 * Parsing both sides as URLs prevents a trusted URL from being accepted merely
 * because it appears inside an attacker-controlled host, path, or query string.
 */
export function hasExactSecureHref(document: string, expectedHref: string): boolean {
	let expected: URL;
	try {
		expected = new URL(expectedHref);
	} catch {
		return false;
	}
	if (expected.protocol !== 'https:' || expected.username || expected.password) {
		return false;
	}

	for (const match of document.matchAll(quotedHrefPattern)) {
		let candidate: URL;
		try {
			candidate = new URL(match[2]);
		} catch {
			continue;
		}
		if (
			candidate.protocol === 'https:'
			&& !candidate.username
			&& !candidate.password
			&& candidate.href === expected.href
		) {
			return true;
		}
	}
	return false;
}
