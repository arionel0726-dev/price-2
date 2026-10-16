import type { ProductCandidateConfidence } from './types'

const NON_PRODUCT_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|css|js|json|xml|pdf|ico|woff2?|ttf)$/i

const LIKELY_PRODUCT_PATH_PATTERNS: { pattern: RegExp; description: string }[] = [
	{ pattern: /\/products?\//i, description: 'path contains /product/ or /products/' },
	{ pattern: /\/product-page\//i, description: 'path contains /product-page/' },
	{ pattern: /\/item\//i, description: 'path contains /item/' },
	{ pattern: /\/p\/[a-z0-9-]+/i, description: 'path matches /p/<slug>' },
	{ pattern: /\/catalog\/[a-z0-9-]+\/[a-z0-9-]+/i, description: 'path matches /catalog/<category>/<slug>' }
]

const LIKELY_NON_PRODUCT_PATH_PATTERNS = [
	/\/(category|categories|collections?|brands?|cart|checkout|account|search|blog|news|page)(\/|$)/i,
	/\?.*page=\d+/i
]

export interface UrlClassification {
	candidateConfidence: ProductCandidateConfidence
	/** True when the URL should be dropped entirely (clearly a non-page asset), not just marked low-confidence. */
	isExcludedAsset: boolean
}

/**
 * Classifies a discovered URL as a "likely product page" or "unknown".
 *
 * This is a coarse heuristic used only to prioritize/annotate discovery
 * output. It deliberately never asserts that a URL is *not* a product
 * (false negatives are worse than false positives here, since extraction
 * is the real source of truth) — it only filters out URLs that are
 * obviously not HTML pages at all (images, stylesheets, etc).
 */
export function classifyProductCandidate(url: string): UrlClassification {
	let pathname: string
	try {
		pathname = new URL(url).pathname
	} catch {
		return { candidateConfidence: 'unknown', isExcludedAsset: false }
	}

	if (NON_PRODUCT_EXTENSIONS.test(pathname)) {
		return { candidateConfidence: 'unknown', isExcludedAsset: true }
	}

	if (LIKELY_PRODUCT_PATH_PATTERNS.some(({ pattern }) => pattern.test(pathname))) {
		return { candidateConfidence: 'likely', isExcludedAsset: false }
	}

	if (LIKELY_NON_PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(url))) {
		return { candidateConfidence: 'unknown', isExcludedAsset: false }
	}

	return { candidateConfidence: 'unknown', isExcludedAsset: false }
}

/**
 * Diagnostic-only companion to `classifyProductCandidate`: explains *why* a
 * URL was (or was not) rated a "likely" product candidate, for surfacing in
 * validate-live's `candidateDiagnostics` (see Task 6.1 §1 — "report the
 * selected candidate URLs and the classification reason"). Never used to
 * change classification behavior itself, only to describe it.
 */
export function describeProductCandidateClassification(url: string): string {
	let pathname: string
	try {
		pathname = new URL(url).pathname
	} catch {
		return 'URL could not be parsed'
	}

	if (NON_PRODUCT_EXTENSIONS.test(pathname)) {
		return 'excluded: path extension indicates a non-HTML asset (image/script/stylesheet/etc.)'
	}

	const matchedLikely = LIKELY_PRODUCT_PATH_PATTERNS.find(({ pattern }) => pattern.test(pathname))
	if (matchedLikely) {
		return `generic heuristic matched: ${matchedLikely.description}`
	}

	if (LIKELY_NON_PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(url))) {
		return 'generic heuristic matched a known non-product pattern (category/collection/cart/checkout/account/search/blog/news/paginated listing)'
	}

	return 'no generic heuristic matched either way (neither clearly product nor clearly non-product)'
}
