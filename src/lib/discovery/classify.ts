import type { ProductCandidateConfidence } from './types'

const NON_PRODUCT_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|css|js|json|xml|pdf|ico|woff2?|ttf)$/i

const LIKELY_PRODUCT_PATH_PATTERNS = [
	/\/products?\//i,
	/\/product-page\//i,
	/\/item\//i,
	/\/p\/[a-z0-9-]+/i,
	/\/catalog\/[a-z0-9-]+\/[a-z0-9-]+/i
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

	if (LIKELY_PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
		return { candidateConfidence: 'likely', isExcludedAsset: false }
	}

	if (LIKELY_NON_PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(url))) {
		return { candidateConfidence: 'unknown', isExcludedAsset: false }
	}

	return { candidateConfidence: 'unknown', isExcludedAsset: false }
}
