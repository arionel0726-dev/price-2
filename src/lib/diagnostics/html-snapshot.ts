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
	/**
	 * True when STRONG challenge evidence matched — a confirmed AWS WAF
	 * marker, or one of the generic phrases specific enough that an ordinary
	 * page is very unlikely to contain it by coincidence (see
	 * STRONG_CHALLENGE_MARKERS below). This is the ONLY signal callers (see
	 * src/lib/validation/live-validator.ts) should treat as grounds for an
	 * access_restricted outcome — see `hasWeakChallengeSignal` for why weak
	 * matches must not gate that decision on their own (Task 7.2).
	 */
	looksLikeChallengePage: boolean
	/**
	 * True specifically when one of the confirmed AWS WAF JavaScript-challenge
	 * markers matched (see AWS_WAF_CHALLENGE_MARKERS below) — a narrower,
	 * higher-confidence signal than the generic challenge-page wording, based
	 * on real makeup.md responses (Task 6.2) that the generic markers alone
	 * missed.
	 */
	looksLikeAwsWafChallenge: boolean
	/**
	 * True when a WEAK challenge-adjacent phrase matched (see
	 * WEAK_CHALLENGE_MARKERS below) — wording that commonly appears in
	 * ordinary e-commerce boilerplate unrelated to any access restriction
	 * (a reCAPTCHA widget on a contact/newsletter form, a GDPR cookie
	 * banner, a CDN script loaded from a cloudflare.com URL, a standard
	 * "enable JavaScript" noscript block). Reported for visibility only —
	 * it deliberately does NOT set `looksLikeChallengePage` on its own
	 * (Task 7.2 §1/§2): a real Magento category or product page containing
	 * one of these phrases must not be misclassified as access-restricted.
	 * Strong evidence (AWS WAF or STRONG_CHALLENGE_MARKERS) always still
	 * wins regardless of this flag (Task 7.2 §3).
	 */
	hasWeakChallengeSignal: boolean
	looksLikeCategoryPage: boolean
	looksLikeJsEmptyShell: boolean
	/** Human-readable explanations for every signal above, in the order they were detected. */
	notes: string[]
}

/**
 * High-confidence challenge phrasing: specific enough that an ordinary
 * e-commerce page is very unlikely to contain any of these by coincidence.
 * Matching ANY of these (or an AWS WAF marker) is sufficient on its own to
 * classify a response as access-restricted.
 */
const STRONG_CHALLENGE_MARKERS = [
	/just a moment/i,
	/checking your browser/i,
	/attention required/i,
	/are you (a )?human/i,
	/unusual traffic/i,
	/verify you are human/i
]

/**
 * Weak, challenge-ADJACENT phrasing that also shows up routinely in
 * ordinary page boilerplate unrelated to any access restriction:
 *   - "cloudflare": a legitimate page can load a script from a
 *     cloudflare.com-hosted CDN (e.g. cdnjs.cloudflare.com), or simply
 *     credit "Powered by Cloudflare" in a footer.
 *   - "captcha": a reCAPTCHA widget on an ordinary contact/newsletter/login
 *     form, present site-wide including on category and product pages.
 *   - "access denied": can appear in unrelated permission-restricted
 *     content (an admin-only section notice, a generic 403 page for a
 *     different reason) that has nothing to do with bot detection.
 *   - "please enable javascript" / "enable cookies": standard
 *     <noscript>/cookie-consent-banner boilerplate found on many
 *     completely ordinary sites (confirmed not to false-positive on a real
 *     Magento product page's own noscript block — see
 *     tests/diagnostics/html-snapshot.test.ts).
 * These alone are NEVER sufficient to classify a page as access-restricted
 * (see `hasWeakChallengeSignal`) — they are reported for visibility only.
 */
const WEAK_CHALLENGE_MARKERS = [/cloudflare/i, /access denied/i, /\bcaptcha\b/i, /please enable javascript/i, /enable cookies/i]

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
	const hasStrongGenericChallengeSignal = STRONG_CHALLENGE_MARKERS.some((pattern) => pattern.test(html))
	const hasWeakChallengeSignal = WEAK_CHALLENGE_MARKERS.some((pattern) => pattern.test(html))
	const looksLikeChallengePage = looksLikeAwsWafChallenge || hasStrongGenericChallengeSignal

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
	} else if (hasStrongGenericChallengeSignal) {
		notes.push('Page text matches high-confidence bot-challenge phrasing (e.g. "just a moment", "checking your browser", "verify you are human").')
	}
	if (hasWeakChallengeSignal) {
		notes.push(
			'Page text contains a weak challenge-adjacent phrase (cloudflare/captcha/access denied/enable JavaScript or cookies) — ' +
				'common in ordinary page boilerplate (CDN scripts, consent banners, contact-form widgets) and NOT by itself treated as ' +
				'access-restriction evidence; see looksLikeChallengePage for the actual (strong-evidence-only) verdict.'
		)
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
		hasWeakChallengeSignal,
		looksLikeCategoryPage,
		looksLikeJsEmptyShell,
		notes
	}
}
