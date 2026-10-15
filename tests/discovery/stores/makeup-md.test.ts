import { describe, expect, test } from 'bun:test'
import { makeupMdStoreProfile } from '../../../src/lib/discovery/stores/makeup-md'

const { classifyProductUrl, dedupeProductUrls } = makeupMdStoreProfile

describe('makeupMdStoreProfile — metadata', () => {
	test('is explicitly marked unverified (no confirmed real sitemap/HTML sample yet)', () => {
		expect(makeupMdStoreProfile.patternConfidence).toBe('unverified')
	})

	test('exposes the previously-advertised (not guaranteed current) sitemap location as the default', () => {
		expect(makeupMdStoreProfile.defaultSitemapUrl).toBe('https://makeup.md/sitemap/sitemap.xml')
	})

	test('domain is the exact hostname', () => {
		expect(makeupMdStoreProfile.domain).toBe('makeup.md')
	})
})

describe('makeupMdStoreProfile.classifyProductUrl — likely product shapes', () => {
	const likelyProductUrls = [
		'https://makeup.md/product/ruj-mat-catrice-010',
		'https://makeup.md/p/rimel-maybelline-24h',
		'https://makeup.md/catalog/machiaj/fond-de-ten-123'
	]

	for (const url of likelyProductUrls) {
		test(`treats "${url}" as a candidate`, () => {
			expect(classifyProductUrl(url)).not.toBeNull()
		})
	}
})

describe('makeupMdStoreProfile.classifyProductUrl — avoids category/search/cart/account/checkout pages', () => {
	const nonProductUrls = [
		'https://makeup.md/catalog/machiaj/',
		'https://makeup.md/category/parfumuri',
		'https://makeup.md/search?q=ruj',
		'https://makeup.md/cart',
		'https://makeup.md/checkout',
		'https://makeup.md/account',
		'https://makeup.md/login',
		'https://makeup.md/wishlist',
		'https://makeup.md/compare'
	]

	for (const url of nonProductUrls) {
		test(`does not treat "${url}" as a product candidate`, () => {
			expect(classifyProductUrl(url)).toBeNull()
		})
	}
})

describe('makeupMdStoreProfile.classifyProductUrl — avoids obvious non-page assets', () => {
	test('excludes an image asset URL', () => {
		expect(classifyProductUrl('https://makeup.md/assets/logo.png')).toBeNull()
	})

	test('returns null for an unparsable URL', () => {
		expect(classifyProductUrl('not a url')).toBeNull()
	})
})

describe('makeupMdStoreProfile.dedupeProductUrls — conservative canonicalization only', () => {
	test('deduplicates exact duplicates and tracking-parameter variants', () => {
		const urls = [
			'https://makeup.md/product/ruj-mat-catrice-010',
			'https://makeup.md/product/ruj-mat-catrice-010?utm_source=newsletter',
			'https://makeup.md/product/ruj-mat-catrice-010/'
		]
		expect(dedupeProductUrls(urls)).toHaveLength(1)
	})

	test('keeps distinct products separate', () => {
		const urls = ['https://makeup.md/product/ruj-mat-catrice-010', 'https://makeup.md/product/ruj-mat-catrice-011']
		expect(dedupeProductUrls(urls)).toHaveLength(2)
	})

	test('does NOT merge URLs that differ only by a non-tracking query parameter (may select a variant)', () => {
		const urls = ['https://makeup.md/product/ruj-mat-catrice?shade=010', 'https://makeup.md/product/ruj-mat-catrice?shade=011']
		expect(dedupeProductUrls(urls)).toHaveLength(2)
	})

	test('skips unparsable URLs rather than throwing', () => {
		expect(dedupeProductUrls(['not a url', 'https://makeup.md/product/ruj-mat-catrice-010'])).toHaveLength(1)
	})
})
