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
	/** True when ANY challenge marker matched — generic or AWS-WAF-specific. See `looksLikeAwsWafChallenge` to tell which. */
	looksLikeChallengePage: boolean
	/**
	 * True specifically when one of the confirmed AWS WAF JavaScript-challenge
	 * markers matched (see AWS_WAF_CHALLENGE_MARKERS below) — a narrower,
	 * higher-confidence signal than the generic challenge-page wording, based
	 * on real makeup.md responses (Task 6.2) that the generic markers alone
	 * missed.
	 */
	looksLikeAwsWafChallenge: boolean
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

/**
 * Confirmed AWS WAF JavaScript-challenge markers, taken from real makeup.md
 * responses saved during Task 6.2 (sanitized before being committed as test
 * fixtures — see tests/fixtures/html-snapshots/aws-waf-challenge.html).
 * Deliberately specific strings (not generic words like "token" or
 * "challenge" alone, which a legitimate product page could plausibly
 * contain) so this cannot false-positive on ordinary pages — see the
 * negative tests in tests/diagnostics/html-snapshot.test.ts.
 */
const AWS_WAF_CHALLENGE_MARKERS = [
	/window\.awsWafCookieDomainList/,
	/window\.gokuProps/,
	/token\.awswaf\.com/,
	/challenge\.js/,
	/challenge-container/,
	/AwsWafIntegration\.getToken\(\)/
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

	const looksLikeAwsWafChallenge = AWS_WAF_CHALLENGE_MARKERS.some((pattern) => pattern.test(html))
	const looksLikeChallengePage = looksLikeAwsWafChallenge || CHALLENGE_PAGE_MARKERS.some((pattern) => pattern.test(html))

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
	if (looksLikeAwsWafChallenge) {
		notes.push(
			'Detected confirmed AWS WAF JavaScript-challenge markers (awsWafCookieDomainList/gokuProps/token.awswaf.com/challenge.js/' +
				'challenge-container/AwsWafIntegration.getToken()) — this is an access-restricted response, not a product page.'
		)
	} else if (looksLikeChallengePage) {
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
		looksLikeAwsWafChallenge,
		looksLikeCategoryPage,
		looksLikeJsEmptyShell,
		notes
	}
}
