/**
 * A listing as seen by the matching engine. Deliberately a plain data shape
 * (not the Drizzle row type) so the engine stays independent of the
 * database — see `src/lib/catalog/*` for how this is populated from
 * `store_listings` in `candidates.ts`/`service.ts`.
 */
export interface MatchableListing {
	id: string
	storeId: string
	/** Raw (not matching-normalized) title, preserved for display/audit. */
	sourceTitle: string | null
	/** Already normalized by Task 1/2 (whitespace-only normalization), used as the matching input. */
	normalizedTitle: string | null
	brand: string | null
	sku: string | null
	gtin: string | null
	variant: string | null
}

export type MatchDecision = 'auto_match' | 'needs_review' | 'reject'

export interface MatchSignal {
	code: string
	detail?: string
}

export interface ComparedAttributes {
	brandA: string | null
	brandB: string | null
	titleA: string | null
	titleB: string | null
	titleSimilarity: number
	volumeA: ParsedVolume | null
	volumeB: ParsedVolume | null
	concentrationA: string | null
	concentrationB: string | null
	variantCodeA: string | null
	variantCodeB: string | null
	formatA: string | null
	formatB: string | null
	gtinA: string | null
	gtinB: string | null
}

export interface ParsedVolume {
	value: number
	unit: 'ml' | 'g'
	raw: string
}

export interface MatchResult {
	sourceListingId: string
	candidateListingId: string
	score: number
	decision: MatchDecision
	positiveSignals: MatchSignal[]
	conflictingSignals: MatchSignal[]
	missingAttributes: string[]
	comparedAttributes: ComparedAttributes
	/** Set by the engine when this candidate's score was too close to another candidate's to pick automatically. */
	ambiguous?: boolean
}

export interface MatchingOptions {
	/** Minimum score AND strong-identity-evidence gate required for `auto_match`. */
	autoMatchThreshold: number
	/** Minimum score for `needs_review`; below this the decision is `reject`. */
	reviewThreshold: number
	/** Title similarity (0..1) considered "strong" enough to count as identity evidence alongside brand+volume. */
	strongTitleSimilarityThreshold: number
	/** If the best and second-best candidate scores for the same source listing differ by less than this, both are forced to `needs_review`. */
	ambiguityMargin: number
	/** Upper bound on candidates considered per source listing (see candidates.ts). */
	maxCandidatesPerListing: number
}

export const DEFAULT_MATCHING_OPTIONS: MatchingOptions = {
	autoMatchThreshold: 0.75,
	reviewThreshold: 0.35,
	strongTitleSimilarityThreshold: 0.82,
	ambiguityMargin: 0.05,
	maxCandidatesPerListing: 25
}

/** Bumped whenever scoring/exclusion rules change in a way that could alter past decisions. Stored per persisted match row. */
export const MATCHING_ALGORITHM_VERSION = '1.0.0'
