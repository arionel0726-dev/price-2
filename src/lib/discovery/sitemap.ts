import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { classifyProductCandidate } from './classify'
import type {
	DiscoveredUrl,
	SitemapDiagnostic,
	SitemapDiscoveryLimits,
	SitemapDiscoveryResult,
	SitemapFetcher
} from './types'

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_SITEMAPS = 50
const DEFAULT_MAX_URLS = 5000

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	trimValues: true
})

type ParsedSitemap =
	| { kind: 'urlset'; locs: string[] }
	| { kind: 'sitemapindex'; locs: string[] }
	| { kind: 'unrecognized' }

function toArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) return []
	return Array.isArray(value) ? value : [value]
}

/**
 * Parses sitemap XML text into a normalized shape. Throws only for
 * structurally invalid XML; an XML document that is well-formed but not a
 * recognized sitemap shape is returned as `{ kind: 'unrecognized' }` instead
 * of throwing, so callers can report a diagnostic without losing the rest
 * of a multi-sitemap run.
 */
export function parseSitemapXml(xml: string): ParsedSitemap {
	const validation = XMLValidator.validate(xml)
	if (validation !== true) {
		throw new Error(`Malformed XML: ${validation.err.msg} (line ${validation.err.line})`)
	}

	const parsed = xmlParser.parse(xml) as Record<string, unknown>

	if (parsed.urlset && typeof parsed.urlset === 'object') {
		const urlset = parsed.urlset as { url?: unknown }
		const entries = toArray(urlset.url as { loc?: unknown } | { loc?: unknown }[] | undefined)
		const locs = entries
			.map((entry) => (typeof entry === 'object' && entry && 'loc' in entry ? String((entry as { loc: unknown }).loc) : null))
			.filter((loc): loc is string => typeof loc === 'string' && loc.length > 0)
		return { kind: 'urlset', locs }
	}

	if (parsed.sitemapindex && typeof parsed.sitemapindex === 'object') {
		const index = parsed.sitemapindex as { sitemap?: unknown }
		const entries = toArray(index.sitemap as { loc?: unknown } | { loc?: unknown }[] | undefined)
		const locs = entries
			.map((entry) => (typeof entry === 'object' && entry && 'loc' in entry ? String((entry as { loc: unknown }).loc) : null))
			.filter((loc): loc is string => typeof loc === 'string' && loc.length > 0)
		return { kind: 'sitemapindex', locs }
	}

	return { kind: 'unrecognized' }
}

export interface DiscoverSitemapUrlsOptions extends SitemapDiscoveryLimits {
	fetchSitemap: SitemapFetcher
}

/**
 * Recursively discovers product-candidate URLs starting from one or more
 * sitemap entry points, following nested sitemap indexes up to
 * `maxDepth`, deduplicating URLs, and stopping once `maxUrls` or
 * `maxSitemaps` is reached. Fetch failures and malformed XML are recorded
 * as diagnostics rather than aborting the whole run.
 */
export async function discoverSitemapUrls(
	entryPoints: string[],
	options: DiscoverSitemapUrlsOptions
): Promise<SitemapDiscoveryResult> {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
	const maxSitemaps = options.maxSitemaps ?? DEFAULT_MAX_SITEMAPS
	const maxUrls = options.maxUrls ?? DEFAULT_MAX_URLS

	const seenUrls = new Set<string>()
	const seenSitemaps = new Set<string>()
	const sitemapsVisited: string[] = []
	const diagnostics: SitemapDiagnostic[] = []
	const urls: DiscoveredUrl[] = []
	let truncated = false

	async function visit(sitemapUrl: string, depth: number): Promise<void> {
		if (truncated) return

		if (seenSitemaps.has(sitemapUrl)) return
		seenSitemaps.add(sitemapUrl)

		if (sitemapsVisited.length >= maxSitemaps) {
			truncated = true
			diagnostics.push({
				sitemapUrl,
				issue: 'url_limit_reached',
				message: `Stopped before fetching: reached maxSitemaps limit (${maxSitemaps})`
			})
			return
		}

		if (depth > maxDepth) {
			diagnostics.push({
				sitemapUrl,
				issue: 'depth_limit_reached',
				message: `Stopped descending: reached maxDepth limit (${maxDepth})`
			})
			return
		}

		sitemapsVisited.push(sitemapUrl)

		let xml: string
		try {
			xml = await options.fetchSitemap(sitemapUrl)
		} catch (cause) {
			diagnostics.push({
				sitemapUrl,
				issue: 'fetch_failed',
				message: cause instanceof Error ? cause.message : String(cause)
			})
			return
		}

		let parsed: ParsedSitemap
		try {
			parsed = parseSitemapXml(xml)
		} catch (cause) {
			diagnostics.push({
				sitemapUrl,
				issue: 'malformed_xml',
				message: cause instanceof Error ? cause.message : String(cause)
			})
			return
		}

		if (parsed.kind === 'unrecognized') {
			diagnostics.push({
				sitemapUrl,
				issue: 'unrecognized_format',
				message: 'XML was well-formed but did not contain a <urlset> or <sitemapindex> root element'
			})
			return
		}

		if (parsed.kind === 'sitemapindex') {
			for (const loc of parsed.locs) {
				if (truncated) break
				const resolved = resolveUrl(loc, sitemapUrl)
				if (resolved) await visit(resolved, depth + 1)
			}
			return
		}

		// parsed.kind === 'urlset'
		for (const loc of parsed.locs) {
			const resolved = resolveUrl(loc, sitemapUrl)
			if (!resolved) continue
			if (seenUrls.has(resolved)) continue

			if (seenUrls.size >= maxUrls) {
				truncated = true
				diagnostics.push({
					sitemapUrl,
					issue: 'url_limit_reached',
					message: `Stopped collecting URLs: reached maxUrls limit (${maxUrls})`
				})
				break
			}

			seenUrls.add(resolved)
			const classification = classifyProductCandidate(resolved)
			if (classification.isExcludedAsset) continue

			urls.push({
				url: resolved,
				candidateConfidence: classification.candidateConfidence,
				foundInSitemap: sitemapUrl
			})
		}
	}

	for (const entryPoint of entryPoints) {
		if (truncated) break
		await visit(entryPoint, 0)
	}

	return { urls, sitemapsVisited, diagnostics, truncated }
}

function resolveUrl(loc: string, baseUrl: string): string | null {
	try {
		return new URL(loc, baseUrl).href
	} catch {
		return null
	}
}
