import { describe, expect, test } from 'bun:test'
import { ovicoMdStoreProfile } from '../../../src/lib/discovery/stores/ovico-md'

const { classifyProductUrl, dedupeProductUrls } = ovicoMdStoreProfile

describe('ovicoMdStoreProfile — metadata', () => {
	test('is explicitly marked unverified (one confirmed URL, not a confirmed general pattern)', () => {
		expect(ovicoMdStoreProfile.patternConfidence).toBe('unverified')
	})

	test('exposes the sitemap location advertised in ovico.md robots.txt as the default', () => {
		expect(ovicoMdStoreProfile.defaultSitemapUrl).toBe('https://ovico.md/media/sitemap/sitemap_index.xml')
	})

	test('domain is the exact hostname', () => {
		expect(ovicoMdStoreProfile.domain).toBe('ovico.md')
	})
})

describe('ovicoMdStoreProfile.classifyProductUrl — the confirmed real product URL and its shape', () => {
	test('treats the one confirmed real product URL as a candidate', () => {
		const match = classifyProductUrl('https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml')
		expect(match).not.toBeNull()
		expect(match?.language).toBe('ru')
	})

	test('treats the equivalent /ro/ flat-slug shape as a candidate too (same shape, not confirmed as the same product)', () => {
		const match = classifyProductUrl('https://ovico.md/ro/jo-malone-london-pine-eucalyptus-diffuser-165ml')
		expect(match).not.toBeNull()
		expect(match?.language).toBe('ro')
	})

	test('the classification reason explicitly says this is unverified and a candidate, not a confirmed product', () => {
		const match = classifyProductUrl('https://ovico.md/ru/some-other-product-50ml')
		expect(match?.reason).toContain('UNVERIFIED')
		expect(match?.reason).toContain('candidate, not a confirmed product page')
	})
})

describe('ovicoMdStoreProfile.classifyProductUrl — avoids known non-product sections sharing the same flat shape', () => {
	const nonProductUrls = [
		'https://ovico.md/ru/search',
		'https://ovico.md/ru/cart',
		'https://ovico.md/ru/checkout',
		'https://ovico.md/ru/account',
		'https://ovico.md/ru/login',
		'https://ovico.md/ru/wishlist',
		'https://ovico.md/ru/compare',
		'https://ovico.md/ru/catalog',
		'https://ovico.md/ru/catalog-parfumuri',
		'https://ovico.md/ru/category-machiaj',
		'https://ovico.md/ru/brand-chanel',
		'https://ovico.md/ru/brands',
		'https://ovico.md/ru/collection-noutati',
		'https://ovico.md/ru/blog-despre-parfumuri',
		'https://ovico.md/ro/cart'
	]

	for (const url of nonProductUrls) {
		test(`does not treat "${url}" as a product candidate`, () => {
			expect(classifyProductUrl(url)).toBeNull()
		})
	}
})

describe('ovicoMdStoreProfile.classifyProductUrl — avoids multi-segment paths (not the confirmed flat shape) and other languages', () => {
	test('excludes a nested category/product path (two segments after the language prefix)', () => {
		expect(classifyProductUrl('https://ovico.md/ru/parfumuri/jo-malone-diffuser')).toBeNull()
	})

	test('excludes the bare language-root page', () => {
		expect(classifyProductUrl('https://ovico.md/ru')).toBeNull()
	})

	test('excludes a URL with no recognized /ru/ or /ro/ language prefix', () => {
		expect(classifyProductUrl('https://ovico.md/en/jo-malone-diffuser')).toBeNull()
	})

	test('returns null for an unparsable URL', () => {
		expect(classifyProductUrl('not a url')).toBeNull()
	})
})

describe('ovicoMdStoreProfile.dedupeProductUrls — conservative canonicalization only, no cross-language merging', () => {
	test('deduplicates exact duplicates and tracking-parameter variants of the same URL', () => {
		const urls = [
			'https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml',
			'https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml?utm_source=newsletter',
			'https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml/'
		]
		expect(dedupeProductUrls(urls)).toHaveLength(1)
	})

	test('does NOT merge the /ru/ and /ro/ variants of the same slug — no confirmed evidence they are the same product listing', () => {
		const urls = [
			'https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml',
			'https://ovico.md/ro/jo-malone-london-pine-eucalyptus-diffuser-165ml'
		]
		expect(dedupeProductUrls(urls)).toHaveLength(2)
	})

	test('keeps distinct products separate', () => {
		const urls = ['https://ovico.md/ru/product-a-50ml', 'https://ovico.md/ru/product-b-50ml']
		expect(dedupeProductUrls(urls)).toHaveLength(2)
	})

	test('skips unparsable URLs rather than throwing', () => {
		expect(dedupeProductUrls(['not a url', 'https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml'])).toHaveLength(1)
	})
})
