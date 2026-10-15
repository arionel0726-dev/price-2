import type { FieldConflict, FieldSource } from '../lib/scraping/types'

export type PageOutcome =
	| 'extracted'
	| 'network_failure'
	| 'robots_disallowed'
	| 'non_product_page'
	| 'missing_json_ld'
	| 'invalid_json_ld'

export interface ExtractedFieldsSummary {
	title: string | null
	brand: string | null
	sku: string | null
	gtin: string | null
	variant: string | null
	price: number | null
	currency: string | null
	availability: string | null
}

/** Fields considered part of "completeness" bookkeeping. Kept in one place so the report and tests agree on the set. */
export const TRACKED_FIELDS = ['title', 'brand', 'sku', 'gtin', 'variant', 'price', 'currency', 'availability'] as const
export type TrackedField = (typeof TRACKED_FIELDS)[number]

export interface PageResult {
	url: string
	language: 'ro' | 'ru' | 'other'
	outcome: PageOutcome
	httpStatus: number | null
	errorMessage: string | null
	extracted: ExtractedFieldsSummary | null
	/** Tracked fields that were absent/null for this page. Empty when `outcome` is not 'extracted'. */
	missingFields: TrackedField[]
	/**
	 * Where each present field's value came from (json_ld / html_attribute /
	 * title / missing) — see src/lib/scraping/extract.ts. Optional/additive:
	 * only populated when `outcome` is 'extracted'; existing report
	 * consumers that don't read it are unaffected.
	 */
	fieldProvenance?: Partial<Record<TrackedField, FieldSource>>
	/** JSON-LD vs. HTML-fallback disagreements for this page, if any (never silently resolved — see extract.ts). Empty when there were none. */
	conflicts: FieldConflict[]
}

export interface ValidateLiveReport {
	generatedAt: string
	domain: string
	mode: 'fixture' | 'live'
	requestedSampleSize: number
	/** `requestedSampleSize` clamped to the hard cap of 20 — always <= 20. */
	effectiveSampleSize: number
	robots: {
		status: 'fetched' | 'fetch_failed' | 'skipped_fixture_mode'
		failedClosed: boolean
		reason: string | null
	}
	discovery: {
		totalSitemapUrls: number
		matchedProductUrlCount: number
		afterLanguageDedupeCount: number
	}
	pages: {
		attempted: number
		fetchedSuccessfully: number
		extracted: number
	}
	missingFieldCounts: Record<TrackedField, number>
	outcomeCounts: Record<PageOutcome, number>
	results: PageResult[]
	completeness: {
		/** Average fraction of tracked fields present, across pages with outcome 'extracted' only. 0 when none were extracted. */
		averageFieldsPresentRatio: number
		/** Count of extracted pages with zero missing tracked fields. */
		fullyCompleteCount: number
	}
}

export function emptyMissingFieldCounts(): Record<TrackedField, number> {
	return { title: 0, brand: 0, sku: 0, gtin: 0, variant: 0, price: 0, currency: 0, availability: 0 }
}

export function emptyOutcomeCounts(): Record<PageOutcome, number> {
	return {
		extracted: 0,
		network_failure: 0,
		robots_disallowed: 0,
		non_product_page: 0,
		missing_json_ld: 0,
		invalid_json_ld: 0
	}
}
