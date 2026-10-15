import { diceBigramSimilarity } from './normalize'
import type { NormalizedListingAttributes } from './attributes'
import type { MatchSignal } from './types'

export interface ExclusionResult {
	excluded: boolean
	reason?: MatchSignal
}

const VOLUME_TOLERANCE_RATIO = 0.02 // allow ~2% rounding noise (e.g. 99.5ml vs 100ml from unit conversion)

/** Different explicit volume/weight (same dimension) is a hard exclusion. Different dimensions (ml vs g) are never compared. */
function volumeConflict(a: NormalizedListingAttributes, b: NormalizedListingAttributes): ExclusionResult {
	if (!a.volume || !b.volume) return { excluded: false }
	if (a.volume.unit !== b.volume.unit) return { excluded: false } // not comparable, not a conflict
	const diff = Math.abs(a.volume.value - b.volume.value)
	const tolerance = Math.max(a.volume.value, b.volume.value) * VOLUME_TOLERANCE_RATIO
	if (diff > tolerance) {
		return {
			excluded: true,
			reason: { code: 'volume_conflict', detail: `${a.volume.value}${a.volume.unit} vs ${b.volume.value}${b.volume.unit}` }
		}
	}
	return { excluded: false }
}

/** Different perfume concentration (EDT vs EDP vs EDC vs Parfum) is a hard exclusion. */
function concentrationConflict(a: NormalizedListingAttributes, b: NormalizedListingAttributes): ExclusionResult {
	if (!a.concentration || !b.concentration) return { excluded: false }
	if (a.concentration !== b.concentration) {
		return { excluded: true, reason: { code: 'concentration_conflict', detail: `${a.concentration} vs ${b.concentration}` } }
	}
	return { excluded: false }
}

/** Different explicit shade/variant code (e.g. shade 01 vs shade 02) is a hard exclusion. */
function variantConflict(a: NormalizedListingAttributes, b: NormalizedListingAttributes): ExclusionResult {
	if (!a.variantCode || !b.variantCode) return { excluded: false }
	if (a.variantCode !== b.variantCode) {
		return { excluded: true, reason: { code: 'variant_conflict', detail: `${a.variantCode} vs ${b.variantCode}` } }
	}
	return { excluded: false }
}

/** Different explicit product format (refill vs. set vs. implicit standard bottle) is a hard exclusion. */
function formatConflict(a: NormalizedListingAttributes, b: NormalizedListingAttributes): ExclusionResult {
	if (!a.format || !b.format) return { excluded: false }
	if (a.format !== b.format) {
		return { excluded: true, reason: { code: 'format_conflict', detail: `${a.format} vs ${b.format}` } }
	}
	return { excluded: false }
}

const BRAND_CONFLICT_SIMILARITY_THRESHOLD = 0.5

/**
 * Clearly different known brands is a hard exclusion. A low-but-nonzero
 * similarity (likely the same brand, differently spelled) is NOT excluded
 * here — that uncertainty is left to scoring.
 *
 * Exception: when both sides carry the SAME validated GTIN, that identity
 * evidence is stronger than a text-level brand mismatch (which is more
 * often inconsistent manufacturer/distributor naming between two
 * independent store catalogs than an actual product difference), so the
 * brand conflict is not applied in that case.
 */
function brandConflict(a: NormalizedListingAttributes, b: NormalizedListingAttributes): ExclusionResult {
	if (a.gtin && b.gtin && a.gtin === b.gtin) return { excluded: false }
	if (!a.brand || !b.brand) return { excluded: false }
	if (a.brand === b.brand) return { excluded: false }
	const similarity = diceBigramSimilarity(a.brand, b.brand)
	if (similarity < BRAND_CONFLICT_SIMILARITY_THRESHOLD) {
		return { excluded: true, reason: { code: 'brand_conflict', detail: `${a.brand} vs ${b.brand}` } }
	}
	return { excluded: false }
}

/**
 * Conflicting valid GTINs are a hard exclusion, EXCEPT when one side is
 * explicitly a bundle/set and the other is not — a gift set commonly has
 * its own GTIN distinct from its component product's GTIN by design, so
 * that mismatch alone must not be read as "different products". This is
 * the one documented bundle/packaging exception; it does not attempt to
 * detect any other packaging variation.
 */
function gtinConflict(a: NormalizedListingAttributes, b: NormalizedListingAttributes): ExclusionResult {
	if (!a.gtin || !b.gtin) return { excluded: false }
	if (a.gtin === b.gtin) return { excluded: false }

	const oneIsBundle = (a.format === 'set') !== (b.format === 'set')
	if (oneIsBundle) return { excluded: false }

	return { excluded: true, reason: { code: 'gtin_conflict', detail: `${a.gtin} vs ${b.gtin}` } }
}

const EXCLUSION_CHECKS = [volumeConflict, concentrationConflict, variantConflict, formatConflict, brandConflict, gtinConflict]

/**
 * Runs every hard-exclusion rule. Returns the first conflict found (rules
 * are independent and conservative: each only fires when BOTH sides have
 * the relevant attribute explicitly and reliably known — a missing
 * attribute on either side never triggers an exclusion).
 */
export function checkHardExclusions(a: NormalizedListingAttributes, b: NormalizedListingAttributes): ExclusionResult {
	for (const check of EXCLUSION_CHECKS) {
		const result = check(a, b)
		if (result.excluded) return result
	}
	return { excluded: false }
}
