/**
 * Pure, offline-testable diagnostics for a single saved HTML page — used to
 * distinguish, WITHOUT guessing any extraction selectors, what kind of page
 * we actually received (see Task 6.1 §3):
 *
 *   - a real product page with JSON-LD Product data
 *   - a category/listing page
 *   - an access-restriction / bot-challenge page
 *   - a page with JSON-LD present but no Product type ("alternative
 *     structured data")
 *   - a JavaScript-dependent SPA shell with little server-rendered content
 *
 * This module never fetches anything itself (see
 * src/scripts/snapshot-product-html.ts for the opt-in, --live-gated CLI
 * that saves real snapshots locally) and never invents HTML structure or
 * CSS selectors — it only reports signals already used elsewhere in this
 * codebase (JSON-LD presence/type — see src/lib/scraping/jsonld.ts) plus a
 * few conservative, clearly-labeled heuristics.
 */
import * as cheerio from 'cheerio'
import { extractJsonLdBlocks, filterProductNodes } from '../scraping/jsonld'

export interface HtmlSnapshotClassification {
	hasAnyJsonLd: boolean
	hasProductJsonLd: boolean
	jsonLdParseFailureCount: number
	/** @type values found in JSON-LD on this page, other than "Product" (e.g. "CollectionPage", "BreadcrumbList"). */
	otherJsonLdTypes: string[]
	looksLikeChallengePage: boolean
	looksLikeCategoryPage: boolean
	looksLikeJsEmptyShell: boolean
	/** Human-readable explanations for every signal above, in the order they were detected. */
	notes: string[]
}

const CHALLENGE_PAGE_MARKERS = [
	/just a moment/i,
	/checking your browser/i,
	/attention required/i,
	/cloudflare/i,
	/are you (a )?human/i,
	/access denied/i,
	/\bcaptcha\b/i,
	/please enable javascript/i,
	/enable cookies/i,
	/unusual traffic/i,
	/verify you are human/i
]

const PRODUCT_LINK_PATTERN = /\/(products?|item|p)\//i

function collectJsonLdTypes(nodes: Record<string, unknown>[]): string[] {
	const types = new Set<string>()
	for (const node of nodes) {
		const type = node['@type']
		if (typeof type === 'string') types.add(type)
		else if (Array.isArray(type)) {
			for (const t of type) if (typeof t === 'string') types.add(t)
		}
	}
	types.delete('Product')
	return [...types]
}

/**
 * Classifies a single already-fetched HTML page. Pure and offline — takes
 * no network action and reports only what the given markup actually
 * contains.
 */
export function classifyHtmlSnapshot(html: string): HtmlSnapshotClassification {
	const notes: string[] = []

	const { nodes, failures } = extractJsonLdBlocks(html)
	const productNodes = filterProductNodes(nodes)
	const hasAnyJsonLd = nodes.length > 0 || failures.length > 0
	const hasProductJsonLd = productNodes.length > 0
	const otherJsonLdTypes = collectJsonLdTypes(nodes)

	const looksLikeChallengePage = CHALLENGE_PAGE_MARKERS.some((pattern) => pattern.test(html))

	const $ = cheerio.load(html)
	const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
	const externalScriptCount = $('script[src]').length

	const productLikeLinks = $('a[href]')
		.toArray()
		.map((el) => $(el).attr('href') ?? '')
		.filter((href) => PRODUCT_LINK_PATTERN.test(href))

	// Deliberately conservative thresholds: this is a coarse signal to point
	// a human at the right next step, never a basis for automatic extraction.
	const looksLikeJsEmptyShell = bodyText.length < 200 && externalScriptCount >= 3 && !hasProductJsonLd
	const looksLikeCategoryPage = productLikeLinks.length >= 5 && !hasProductJsonLd

	if (hasProductJsonLd) {
		notes.push(`Found ${productNodes.length} JSON-LD node(s) declaring @type "Product".`)
	} else if (!hasAnyJsonLd) {
		notes.push('No <script type="application/ld+json"> blocks found on the page at all.')
	} else if (otherJsonLdTypes.length > 0) {
		notes.push(`JSON-LD is present but declares no "Product" type; found instead: ${otherJsonLdTypes.join(', ')}.`)
	}

	if (failures.length > 0) {
		notes.push(`${failures.length} JSON-LD block(s) failed to parse as JSON.`)
	}
	if (looksLikeChallengePage) {
		notes.push('Page text matches known bot-challenge/CAPTCHA/access-restriction phrasing.')
	}
	if (looksLikeJsEmptyShell) {
		notes.push(
			`Rendered body text is very short (${bodyText.length} chars) alongside ${externalScriptCount} external <script> tag(s) — ` +
				'may be a JavaScript-rendered single-page-app shell whose real content never appears in the server response.'
		)
	}
	if (looksLikeCategoryPage) {
		notes.push(`Found ${productLikeLinks.length} product-shaped links on this page — may be a category/listing page rather than a single product detail page.`)
	}
	if (notes.length === 0) {
		notes.push('No specific signal matched; inspect the saved HTML manually.')
	}

	return {
		hasAnyJsonLd,
		hasProductJsonLd,
		jsonLdParseFailureCount: failures.length,
		otherJsonLdTypes,
		looksLikeChallengePage,
		looksLikeCategoryPage,
		looksLikeJsEmptyShell,
		notes
	}
}
