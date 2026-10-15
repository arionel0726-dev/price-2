import { describe, expect, test } from 'bun:test'
import { extractHtmlFallbackFields } from '../../src/lib/scraping/html-fallback'

describe('extractHtmlFallbackFields — variant', () => {
	test('reads an explicit itemprop="size" attribute', () => {
		const html = '<html><body><span itemprop="size" content="75 ml">75 ml</span></body></html>'
		expect(extractHtmlFallbackFields(html).variant?.normalized).toBe('75 ml')
	})

	test('reads a conventional .product-volume class', () => {
		const html = '<html><body><span class="product-volume">100g</span></body></html>'
		expect(extractHtmlFallbackFields(html).variant?.normalized).toBe('100g')
	})

	test('returns null when nothing matches', () => {
		const html = '<html><body><p>No variant markers here.</p></body></html>'
		expect(extractHtmlFallbackFields(html).variant).toBeNull()
	})
})

describe('extractHtmlFallbackFields — GTIN', () => {
	test('reads a valid itemprop="gtin13" meta tag', () => {
		const html = '<html><head><meta itemprop="gtin13" content="5901234123457" /></head><body></body></html>'
		expect(extractHtmlFallbackFields(html).gtin).toBe('5901234123457')
	})

	test('rejects an itemprop="gtin13" value that fails the checksum', () => {
		const html = '<html><head><meta itemprop="gtin13" content="5901234123458" /></head><body></body></html>'
		expect(extractHtmlFallbackFields(html).gtin).toBeNull()
	})

	test('falls back to a labeled barcode in the page body when no attribute is present', () => {
		const html = '<html><body><p>Cod de bare: 4006381333931</p></body></html>'
		expect(extractHtmlFallbackFields(html).gtin).toBe('4006381333931')
	})

	test('returns null when nothing matches', () => {
		const html = '<html><body><p>No barcode here.</p></body></html>'
		expect(extractHtmlFallbackFields(html).gtin).toBeNull()
	})
})
