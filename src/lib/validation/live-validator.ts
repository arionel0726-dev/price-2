import { discoverSitemapUrls } from '../discovery/sitemap'
import { dedupeLanguageVariants, matchVizajeNicaProductUrl } from '../discovery/pilot-patterns'
import { fetchRobotsRules, isPathAllowed, type RobotsPageFetch } from '../net/robots-fetch'
import { extractProductsFromHtml } from '../scraping/extract'
import type { ExtractionFailure, NormalizedProductRecord } from '../scraping/types'
import {
	emptyMissingFieldCounts,
	emptyOutcomeCounts,
	TRACKED_FIELDS,
	type ExtractedFieldsSummary,
	type PageOutcome,
	type PageResult,
	type TrackedField,
	type ValidateLiveReport
} from '../../scripts/validate-live-report-types'

export const MAX_PRODUCT_PAGES_PER_RUN = 20
const DEFAULT_SITEMAP_URL_LIMIT = 20_000 // bounds in-memory sitemap collection only; page fetches are separately capped at MAX_PRODUCT_PAGES_PER_RUN

export interface ValidateLiveCoreOptions {
	domain: string
	mode: 'fixture' | 'live'
	requestedSampleSize: number
	userAgent: string
	sitemapEntryUrl: string
	robotsUrl: string
	/** Fetches a URL and returns its status + body. Used uniformly for robots.txt, the sitemap, and product pages — fixture mode reads files, live mode wraps safeFetch + a DomainScheduler (see src/scripts/validate-live.ts). */
	fetchText: (url: string) => Promise<RobotsPageFetch>
	maxSitemapUrls?: number
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

	const robots = await fetchRobotsRules(options.robotsUrl, options.fetchText)

	if (!robots.ok) {
		return {
			generatedAt: new Date().toISOString(),
			domain: options.domain,
			mode: options.mode,
			requestedSampleSize: options.requestedSampleSize,
			effectiveSampleSize,
			robots: { status: 'fetch_failed', failedClosed: true, reason: robots.reason },
			discovery: { totalSitemapUrls: 0, matchedProductUrlCount: 0, afterLanguageDedupeCount: 0 },
			pages: { attempted: 0, fetchedSuccessfully: 0, extracted: 0 },
			missingFieldCounts: emptyMissingFieldCounts(),
			outcomeCounts: emptyOutcomeCounts(),
			results: [],
			completeness: { averageFieldsPresentRatio: 0, fullyCompleteCount: 0 }
		}
	}

	const discovery = await discoverSitemapUrls([options.sitemapEntryUrl], {
		fetchSitemap: (url) => fetchSitemapAdapter(url, options.fetchText),
		maxUrls: options.maxSitemapUrls ?? DEFAULT_SITEMAP_URL_LIMIT
	})

	const matchedUrls = discovery.urls.map((u) => u.url).filter((url) => matchVizajeNicaProductUrl(url) !== null)
	const dedupedUrls = dedupeLanguageVariants(matchedUrls)
	// Deterministic sample order: Romanian URLs first (the pilot's preferred language), then the rest, each in discovery order.
	const sortedUrls = [...dedupedUrls].sort((a, b) => {
		const langA = matchVizajeNicaProductUrl(a)?.language ?? 'zz'
		const langB = matchVizajeNicaProductUrl(b)?.language ?? 'zz'
		return langA === langB ? 0 : langA === 'ro' ? -1 : langB === 'ro' ? 1 : 0
	})
	const sample = sortedUrls.slice(0, effectiveSampleSize)

	const results: PageResult[] = []
	let attempted = 0
	let fetchedSuccessfully = 0
	let extractedCount = 0

	for (const url of sample) {
		const match = matchVizajeNicaProductUrl(url)
		const language = match?.language ?? 'other'
		const pathname = new URL(url).pathname

		if (!isPathAllowed(robots, pathname, options.userAgent)) {
			results.push({
				url,
				language,
				outcome: 'robots_disallowed',
				httpStatus: null,
				errorMessage: 'Disallowed by robots.txt for this user-agent',
				extracted: null,
				missingFields: []
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
				outcome: 'network_failure',
				httpStatus: null,
				errorMessage: cause instanceof Error ? cause.message : String(cause),
				extracted: null,
				missingFields: []
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
				missingFields: []
			})
			continue
		}

		fetchedSuccessfully++

		const extraction = extractProductsFromHtml(url, httpResult.body)
		if (extraction.products.length > 0) {
			extractedCount++
			const summary = buildExtractedSummary(extraction.products[0])
			results.push({
				url,
				language,
				outcome: 'extracted',
				httpStatus: httpResult.status,
				errorMessage: null,
				extracted: summary,
				missingFields: computeMissingFields(summary)
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
				missingFields: []
			})
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
			afterLanguageDedupeCount: dedupedUrls.length
		},
		pages: { attempted, fetchedSuccessfully, extracted: extractedCount },
		missingFieldCounts,
		outcomeCounts,
		results,
		completeness: {
			averageFieldsPresentRatio: extractedCount === 0 ? 0 : Number((totalPresentRatio / extractedCount).toFixed(4)),
			fullyCompleteCount
		}
	}
}
