import type { SitemapDiagnostic } from '../lib/discovery/types'
import type { FieldConflict, FieldSource } from '../lib/scraping/types'

export type PageOutcome =
	| 'extracted'
	| 'network_failure'
	| 'robots_disallowed'
	| 'non_product_page'
	| 'missing_json_ld'
	| 'invalid_json_ld'
	/** The response (or a redirect hop leading to it) touched a host outside the live-validation allowlist — see src/lib/net/allowlist.ts. A specific, more actionable case of "network/access failure". */
	| 'redirect_disallowed'
	/**
	 * The response was detected as an access-restriction/bot-challenge page
	 * (e.g. a confirmed AWS WAF JavaScript challenge — see
	 * src/lib/diagnostics/html-snapshot.ts) rather than real page content.
	 * Deliberately distinct from 'missing_json_ld': a challenge page is not
	 * "a product page we failed to extract", it is "not the page we asked
	 * for" — see Task 6.2. Extraction is never attempted on such a response.
	 */
	| 'access_restricted'

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

/**
 * One selected candidate URL and *why* the store profile classified it as
 * a product candidate — reported for exactly the URLs that were (or were
 * about to be) fetched, never for the full discovered set. This is a
 * candidate-classification diagnostic only: it says nothing about whether
 * the page actually turned out to be a product (see `PageResult.outcome`
 * for that) — the distinction between "unverified candidate" and
 * "confirmed product page" must never be collapsed.
 */
export interface CandidateUrlDiagnostic {
	url: string
	/** Whether the owning store profile's classifier pattern has been confirmed against real data (see src/lib/discovery/stores/types.ts). */
	patternConfidence: 'verified' | 'unverified'
	/** Human-readable explanation of which pattern/heuristic matched this URL. */
	reason: string
}

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
		/**
		 * Three-way discovery outcome (Task 6.1 §5 — never collapsed to a
		 * binary ok/failed):
		 *   - 'ok': every visited sitemap file was fetched and parsed
		 *     successfully, and no bound (maxUrls/maxSitemaps/maxDepth) was hit.
		 *   - 'partial': at least one sitemap URL WAS discovered, but at least
		 *     one sitemap file failed (fetch/parse) or a bound was reached —
		 *     the picture is real but incomplete. See `sitemapsFailed` and
		 *     `truncated` for specifics.
		 *   - 'discovery_failed': the sitemap could not be fetched or parsed
		 *     into any recognizable form and zero URLs were discovered as a
		 *     result — never silently reported as "the store simply has no
		 *     products".
		 */
		status: 'ok' | 'partial' | 'discovery_failed'
		/** Per-sitemap-file issues (fetch failures, malformed XML, an unrecognized root element, depth/url limits) — see src/lib/discovery/types.ts. */
		sitemapDiagnostics: SitemapDiagnostic[]
		/** Total number of individual sitemap files (including nested ones) actually fetched in this run. */
		sitemapsAttempted: number
		/** Count of sitemap files that failed to fetch or parse (fetch_failed/malformed_xml/unrecognized_format) — a subset of sitemapDiagnostics, excluding mere bound-reached bookkeeping entries. */
		sitemapsFailed: number
		/** True when a bound (maxUrls, maxSitemaps, or maxDepth) was reached and discovery stopped before it would otherwise have finished — i.e. more sitemap URLs may exist beyond what was collected. */
		truncated: boolean
	}
	pages: {
		attempted: number
		fetchedSuccessfully: number
		extracted: number
	}
	missingFieldCounts: Record<TrackedField, number>
	outcomeCounts: Record<PageOutcome, number>
	results: PageResult[]
	/** The selected candidate URLs and why each was classified as one — see CandidateUrlDiagnostic. Always exactly the URLs in `results` (same order), never the full discovered set. */
	candidateDiagnostics: CandidateUrlDiagnostic[]
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
		invalid_json_ld: 0,
		redirect_disallowed: 0,
		access_restricted: 0
	}
}
