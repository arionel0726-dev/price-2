/**
 * Per-pilot product URL pattern recognition.
 *
 * This is deliberately NOT part of the generic `classify.ts` heuristic used
 * by the main discovery pipeline — it encodes a specific, observed URL
 * shape for one real pilot site (vizaje-nica.com), validated by a human
 * against that site's actual sitemap before being hardcoded here. Matching
 * this pattern only makes a URL a *candidate*; JSON-LD extraction remains
 * the authority on whether a page is actually a product (see
 * `src/lib/scraping/extract.ts`) — this module never claims otherwise.
 */

export type PilotLanguage = 'ro' | 'ru'

export interface PilotUrlMatch {
	language: PilotLanguage
	category: string
	numericId: string
}

// /ro/catalog/<category>/<numeric-id> or /ru/catalog/<category>/<numeric-id>, optional trailing slash.
const VIZAJE_NICA_PRODUCT_PATTERN = /^\/(ro|ru)\/catalog\/([^/]+)\/(\d+)\/?$/i

/**
 * Matches a URL against the vizaje-nica.com product-page pattern. Returns
 * null for anything else (category pages without a numeric id, non-catalog
 * paths, asset URLs, etc.) — those are not treated as product candidates
 * for this pilot, regardless of what the generic classifier would say.
 */
export function matchVizajeNicaProductUrl(url: string): PilotUrlMatch | null {
	let pathname: string
	try {
		pathname = new URL(url).pathname
	} catch {
		return null
	}

	const match = pathname.match(VIZAJE_NICA_PRODUCT_PATTERN)
	if (!match) return null

	const language = match[1].toLowerCase()
	if (language !== 'ro' && language !== 'ru') return null

	return { language, category: match[2], numericId: match[3] }
}

/**
 * Deduplicates language variants of the same product (same category +
 * numeric id, different /ro//ru/ prefix), keeping the Romanian URL when
 * both language variants are present in the input, per the pilot's
 * preference for Romanian as the primary sample language.
 */
export function dedupeLanguageVariants(urls: string[]): string[] {
	const byKey = new Map<string, { url: string; match: PilotUrlMatch }>()

	for (const url of urls) {
		const match = matchVizajeNicaProductUrl(url)
		if (!match) continue

		const key = `${match.category}/${match.numericId}`
		const existing = byKey.get(key)
		if (!existing || (existing.match.language !== 'ro' && match.language === 'ro')) {
			byKey.set(key, { url, match })
		}
	}

	return [...byKey.values()].map((entry) => entry.url)
}
