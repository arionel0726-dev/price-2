/**
 * makeup.md discovery profile — UNVERIFIED.
 *
 * Unlike vizaje-nica.com's classifier (`vizaje-nica.ts`), we have not yet
 * inspected a real sitemap or product page from makeup.md: live access
 * requires separate, explicit approval (see AGENTS.md / Task 4-6 scope
 * notes), and none has been granted for this task. Per Task 6 §3/§4, this
 * module deliberately does NOT invent a specific URL-shape regex the way
 * `pilot-patterns.ts` does for vizaje-nica.com — that would be guessing.
 *
 * Instead, `classifyProductUrl` only ever marks a URL as a candidate when
 * the existing, already-reviewed generic heuristic
 * (`src/lib/discovery/classify.ts`) rates it "likely" a product page
 * (common path shapes: `/product/`, `/p/<slug>`, `/catalog/<cat>/<slug>`)
 * AND it doesn't match the explicit category/search/cart/account/checkout
 * denylist below. `patternConfidence: 'unverified'` on the exported
 * profile is surfaced in diagnostics specifically so this is never
 * mistaken for a confirmed finding — it must be checked against real
 * sitemap data on the first approved live run (see delivery notes).
 *
 * The sitemap location given in the task (`/sitemap/sitemap.xml`) is
 * explicitly a "previously advertised, not guaranteed current" candidate;
 * it is used as the default but is overridable via `--sitemap-url`.
 */
import { canonicalizeProductUrl, InvalidProductUrlError } from '../../catalog/url'
import { classifyProductCandidate, describeProductCandidateClassification } from '../classify'
import type { StoreProfile, StoreUrlMatch } from './types'

// Defense in depth alongside classify.ts's own non-product patterns: explicitly
// vetoes search/cart/checkout/account/login paths regardless of what the
// generic "likely product" heuristic says.
const DENYLIST_PATTERNS: { pattern: RegExp; description: string }[] = [
	{
		pattern: /\/(search|cart|checkout|account|login|register|wishlist|compare)(\/|$|\?)/i,
		description: 'path matches the explicit search/cart/checkout/account/login/register/wishlist/compare denylist'
	}
]

function matchedDenylistReason(pathname: string): string | null {
	return DENYLIST_PATTERNS.find(({ pattern }) => pattern.test(pathname))?.description ?? null
}

function classifyProductUrl(url: string): StoreUrlMatch | null {
	let pathname: string
	try {
		pathname = new URL(url).pathname
	} catch {
		return null
	}

	if (matchedDenylistReason(pathname)) return null

	const classification = classifyProductCandidate(url)
	if (classification.isExcludedAsset) return null
	if (classification.candidateConfidence !== 'likely') return null

	let dedupeKey: string
	try {
		dedupeKey = canonicalizeProductUrl(url)
	} catch (cause) {
		if (cause instanceof InvalidProductUrlError) return null
		throw cause
	}

	return {
		dedupeKey,
		reason: `${describeProductCandidateClassification(url)} — makeup.md URL shape is UNVERIFIED (no confirmed real sitemap/page sample yet); this is a candidate, not a confirmed product page`
	}
}

/**
 * Deduplicates by conservative URL canonicalization only (tracking-param
 * and trailing-slash/port normalization — see src/lib/catalog/url.ts).
 * This does NOT attempt a language-variant dedup the way vizaje-nica.com's
 * does, because we have no confirmed evidence makeup.md even has
 * language-specific URL variants, let alone what they look like.
 */
function dedupeProductUrls(urls: string[]): string[] {
	const seen = new Map<string, string>()
	for (const url of urls) {
		let key: string
		try {
			key = canonicalizeProductUrl(url)
		} catch {
			continue
		}
		if (!seen.has(key)) seen.set(key, url)
	}
	return [...seen.values()]
}

export const makeupMdStoreProfile: StoreProfile = {
	domain: 'makeup.md',
	defaultSitemapUrl: 'https://makeup.md/sitemap/sitemap.xml',
	patternConfidence: 'unverified',
	classifyProductUrl,
	dedupeProductUrls
}
