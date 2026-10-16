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
