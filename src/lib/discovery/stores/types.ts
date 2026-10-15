/**
 * A per-store "discovery profile": the site-specific knowledge needed to
 * turn a raw sitemap URL list into a bounded, deduplicated set of product
 * page candidates for one pilot store. This is the seam AGENTS.md calls
 * for ("site-specific extraction logic belongs in adapters") applied to
 * discovery — `src/lib/validation/live-validator.ts` and
 * `src/scripts/validate-live.ts` depend only on this interface, never on
 * a specific store's URL shape.
 *
 * Matching a store's `classifyProductUrl` only ever produces a
 * *candidate* — JSON-LD extraction (`src/lib/scraping/extract.ts`)
 * remains the sole authority on whether a page is actually a product.
 */

export interface StoreUrlMatch {
	/** Stable key used for deduplication — two URLs with the same key are treated as the same product. */
	dedupeKey: string
	/** Optional language tag, when the store's URL structure encodes one (e.g. vizaje-nica.com's /ro//ru/ prefix). */
	language?: string
}

export interface StoreProfile {
	/** Hostname this profile applies to (exact match — see src/lib/net/allowlist.ts). */
	domain: string
	/** Default sitemap entry point to try, absent an explicit --sitemap-url override. */
	defaultSitemapUrl: string
	/**
	 * Whether `classifyProductUrl`'s pattern has been confirmed against a
	 * real, human-reviewed sitemap/page sample from this store (`verified`),
	 * or is a conservative best-effort guess pending that confirmation
	 * (`unverified`). Surfaced in diagnostics so an unverified classifier's
	 * output is never mistaken for a confirmed finding.
	 */
	patternConfidence: 'verified' | 'unverified'
	/** Matches a discovered URL against this store's product-page pattern. Returns null for anything else. */
	classifyProductUrl: (url: string) => StoreUrlMatch | null
	/** Deduplicates an already-filtered list of candidate product URLs (see individual profiles for their strategy). */
	dedupeProductUrls: (urls: string[]) => string[]
	/** Orders the deduplicated candidates before sampling (e.g. a preferred language first). Defaults to input order when omitted. */
	sortCandidates?: (urls: string[]) => string[]
}
