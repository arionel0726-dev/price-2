import { classifyHtmlSnapshot } from '../diagnostics/html-snapshot'
import { discoverSitemapUrls } from '../discovery/sitemap'
import type { SitemapDiagnostic } from '../discovery/types'
import { vizajeNicaStoreProfile } from '../discovery/stores/vizaje-nica'
import type { StoreProfile } from '../discovery/stores/types'
import { DisallowedRedirectError } from '../net/allowlist'
import type { RobotsRules } from '../net/robots'
import { fetchRobotsRules, isPathAllowed, type RobotsPageFetch } from '../net/robots-fetch'
import { extractProductsFromHtml } from '../scraping/extract'
import type { ExtractionFailure, NormalizedProductRecord } from '../scraping/types'
import {
	emptyMissingFieldCounts,
	emptyOutcomeCounts,
	TRACKED_FIELDS,
	type CandidateUrlDiagnostic,
	type ExtractedFieldsSummary,
	type PageOutcome,
	type PageResult,
	type TrackedField,
	type ValidateLiveReport
} from '../../scripts/validate-live-report-types'

export const MAX_PRODUCT_PAGES_PER_RUN = 20
const DEFAULT_SITEMAP_URL_LIMIT = 20_000 // bounds in-memory sitemap collection only; page fetches are separately capped at MAX_PRODUCT_PAGES_PER_RUN

// Diagnostics that represent an actual per-sitemap-file failure (as opposed
// to a deliberate bound being reached) — used to count "sitemaps failed"
// distinctly from "sitemaps truncated by a limit".
const SITEMAP_FAILURE_ISSUES = new Set<SitemapDiagnostic['issue']>(['fetch_failed', 'malformed_xml', 'unrecognized_format'])

export interface ValidateLiveCoreOptions {
	domain: string
	mode: 'fixture' | 'live'
	requestedSampleSize: number
	userAgent: string
	sitemapEntryUrl: string
	robotsUrl: string
	/** Fetches a URL and returns its status + body. Used uniformly for robots.txt and product pages — fixture mode reads files, live mode wraps safeFetch + a DomainScheduler (see src/scripts/validate-live.ts). */
	fetchText: (url: string) => Promise<RobotsPageFetch>
	/**
	 * Optional separate fetcher for sitemap XML specifically. Defaults to
	 * `fetchText` when omitted (fixture mode, and any caller that has not
	 * opted into a distinct sitemap budget). Live mode supplies one with a
	 * larger (but still bounded) response-size/decompression budget than
	 * ordinary HTML pages, since real-world sitemap XML can legitimately be
	 * much larger than a single product page — see
	 * src/scripts/validate-live.ts and Task 6.1 §2.
	 */
	fetchSitemapText?: (url: string) => Promise<RobotsPageFetch>
	maxSitemapUrls?: number
	/**
	 * Called once, immediately after robots.txt is successfully fetched and
	 * parsed, with the parsed rules — before any further request (sitemap or
	 * product page) is made. Live mode uses this to read `Crawl-delay` (see
	 * src/lib/net/robots.ts's `getCrawlDelaySeconds`) and raise its request
	 * pacing accordingly (Task 7 §9) — this function itself never decides
	 * pacing, keeping that entirely the caller's responsibility.
	 */
	onRobotsLoaded?: (rules: RobotsRules) => void
	/**
	 * The store-specific discovery profile (URL classification + dedup —
	 * see src/lib/discovery/stores/). Defaults to vizaje-nica.com's
	 * profile when omitted, which preserves this function's original
	 * behavior for existing callers/tests.
	 */
	storeProfile?: StoreProfile
}

function clampSampleSize(requested: number): number {
	if (!Number.isFinite(requested) || requested < 1) return 1
	return Math.min(requested, MAX_PRODUCT_PAGES_PER_RUN)
}

function mapFailureReasonToOutcome(reason: ExtractionFailure['reason'] | undefined): PageOutcome {
	switch (reason) {
		case 'no_product_type_found':
			return 'non_product_page'
		case 'malformed_json_ld':
		case 'schema_validation_failed':
			return 'invalid_json_ld'
		case 'no_structured_data_found':
		default:
			return 'missing_json_ld'
	}
}

function buildExtractedSummary(product: NormalizedProductRecord): ExtractedFieldsSummary {
	return {
		title: product.title.normalized,
		brand: product.brand.normalized,
		sku: product.sku,
		gtin: product.gtin,
		variant: product.variant.normalized,
		price: product.price.amount,
		currency: product.price.currency,
		availability: product.availability.normalized
	}
}

function computeMissingFields(summary: ExtractedFieldsSummary): TrackedField[] {
	return TRACKED_FIELDS.filter((field) => summary[field] === null)
}

async function fetchSitemapAdapter(url: string, fetchText: ValidateLiveCoreOptions['fetchText']): Promise<string> {
	const response = await fetchText(url)
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Sitemap fetch returned HTTP ${response.status} for ${url}`)
	}
	return response.body
}

/**
 * Core validation pipeline, shared between fixture mode (fully offline,
 * `fetchText` reads local files) and live mode (`fetchText` wraps
 * `safeFetch` behind a single-concurrency, rate-limited scheduler — see
 * `src/scripts/validate-live.ts`). This function itself never decides
 * whether a domain is allowlisted or opens a real socket; that is the
 * caller's responsibility, keeping this pipeline fully testable offline.
 */
export async function validateLiveDomain(options: ValidateLiveCoreOptions): Promise<ValidateLiveReport> {
	const effectiveSampleSize = clampSampleSize(options.requestedSampleSize)
	const storeProfile = options.storeProfile ?? vizajeNicaStoreProfile

	const robots = await fetchRobotsRules(options.robotsUrl, options.fetchText)

	if (!robots.ok) {
		return {
			generatedAt: new Date().toISOString(),
			domain: options.domain,
			mode: options.mode,
			requestedSampleSize: options.requestedSampleSize,
			effectiveSampleSize,
			robots: { status: 'fetch_failed', failedClosed: true, reason: robots.reason },
			discovery: {
				totalSitemapUrls: 0,
				matchedProductUrlCount: 0,
				afterLanguageDedupeCount: 0,
				status: 'ok',
				sitemapDiagnostics: [],
				sitemapsAttempted: 0,
				sitemapsFailed: 0,
				truncated: false
			},
			pages: { attempted: 0, fetchedSuccessfully: 0, extracted: 0 },
			missingFieldCounts: emptyMissingFieldCounts(),
			outcomeCounts: emptyOutcomeCounts(),
			results: [],
			candidateDiagnostics: [],
			completeness: { averageFieldsPresentRatio: 0, fullyCompleteCount: 0 }
		}
	}

	options.onRobotsLoaded?.(robots.rules)

	const discovery = await discoverSitemapUrls([options.sitemapEntryUrl], {
		fetchSitemap: (url) => fetchSitemapAdapter(url, options.fetchSitemapText ?? options.fetchText),
		maxUrls: options.maxSitemapUrls ?? DEFAULT_SITEMAP_URL_LIMIT
	})

	const sitemapFailureCount = discovery.diagnostics.filter((d) => SITEMAP_FAILURE_ISSUES.has(d.issue)).length

	// Distinguishes three states rather than a binary ok/failed (Task 6.1 §5):
	//   - 'discovery_failed': nothing was discovered AND something went wrong —
	//     never silently reported as "the store simply has no products".
	//   - 'partial': some URLs WERE discovered, but at least one sitemap file
	//     failed to fetch/parse, or a bound (maxUrls/maxSitemaps/maxDepth) was
	//     reached — i.e. the picture is real but incomplete. Never collapsed
	//     into 'ok', per Task 6.1's explicit "do not report discovery.status =
	//     ok when important sitemap files failed".
	//   - 'ok': every visited sitemap file was fetched and parsed successfully
	//     and no bound was hit.
	const discoveryStatus: 'ok' | 'partial' | 'discovery_failed' =
		discovery.urls.length === 0 && discovery.diagnostics.length > 0
			? 'discovery_failed'
			: discovery.diagnostics.length > 0
				? 'partial'
				: 'ok'

	const matchedUrls = discovery.urls.map((u) => u.url).filter((url) => storeProfile.classifyProductUrl(url) !== null)
	const dedupedUrls = storeProfile.dedupeProductUrls(matchedUrls)
	const sortedUrls = storeProfile.sortCandidates ? storeProfile.sortCandidates(dedupedUrls) : dedupedUrls
	const sample = sortedUrls.slice(0, effectiveSampleSize)

	// Reports exactly the URLs about to be fetched, and *why* each one was
	// classified as a candidate — never conflated with "confirmed product
	// page" (that is only ever decided by extraction succeeding below). See
	// Task 6.1 §1: "Add a safe diagnostic that reports the selected
	// candidate URLs and the classification reason."
	const candidateDiagnostics: CandidateUrlDiagnostic[] = sample.map((url) => {
		const match = storeProfile.classifyProductUrl(url)
		return {
			url,
			patternConfidence: storeProfile.patternConfidence,
			reason: match?.reason ?? 'matched the store profile classifier (no reason text provided)'
		}
	})

	const results: PageResult[] = []
	let attempted = 0
	let fetchedSuccessfully = 0
	let extractedCount = 0

	for (const url of sample) {
		const match = storeProfile.classifyProductUrl(url)
		const language = match?.language === 'ro' || match?.language === 'ru' ? match.language : 'other'
		const pathname = new URL(url).pathname

		if (!isPathAllowed(robots, pathname, options.userAgent)) {
			results.push({
				url,
				language,
				outcome: 'robots_disallowed',
				httpStatus: null,
				errorMessage: 'Disallowed by robots.txt for this user-agent',
				extracted: null,
				missingFields: [],
				conflicts: []
			})
			continue
		}

		attempted++

		let httpResult: RobotsPageFetch
		try {
			httpResult = await options.fetchText(url)
		} catch (cause) {
			results.push({
				url,
				language,
				outcome: cause instanceof DisallowedRedirectError ? 'redirect_disallowed' : 'network_failure',
				httpStatus: null,
				errorMessage: cause instanceof Error ? cause.message : String(cause),
				extracted: null,
				missingFields: [],
				conflicts: []
			})
			continue
		}

		if (httpResult.status < 200 || httpResult.status >= 300) {
			results.push({
				url,
				language,
				outcome: 'network_failure',
				httpStatus: httpResult.status,
				errorMessage: `HTTP ${httpResult.status}`,
				extracted: null,
				missingFields: [],
				conflicts: []
			})
			continue
		}

		fetchedSuccessfully++

		// Detect an access-restriction/bot-challenge response (e.g. a
		// confirmed AWS WAF JavaScript challenge — see
		// src/lib/diagnostics/html-snapshot.ts) BEFORE attempting extraction,
		// so it is never miscounted as a genuine 'missing_json_ld' extraction
		// failure and its content is never stored as product data (Task 6.2
		// §3-5). A challenge page legitimately has no JSON-LD, but the right
		// diagnosis is "we didn't get the real page", not "the real page has
		// no structured data".
		const snapshot = classifyHtmlSnapshot(httpResult.body)
		if (snapshot.looksLikeChallengePage) {
			results.push({
				url,
				language,
				outcome: 'access_restricted',
				httpStatus: httpResult.status,
				// Includes WHICH signal(s) actually matched (see
				// classifyHtmlSnapshot's `notes`) rather than a generic
				// boilerplate message — on a real run this is the only record
				// of why a page was judged access-restricted, since the raw
				// HTML itself is never persisted (Task 7.1 §1: distinguishing
				// "the classifier is wrong" from "the response really was
				// restricted" requires knowing which marker fired).
				errorMessage: `Classified as access-restricted, not product content: ${snapshot.notes.join('; ')}`,
				extracted: null,
				missingFields: [],
				conflicts: []
			})
			continue
		}

		const extraction = extractProductsFromHtml(url, httpResult.body)
		if (extraction.products.length > 0) {
			extractedCount++
			const product = extraction.products[0]
			const summary = buildExtractedSummary(product)
			results.push({
				url,
				language,
				outcome: 'extracted',
				httpStatus: httpResult.status,
				errorMessage: null,
				extracted: summary,
				missingFields: computeMissingFields(summary),
				fieldProvenance: product.fieldProvenance,
				conflicts: product.conflicts ?? []
			})
		} else {
			// Store-specific fallback for a page with NO JSON-LD Product node
			// at all (e.g. ovico.md's Magento templates — see Task 7.1 and
			// src/lib/scraping/adapters/ovico.ts). Only consulted once the
			// generic pipeline has already found nothing; it never overrides
			// or competes with a JSON-LD-derived record.
			const htmlOnly = storeProfile.htmlOnlyExtract?.(url, httpResult.body) ?? null

			if (htmlOnly?.kind === 'product' && htmlOnly.record) {
				extractedCount++
				const summary = buildExtractedSummary(htmlOnly.record)
				results.push({
					url,
					language,
					outcome: 'extracted',
					httpStatus: httpResult.status,
					errorMessage: null,
					extracted: summary,
					missingFields: computeMissingFields(summary),
					fieldProvenance: htmlOnly.record.fieldProvenance,
					conflicts: htmlOnly.record.conflicts ?? []
				})
			} else if (htmlOnly?.kind === 'non_product') {
				results.push({
					url,
					language,
					outcome: 'non_product_page',
					httpStatus: httpResult.status,
					errorMessage: 'Site-specific structural markers (Magento category/listing grid) identify this as a non-product page.',
					extracted: null,
					missingFields: [],
					conflicts: []
				})
			} else {
				const failure = extraction.failures[0]
				results.push({
					url,
					language,
					outcome: mapFailureReasonToOutcome(failure?.reason),
					httpStatus: httpResult.status,
					errorMessage: failure?.message ?? 'No product extracted and no failure reported',
					extracted: null,
					missingFields: [],
					conflicts: []
				})
			}
		}
	}

	const missingFieldCounts = emptyMissingFieldCounts()
	const outcomeCounts = emptyOutcomeCounts()
	let totalPresentRatio = 0
	let fullyCompleteCount = 0

	for (const result of results) {
		outcomeCounts[result.outcome]++
		if (result.outcome === 'extracted') {
			for (const field of result.missingFields) missingFieldCounts[field]++
			const presentRatio = (TRACKED_FIELDS.length - result.missingFields.length) / TRACKED_FIELDS.length
			totalPresentRatio += presentRatio
			if (result.missingFields.length === 0) fullyCompleteCount++
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		domain: options.domain,
		mode: options.mode,
		requestedSampleSize: options.requestedSampleSize,
		effectiveSampleSize,
		robots: { status: 'fetched', failedClosed: false, reason: null },
		discovery: {
			totalSitemapUrls: discovery.urls.length,
			matchedProductUrlCount: matchedUrls.length,
			afterLanguageDedupeCount: dedupedUrls.length,
			status: discoveryStatus,
			sitemapDiagnostics: discovery.diagnostics,
			sitemapsAttempted: discovery.sitemapsVisited.length,
			sitemapsFailed: sitemapFailureCount,
			truncated: discovery.truncated
		},
		pages: { attempted, fetchedSuccessfully, extracted: extractedCount },
		missingFieldCounts,
		outcomeCounts,
		results,
		candidateDiagnostics,
		completeness: {
			averageFieldsPresentRatio: extractedCount === 0 ? 0 : Number((totalPresentRatio / extractedCount).toFixed(4)),
			fullyCompleteCount
		}
	}
}
