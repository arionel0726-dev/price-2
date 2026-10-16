import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { classifyHtmlSnapshot } from '../../src/lib/diagnostics/html-snapshot'

const FIXTURE_DIR = 'tests/fixtures/html-snapshots'

function load(name: string): string {
	return readFileSync(`${FIXTURE_DIR}/${name}`, 'utf-8')
}

describe('classifyHtmlSnapshot — distinguishes page kinds without guessing selectors (Task 6.1 §3)', () => {
	test('a real product page with JSON-LD Product data is recognized as such', () => {
		const result = classifyHtmlSnapshot(load('real-product-page.html'))
		expect(result.hasProductJsonLd).toBe(true)
		expect(result.hasAnyJsonLd).toBe(true)
		expect(result.looksLikeChallengePage).toBe(false)
		expect(result.looksLikeCategoryPage).toBe(false)
		expect(result.looksLikeJsEmptyShell).toBe(false)
	})

	test('a category/listing page with many product-shaped links and no Product JSON-LD is flagged', () => {
		const result = classifyHtmlSnapshot(load('category-page.html'))
		expect(result.hasProductJsonLd).toBe(false)
		expect(result.looksLikeCategoryPage).toBe(true)
		expect(result.notes.some((n) => n.includes('product-shaped links'))).toBe(true)
	})

	test('a bot-challenge/access-restriction page is flagged, distinct from a missing-JSON-LD product page', () => {
		const result = classifyHtmlSnapshot(load('challenge-page.html'))
		expect(result.looksLikeChallengePage).toBe(true)
		expect(result.hasProductJsonLd).toBe(false)
	})

	test('a JavaScript-dependent SPA shell (near-empty body + external scripts, no Product JSON-LD) is flagged', () => {
		const result = classifyHtmlSnapshot(load('js-spa-shell.html'))
		expect(result.looksLikeJsEmptyShell).toBe(true)
		expect(result.hasProductJsonLd).toBe(false)
	})

	test('JSON-LD present but of a non-Product type is reported as "alternative structured data", not a confirmed product', () => {
		const result = classifyHtmlSnapshot(load('alternative-structured-data.html'))
		expect(result.hasAnyJsonLd).toBe(true)
		expect(result.hasProductJsonLd).toBe(false)
		expect(result.otherJsonLdTypes).toContain('BreadcrumbList')
		expect(result.notes.some((n) => n.includes('no "Product" type'))).toBe(true)
	})

	test('a page with no JSON-LD at all is reported plainly, never fabricating a classification', () => {
		const result = classifyHtmlSnapshot('<html><body><p>Plain page</p></body></html>')
		expect(result.hasAnyJsonLd).toBe(false)
		expect(result.hasProductJsonLd).toBe(false)
		expect(result.notes.some((n) => n.includes('No <script'))).toBe(true)
	})

	test('malformed JSON-LD is counted as a parse failure, not silently ignored', () => {
		const result = classifyHtmlSnapshot('<html><head><script type="application/ld+json">{ not json </script></head><body></body></html>')
		expect(result.jsonLdParseFailureCount).toBe(1)
		expect(result.notes.some((n) => n.includes('failed to parse'))).toBe(true)
	})
})

describe('classifyHtmlSnapshot — AWS WAF JavaScript challenge detection (Task 6.2)', () => {
	test('a sanitized reconstruction of the real makeup.md AWS WAF challenge is correctly flagged', () => {
		const result = classifyHtmlSnapshot(load('aws-waf-challenge.html'))
		expect(result.looksLikeAwsWafChallenge).toBe(true)
		expect(result.looksLikeChallengePage).toBe(true)
		expect(result.hasProductJsonLd).toBe(false)
		expect(result.notes.some((n) => n.includes('AWS WAF JavaScript-challenge markers'))).toBe(true)
	})

	test('each confirmed marker alone is sufficient to flag the page (window.awsWafCookieDomainList, window.gokuProps, token.awswaf.com, challenge.js, challenge-container, AwsWafIntegration.getToken())', () => {
		const markers = [
			'window.awsWafCookieDomainList = [];',
			'window.gokuProps = {};',
			'<script src="https://x.token.awswaf.com/y"></script>',
			'<script src="/challenge.js"></script>',
			'<div id="challenge-container"></div>',
			'window.AwsWafIntegration.getToken();'
		]
		for (const marker of markers) {
			const result = classifyHtmlSnapshot(`<html><body>${marker}</body></html>`)
			expect(result.looksLikeAwsWafChallenge).toBe(true)
		}
	})

	test('a legitimate product page with ordinary third-party JavaScript (analytics, chat widget) is never misclassified as an AWS WAF challenge (negative test)', () => {
		const result = classifyHtmlSnapshot(load('product-with-ordinary-js.html'))
		expect(result.looksLikeAwsWafChallenge).toBe(false)
		expect(result.looksLikeChallengePage).toBe(false)
		expect(result.hasProductJsonLd).toBe(true)
	})

	test('an ordinary product page (no challenge markers at all) is never misclassified as an AWS WAF challenge', () => {
		const result = classifyHtmlSnapshot(load('real-product-page.html'))
		expect(result.looksLikeAwsWafChallenge).toBe(false)
	})

	test('a generic (non-AWS) challenge page is flagged as a challenge page but NOT specifically as an AWS WAF challenge', () => {
		const result = classifyHtmlSnapshot(load('challenge-page.html'))
		expect(result.looksLikeChallengePage).toBe(true)
		expect(result.looksLikeAwsWafChallenge).toBe(false)
	})
})

describe('classifyHtmlSnapshot — a genuine Magento product page is never misclassified as access-restricted (Task 7.1 §2/§4)', () => {
	function loadOvico(name: string): string {
		return readFileSync(`tests/fixtures/validate-live-ovico/html/${name}`, 'utf-8')
	}

	test('the sanitized real ovico.md Magento product page (including its standard noscript JS-required block) is not flagged as a challenge', () => {
		const result = classifyHtmlSnapshot(loadOvico('avignon-edt-50ml-vapo-magento-product.html'))
		expect(result.looksLikeChallengePage).toBe(false)
		expect(result.looksLikeAwsWafChallenge).toBe(false)
	})

	test('the unavailable-product Magento fixture is also not flagged as a challenge', () => {
		const result = classifyHtmlSnapshot(loadOvico('avignon-edt-100ml-vapo-unavailable.html'))
		expect(result.looksLikeChallengePage).toBe(false)
	})

	test('the Magento category/listing page is also not flagged as a challenge', () => {
		const result = classifyHtmlSnapshot(loadOvico('parfumuri-sezon-magento-category.html'))
		expect(result.looksLikeChallengePage).toBe(false)
	})
})

describe('classifyHtmlSnapshot — strong vs. weak challenge evidence (Task 7.2)', () => {
	function loadOvico(name: string): string {
		return readFileSync(`tests/fixtures/validate-live-ovico/html/${name}`, 'utf-8')
	}

	test('the real dekorativnaja-kosmetika category page (BreadcrumbList only, no Product, product grid) is NOT access-restricted', () => {
		const result = classifyHtmlSnapshot(loadOvico('dekorativnaja-kosmetika-category.html'))
		expect(result.looksLikeChallengePage).toBe(false)
		expect(result.hasProductJsonLd).toBe(false)
		expect(result.otherJsonLdTypes).toContain('BreadcrumbList')
	})

	test('the same category page with weak challenge-adjacent boilerplate (cloudflare CDN script, "enable cookies" banner) still reports hasWeakChallengeSignal=true but looksLikeChallengePage=false', () => {
		const result = classifyHtmlSnapshot(loadOvico('dekorativnaja-kosmetika-category-weak-boilerplate.html'))
		expect(result.hasWeakChallengeSignal).toBe(true)
		expect(result.looksLikeChallengePage).toBe(false)
	})

	test('weak markers alone (no strong evidence) never set looksLikeChallengePage, for each weak marker individually', () => {
		const weakOnlyBodies = [
			'<script src="https://cdnjs.cloudflare.com/ajax/libs/foo/1.0/foo.js"></script>',
			'<p>Access denied: this section requires staff sign-in.</p>',
			'<p>Please solve the captcha below.</p>',
			'<p>Please enable javascript for the best experience.</p>',
			'<p>This site uses cookies. Please enable cookies to continue.</p>'
		]
		for (const body of weakOnlyBodies) {
			const result = classifyHtmlSnapshot(`<html><body>${body}</body></html>`)
			expect(result.hasWeakChallengeSignal).toBe(true)
			expect(result.looksLikeChallengePage).toBe(false)
		}
	})

	test('strong evidence still wins even when the page also contains confirmed Magento product-page markup (never suppressed by site-like structure)', () => {
		const html =
			'<html><body>' +
			'<div class="product-page"><h1 class="product-page__details-name">Some Product</h1></div>' +
			'<div>Checking your browser before accessing this site. Just a moment...</div>' +
			'</body></html>'
		const result = classifyHtmlSnapshot(html)
		expect(result.looksLikeChallengePage).toBe(true)
	})

	test('a genuine PRODUCT page (not just a category page) with real weak markers (captcha widget, cookie banner) is still not access-restricted (follow-up review §2)', () => {
		const result = classifyHtmlSnapshot(loadOvico('avignon-edt-50ml-vapo-weak-boilerplate.html'))
		expect(result.hasWeakChallengeSignal).toBe(true)
		expect(result.looksLikeChallengePage).toBe(false)
	})

	test('each strong marker alone is sufficient to set looksLikeChallengePage, independent of any weak marker', () => {
		const strongBodies = [
			'<p>Just a moment...</p>',
			'<p>Checking your browser before accessing the site.</p>',
			'<p>Attention Required! | Cloudflare</p>',
			'<p>Please verify you are human to continue.</p>',
			'<p>Are you a human? Confirm below.</p>',
			'<p>Our systems have detected unusual traffic from your network.</p>'
		]
		for (const body of strongBodies) {
			const result = classifyHtmlSnapshot(`<html><body>${body}</body></html>`)
			expect(result.looksLikeChallengePage).toBe(true)
		}
	})
})
