export interface SitemapDiagnostic {
	sitemapUrl: string
	issue: 'fetch_failed' | 'malformed_xml' | 'unrecognized_format' | 'depth_limit_reached' | 'url_limit_reached'
	message: string
}

export type ProductCandidateConfidence = 'likely' | 'unknown'

export interface DiscoveredUrl {
	url: string
	/**
	 * Whether this URL looks like a product detail page, based on simple
	 * path heuristics. `unknown` means we could not confidently classify it
	 * either way — it is NOT assumed to be a non-product, it is still
	 * returned as a candidate for extraction, which is the ultimate source
	 * of truth for "is this actually a product".
	 */
	candidateConfidence: ProductCandidateConfidence
	foundInSitemap: string
}

export interface SitemapDiscoveryResult {
	urls: DiscoveredUrl[]
	sitemapsVisited: string[]
	diagnostics: SitemapDiagnostic[]
	truncated: boolean
}

export interface SitemapDiscoveryLimits {
	/** Maximum nesting depth of sitemap indexes to follow. A plain sitemap is depth 0. */
	maxDepth?: number
	/** Maximum number of individual sitemap files to fetch across the whole run. */
	maxSitemaps?: number
	/** Maximum number of distinct URLs to collect before stopping. */
	maxUrls?: number
}

/** Fetches a sitemap (or any text resource) by absolute URL and returns its raw text content. */
export type SitemapFetcher = (url: string) => Promise<string>
