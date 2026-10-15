import { diceBigramSimilarity, titleSimilarity } from './normalize'
import type { NormalizedListingAttributes } from './attributes'
import { checkHardExclusions } from './exclusions'
import type { ComparedAttributes, MatchDecision, MatchingOptions, MatchResult, MatchSignal } from './types'

/**
 * Signal weights. Chosen so that a valid matching GTIN alone can reach
 * `autoMatchThreshold` by itself (GTIN is the one identifier that is, by
 * design, globally unique — see AGENTS.md matching priority order), while
 * title similarity alone (max 0.3) never can, however similar the titles
 * are — satisfying "a similar title alone must never be sufficient for
 * automatic matching."
 */
const WEIGHTS = {
	gtinExactMatch: 0.78,
	brandExactMatch: 0.25,
	brandSimilar: 0.12,
	titleSimilarityMax: 0.3,
	volumeMatch: 0.15,
	concentrationMatch: 0.1,
	variantMatch: 0.05
}

const BRAND_SIMILAR_THRESHOLD = 0.8

function compareBrand(a: NormalizedListingAttributes, b: NormalizedListingAttributes, positive: MatchSignal[], missing: string[]): void {
	if (!a.brand || !b.brand) {
		missing.push('brand')
		return
	}
	if (a.brand === b.brand) {
		positive.push({ code: 'brand_match', detail: a.brand })
		return
	}
	// Brand-conflict-level differences were already excluded upstream; a
	// surviving non-exact similarity here is treated as weak positive
	// evidence (e.g. minor transliteration drift the dictionary missed),
	// never as a conflict.
	const similarity = diceBigramSimilarity(a.brand, b.brand)
	if (similarity >= BRAND_SIMILAR_THRESHOLD) {
		positive.push({ code: 'brand_similar', detail: `${a.brand} ~ ${b.brand} (${similarity.toFixed(2)})` })
	} else {
		missing.push('brand')
	}
}

function compareGtin(a: NormalizedListingAttributes, b: NormalizedListingAttributes, positive: MatchSignal[], missing: string[]): void {
	if (!a.gtin || !b.gtin) {
		missing.push('gtin')
		return
	}
	if (a.gtin === b.gtin) {
		positive.push({ code: 'gtin_exact_match', detail: a.gtin })
		return
	}
	// Different GTINs reaching scoring at all means the bundle/packaging
	// exception in checkHardExclusions let it through (one side is an
	// explicit gift set) — that is NOT identity evidence, so this must
	// neither count as a positive signal nor be silently treated as
	// "missing"; it is tracked explicitly so it can never read as a match.
	missing.push('gtin_conflict_exempted_by_bundle_exception')
}

function compareVolume(a: NormalizedListingAttributes, b: NormalizedListingAttributes, positive: MatchSignal[], missing: string[]): void {
	if (!a.volume || !b.volume) {
		missing.push('volume')
		return
	}
	if (a.volume.unit === b.volume.unit) {
		positive.push({ code: 'volume_match', detail: `${a.volume.value}${a.volume.unit}` })
	} else {
		missing.push('volume')
	}
}

function compareConcentration(a: NormalizedListingAttributes, b: NormalizedListingAttributes, positive: MatchSignal[], missing: string[]): void {
	if (!a.concentration || !b.concentration) {
		missing.push('concentration')
		return
	}
	positive.push({ code: 'concentration_match', detail: a.concentration })
}

function compareVariant(a: NormalizedListingAttributes, b: NormalizedListingAttributes, positive: MatchSignal[], missing: string[]): void {
	if (!a.variantCode || !b.variantCode) {
		missing.push('variant')
		return
	}
	positive.push({ code: 'variant_match', detail: a.variantCode })
}

/**
 * Scores one candidate pair. Hard exclusions are checked first; if any
 * fires, the result is an immediate `reject` with the conflicting signal
 * recorded, and no further scoring is computed.
 *
 * Decision rule: `auto_match` requires BOTH a score above
 * `autoMatchThreshold` AND "strong identity evidence" (a validated GTIN
 * match, or brand+volume match with a strongly similar title) — the score
 * threshold alone is not sufficient, so several weak signals summing past
 * the threshold cannot trigger an automatic match on their own.
 */
export function scoreCandidatePair(
	a: NormalizedListingAttributes,
	b: NormalizedListingAttributes,
	options: MatchingOptions
): Omit<MatchResult, 'sourceListingId' | 'candidateListingId'> {
	const exclusion = checkHardExclusions(a, b)
	const titleSim = titleSimilarity(a.title, b.title)

	const comparedAttributes: ComparedAttributes = {
		brandA: a.brand,
		brandB: b.brand,
		titleA: a.title,
		titleB: b.title,
		titleSimilarity: Number(titleSim.toFixed(4)),
		volumeA: a.volume,
		volumeB: b.volume,
		concentrationA: a.concentration,
		concentrationB: b.concentration,
		variantCodeA: a.variantCode,
		variantCodeB: b.variantCode,
		formatA: a.format,
		formatB: b.format,
		gtinA: a.gtin,
		gtinB: b.gtin
	}

	if (exclusion.excluded && exclusion.reason) {
		return {
			score: 0,
			decision: 'reject',
			positiveSignals: [],
			conflictingSignals: [exclusion.reason],
			missingAttributes: [],
			comparedAttributes
		}
	}

	const positiveSignals: MatchSignal[] = []
	const missingAttributes: string[] = []

	compareGtin(a, b, positiveSignals, missingAttributes)
	compareBrand(a, b, positiveSignals, missingAttributes)
	compareVolume(a, b, positiveSignals, missingAttributes)
	compareConcentration(a, b, positiveSignals, missingAttributes)
	compareVariant(a, b, positiveSignals, missingAttributes)

	if (titleSim > 0) {
		positiveSignals.push({ code: 'title_similarity', detail: titleSim.toFixed(4) })
	} else {
		missingAttributes.push('title')
	}

	let score = 0
	const codes = new Set(positiveSignals.map((s) => s.code))
	if (codes.has('gtin_exact_match')) score += WEIGHTS.gtinExactMatch
	if (codes.has('brand_match')) score += WEIGHTS.brandExactMatch
	else if (codes.has('brand_similar')) score += WEIGHTS.brandSimilar
	if (codes.has('volume_match')) score += WEIGHTS.volumeMatch
	if (codes.has('concentration_match')) score += WEIGHTS.concentrationMatch
	if (codes.has('variant_match')) score += WEIGHTS.variantMatch
	score += WEIGHTS.titleSimilarityMax * titleSim
	score = Math.min(1, score)

	const hasStrongIdentityEvidence =
		codes.has('gtin_exact_match') ||
		(codes.has('brand_match') && codes.has('volume_match') && titleSim >= options.strongTitleSimilarityThreshold)

	let decision: MatchDecision
	if (score >= options.autoMatchThreshold && hasStrongIdentityEvidence) {
		decision = 'auto_match'
	} else if (score >= options.reviewThreshold) {
		decision = 'needs_review'
	} else {
		decision = 'reject'
	}

	return {
		score: Number(score.toFixed(4)),
		decision,
		positiveSignals,
		conflictingSignals: [],
		missingAttributes,
		comparedAttributes
	}
}
