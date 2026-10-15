/**
 * Conservative canonical-URL normalization used as the dedupe key for a
 * store listing (see `storeListings.canonicalUrl`).
 *
 * This intentionally strips only a small, well-known allowlist of tracking
 * parameters (utm_*, click-id params from ad platforms) and normalizes
 * host casing, default ports, and a trailing slash on the path. It does
 * NOT touch any other query parameter, because many stores legitimately
 * use query parameters to select a product variant (e.g. `?size=50ml`,
 * `?color=red`) — stripping those would silently merge distinct products.
 *
 * Known limitation (documented rather than solved here): if a store
 * changes a product's canonical URL over time (redesign, slug change),
 * this will create a new listing rather than recognizing it as the same
 * product. Stable product identifiers and URL-alias tracking are future
 * work — see the module-level note in `sync.ts`.
 */

const TRACKING_PARAM_PATTERNS = [
	/^utm_/i,
	/^gclid$/i,
	/^fbclid$/i,
	/^msclkid$/i,
	/^yclid$/i,
	/^mc_(cid|eid)$/i,
	/^_ga$/i,
	/^igshid$/i
]

function isTrackingParam(name: string): boolean {
	return TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(name))
}

export class InvalidProductUrlError extends Error {
	constructor(rawUrl: string, cause?: unknown) {
		super(`Cannot canonicalize invalid URL: "${rawUrl}"`)
		this.name = 'InvalidProductUrlError'
		this.cause = cause
	}
}

export function canonicalizeProductUrl(rawUrl: string): string {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch (cause) {
		throw new InvalidProductUrlError(rawUrl, cause)
	}

	url.hostname = url.hostname.toLowerCase()
	url.protocol = url.protocol.toLowerCase()

	const isDefaultPort = (url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')
	if (isDefaultPort) {
		url.port = ''
	}

	for (const key of [...url.searchParams.keys()]) {
		if (isTrackingParam(key)) {
			url.searchParams.delete(key)
		}
	}
	url.searchParams.sort()

	url.hash = ''

	if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
		url.pathname = url.pathname.slice(0, -1)
	}

	return url.toString()
}
