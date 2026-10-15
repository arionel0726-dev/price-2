import { computeNormalizedAttributes } from './attributes'
import { generateCandidatePairs } from './candidates'
import { scoreCandidatePair } from './scoring'
import { DEFAULT_MATCHING_OPTIONS, type MatchableListing, type MatchingOptions, type MatchResult } from './types'

/** Scores a single pair of listings directly (no candidate generation) — useful for tests and ad-hoc inspection. */
export function evaluatePair(a: MatchableListing, b: MatchableListing, options: MatchingOptions = DEFAULT_MATCHING_OPTIONS): MatchResult {
	const attrsA = computeNormalizedAttributes(a)
	const attrsB = computeNormalizedAttributes(b)
	const scored = scoreCandidatePair(attrsA, attrsB, options)
	return { sourceListingId: a.id, candidateListingId: b.id, ...scored }
}

/**
 * Matches every listing in `sourceListings` (typically the owned store)
 * against `competitorListings` (a competitor store). Candidate generation
 * bounds the comparisons (see candidates.ts); each candidate pair is then
 * scored independently and deterministically.
 *
 * Ambiguity handling: if a source listing's best-scoring candidate and its
 * second-best candidate are within `ambiguityMargin` of each other, BOTH
 * are downgraded away from `auto_match` to `needs_review` — picking either
 * one automatically would be a guess, not a decision backed by evidence.
 */
export function matchCatalogs(
	sourceListings: MatchableListing[],
	competitorListings: MatchableListing[],
	options: MatchingOptions = DEFAULT_MATCHING_OPTIONS
): MatchResult[] {
	const sourceAttrs = sourceListings.map(computeNormalizedAttributes)
	const competitorAttrs = competitorListings.map(computeNormalizedAttributes)

	const candidatesByListing = generateCandidatePairs(sourceAttrs, competitorAttrs, options.maxCandidatesPerListing)

	const resultsBySource = new Map<string, MatchResult[]>()

	for (const [sourceListingId, pairs] of candidatesByListing) {
		const results = pairs.map((pair) => {
			const scored = scoreCandidatePair(pair.sourceAttrs, pair.candidateAttrs, options)
			return {
				sourceListingId: pair.sourceAttrs.listingId,
				candidateListingId: pair.candidateAttrs.listingId,
				...scored
			}
		})
		resultsBySource.set(sourceListingId, results)
	}

	const allResults: MatchResult[] = []

	for (const results of resultsBySource.values()) {
		const autoMatches = results.filter((r) => r.decision === 'auto_match').sort((x, y) => y.score - x.score)

		if (autoMatches.length >= 2) {
			const [best, secondBest] = autoMatches
			if (best.score - secondBest.score < options.ambiguityMargin) {
				for (const r of autoMatches) {
					r.decision = 'needs_review'
					r.ambiguous = true
				}
			} else {
				// Keep the top auto_match; downgrade the rest of the auto_match
				// group (not just the second) so only one candidate per source
				// listing is ever auto-confirmed.
				for (const r of autoMatches.slice(1)) {
					r.decision = 'needs_review'
					r.ambiguous = true
				}
			}
		}

		allResults.push(...results)
	}

	return allResults
}
