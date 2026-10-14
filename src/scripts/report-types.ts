import type { SitemapDiagnostic } from '../lib/discovery/types'
import type { ExtractionFailure, NormalizedProductRecord } from '../lib/scraping/types'

export interface DiscoveryReport {
	generatedAt: string
	mode: 'fixture' | 'live'
	discovery: {
		sitemapsVisited: string[]
		diagnostics: SitemapDiagnostic[]
		urls: { url: string; candidateConfidence: 'likely' | 'unknown'; foundInSitemap: string }[]
		truncated: boolean
	}
	extraction: {
		products: NormalizedProductRecord[]
		failures: ExtractionFailure[]
		/** URLs that discovery returned but for which no HTML could be obtained (fixture mode: no mapped fixture file). */
		skipped: { url: string; reason: string }[]
	}
	stats: {
		sitemapsVisitedCount: number
		discoveredUrlCount: number
		likelyProductUrlCount: number
		extractedProductCount: number
		extractionFailureCount: number
		skippedUrlCount: number
	}
}
