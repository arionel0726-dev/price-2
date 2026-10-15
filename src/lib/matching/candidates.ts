import type { NormalizedListingAttributes } from './attributes'

export interface CandidatePair {
	sourceAttrs: NormalizedListingAttributes
	candidateAttrs: NormalizedListingAttributes
}

/**
 * Generates a bounded set of candidate pairs between `sourceListings` (e.g.
 * the owned store) and `competitorListings`, without ever comparing every
 * source listing against every competitor listing (no Cartesian product).
 *
 * Candidates for one source listing are the union of competitor listings
 * that share an indexed key with it: a validated GTIN, a normalized brand,
 * or a significant title token. Each index is a simple Map built in one
 * pass over the competitor side, so lookup per source listing is O(bucket
 * size), not O(competitor catalog size).
 *
 * `maxCandidatesPerListing` caps the result per source listing (keeping the
 * ones with the most shared title tokens first) so a very common brand or
 * token bucket cannot blow up the comparison count.
 */
export function generateCandidatePairs(
	sourceListings: NormalizedListingAttributes[],
	competitorListings: NormalizedListingAttributes[],
	maxCandidatesPerListing: number
): Map<string, CandidatePair[]> {
	const gtinIndex = new Map<string, NormalizedListingAttributes[]>()
	const brandIndex = new Map<string, NormalizedListingAttributes[]>()
	const tokenIndex = new Map<string, NormalizedListingAttributes[]>()

	for (const listing of competitorListings) {
		if (listing.gtin) addToIndex(gtinIndex, listing.gtin, listing)
		if (listing.brand) addToIndex(brandIndex, listing.brand, listing)
		for (const token of significantTokens(listing.titleTokens)) {
			addToIndex(tokenIndex, token, listing)
		}
	}

	const result = new Map<string, CandidatePair[]>()

	for (const source of sourceListings) {
		const seen = new Map<string, { attrs: NormalizedListingAttributes; tokenOverlap: number }>()

		if (source.gtin) {
			for (const candidate of gtinIndex.get(source.gtin) ?? []) {
				upsertSeen(seen, candidate, significantTokenOverlap(source, candidate))
			}
		}
		if (source.brand) {
			for (const candidate of brandIndex.get(source.brand) ?? []) {
				upsertSeen(seen, candidate, significantTokenOverlap(source, candidate))
			}
		}
		for (const token of significantTokens(source.titleTokens)) {
			for (const candidate of tokenIndex.get(token) ?? []) {
				upsertSeen(seen, candidate, significantTokenOverlap(source, candidate))
			}
		}

		const ranked = [...seen.values()].sort((x, y) => y.tokenOverlap - x.tokenOverlap).slice(0, maxCandidatesPerListing)

		result.set(
			source.listingId,
			ranked.map((r) => ({ sourceAttrs: source, candidateAttrs: r.attrs }))
		)
	}

	return result
}

function addToIndex(index: Map<string, NormalizedListingAttributes[]>, key: string, listing: NormalizedListingAttributes): void {
	const bucket = index.get(key)
	if (bucket) bucket.push(listing)
	else index.set(key, [listing])
}

function upsertSeen(
	seen: Map<string, { attrs: NormalizedListingAttributes; tokenOverlap: number }>,
	candidate: NormalizedListingAttributes,
	tokenOverlap: number
): void {
	if (!seen.has(candidate.listingId)) {
		seen.set(candidate.listingId, { attrs: candidate, tokenOverlap })
	}
}

const STOPWORDS = new Set(['de', 'la', 'le', 'du', 'des', 'and', 'for', 'with', 'eau'])

/** Title tokens long enough and specific enough to be useful bucket keys (skips short/common words). */
function significantTokens(tokens: string[]): string[] {
	return tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

function significantTokenOverlap(a: NormalizedListingAttributes, b: NormalizedListingAttributes): number {
	const setA = new Set(significantTokens(a.titleTokens))
	const setB = new Set(significantTokens(b.titleTokens))
	let overlap = 0
	for (const t of setA) if (setB.has(t)) overlap++
	return overlap
}
