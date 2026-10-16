/**
 * ovico.md discovery profile — UNVERIFIED beyond one confirmed example.
 *
 * Public research (Task 7) confirmed exactly one real product URL:
 *   https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml
 *
 * This is a FLAT shape — `/ru/<slug>` (or presumably `/ro/<slug>`) with no
 * `/product/`, `/p/`, or `/catalog/<category>/<id>` segment — so it does
 * NOT match the generic "likely product" heuristic in
 * `src/lib/discovery/classify.ts` (which looks specifically for those
 * shapes). Reusing that generic heuristic here, as makeup.md's profile
 * does, would therefore silently EXCLUDE the one URL we actually know is a
 * real product page. A dedicated, narrowly-scoped pattern matching this
 * flat shape is used instead, analogous to vizaje-nica.com's hardcoded
 * pattern (`pilot-patterns.ts`) — but unlike vizaje-nica's (confirmed
 * against many real pages), this is based on a SINGLE confirmed URL plus
 * an explicit denylist of common non-product top-level sections. A
 * category or brand-listing page could plausibly share the exact same flat
 * shape (e.g. `/ru/parfyumeriya`), and we have no sitemap/page evidence yet
 * to rule that out — so `patternConfidence: 'unverified'` is kept, and
 * every match is deliberately a *candidate*, never a confirmed product.
 *
 * The sitemap location (`/media/sitemap/sitemap_index.xml`) comes from
 * ovico.md's own robots.txt and is used as the default, overridable via
 * `--sitemap-url`. Nested sitemap indexes are handled by the existing,
 * unmodified bounded discovery infrastructure (`src/lib/discovery/sitemap.ts`).
 */
import { canonicalizeProductUrl, InvalidProductUrlError } from '../../catalog/url'
import { classifyAndExtractOvicoHtml } from '../../scraping/adapters/ovico'
import type { StoreProfile, StoreUrlMatch } from './types'

const OVICO_FLAT_SLUG_PATTERN = /^\/(ru|ro)\/([a-z0-9-]+)\/?$/i

// Common top-level e-commerce sections that could plausibly share the same
// flat /ru|ro/<slug> shape as a real product. None of these were confirmed
// on ovico.md specifically — this is a conservative, defense-in-depth
// denylist, the same style used for makeup.md's profile.
const DENYLISTED_SLUG_PREFIXES = [
	'search',
	'cart',
	'checkout',
	'account',
	'login',
	'register',
	'wishlist',
	'compare',
	'catalog',
	'category',
	'categories',
	'brand',
	'brands',
	'collection',
	'collections',
	'blog',
	'news',
	'page'
]

function isDenylistedSlug(slug: string): string | null {
	const normalized = slug.toLowerCase()
	const matched = DENYLISTED_SLUG_PREFIXES.find((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`))
	return matched ? `slug starts with the known non-product section "${matched}"` : null
}

function classifyProductUrl(url: string): StoreUrlMatch | null {
	let pathname: string
	try {
		pathname = new URL(url).pathname
	} catch {
		return null
	}

	const match = pathname.match(OVICO_FLAT_SLUG_PATTERN)
	if (!match) return null

	const language = match[1].toLowerCase()
	const slug = match[2]

	const denylistReason = isDenylistedSlug(slug)
	if (denylistReason) return null

	let dedupeKey: string
	try {
		dedupeKey = canonicalizeProductUrl(url)
	} catch (cause) {
		if (cause instanceof InvalidProductUrlError) return null
		throw cause
	}

	return {
		dedupeKey,
		language,
		reason:
			`Matched the flat /${language}/<slug> shape confirmed on one real product URL ` +
			'(jo-malone-london-pine-eucalyptus-diffuser-165ml); slug did not match the known category/brand/search/' +
			'account/checkout denylist. ovico.md\'s URL pattern is UNVERIFIED beyond that single example — this is a ' +
			'candidate, not a confirmed product page.'
	}
}

/**
 * Deduplicates by conservative URL canonicalization only (tracking-param
 * and trailing-slash/port normalization — see src/lib/catalog/url.ts).
 * Deliberately does NOT merge /ru/ and /ro/ variants of what might be the
 * same product: there is no confirmed evidence they share a slug or any
 * other stable identifier, so merging them would risk silently treating
 * two different products as one (see Task 7 §5 — "deduplicate ... only
 * when equivalence is reliable").
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

export const ovicoMdStoreProfile: StoreProfile = {
	domain: 'ovico.md',
	defaultSitemapUrl: 'https://ovico.md/media/sitemap/sitemap_index.xml',
	patternConfidence: 'unverified',
	classifyProductUrl,
	dedupeProductUrls,
	// ovico.md's confirmed real product HTML carries no Product JSON-LD at
	// all (see Task 7.1 delivery notes) — without this, every ovico.md page
	// would be reported missing_json_ld regardless of whether it's actually
	// a genuine, available product. See src/lib/scraping/adapters/ovico.ts.
	htmlOnlyExtract: classifyAndExtractOvicoHtml
}
