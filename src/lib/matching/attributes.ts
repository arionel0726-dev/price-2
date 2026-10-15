import {
	normalizeBrandForMatching,
	normalizeTitleForMatching,
	parseConcentration,
	parseFormat,
	parseVariantCode,
	parseVolume,
	tokenize,
	validateGtin
} from './normalize'
import type { MatchableListing, ParsedVolume } from './types'

export interface NormalizedListingAttributes {
	listingId: string
	storeId: string
	brand: string | null
	title: string | null
	titleTokens: string[]
	volume: ParsedVolume | null
	concentration: string | null
	variantCode: string | null
	format: 'refill' | 'set' | null
	/** Validated GTIN only — an unvalidated/malformed code is treated the same as absent. */
	gtin: string | null
	sku: string | null
}

/**
 * Precomputes every matching-relevant attribute for a listing once, so
 * candidate generation and scoring don't repeat the same parsing per pair.
 *
 * Volume/concentration/variant-code/format are looked for in BOTH the
 * title and the explicit variant field (Task 1 extraction puts size like
 * "50ml" in `variant`, but some sites only ever state it inline in the
 * title) — whichever field actually contains the marker.
 */
export function computeNormalizedAttributes(listing: MatchableListing): NormalizedListingAttributes {
	const title = normalizeTitleForMatching(listing.normalizedTitle ?? listing.sourceTitle)
	const brand = normalizeBrandForMatching(listing.brand)
	const normalizedVariant = normalizeTitleForMatching(listing.variant)
	const searchText = [title, normalizedVariant].filter((t): t is string => Boolean(t)).join(' ')

	return {
		listingId: listing.id,
		storeId: listing.storeId,
		brand,
		title,
		titleTokens: title ? tokenize(title) : [],
		volume: parseVolume(searchText || null),
		concentration: parseConcentration(searchText || null),
		variantCode: parseVariantCode(searchText || null),
		format: parseFormat(searchText || null),
		gtin: validateGtin(listing.gtin),
		sku: listing.sku
	}
}
