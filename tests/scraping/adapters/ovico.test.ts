import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { classifyAndExtractOvicoHtml } from '../../../src/lib/scraping/adapters/ovico'

const FIXTURE_DIR = 'tests/fixtures/validate-live-ovico/html'

function load(name: string): string {
	return readFileSync(`${FIXTURE_DIR}/${name}`, 'utf-8')
}

const SOURCE_URL = 'https://ovico.md/ru/avignon-edt-50ml-vapo'

describe('classifyAndExtractOvicoHtml — confirmed Magento selectors only (Task 7.1)', () => {
	test('extracts title, SKU, volume, and in-stock availability from the real confirmed product markup', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, load('avignon-edt-50ml-vapo-magento-product.html'))
		expect(result?.kind).toBe('product')
		if (result?.kind !== 'product' || !result.record) throw new Error('expected a product record')

		expect(result.record.title.normalized).toBe('Avignon EDT 50ml Vapo')
		expect(result.record.sku).toBe('OVC-AVG-50EDT')
		expect(result.record.variant.normalized).toBe('50 ml')
		expect(result.record.availability.normalized).toBe('in_stock')
	})

	test('never invents brand, GTIN, or price — all three stay null (Task 7.1 §6)', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, load('avignon-edt-50ml-vapo-magento-product.html'))
		if (result?.kind !== 'product' || !result.record) throw new Error('expected a product record')

		expect(result.record.brand.normalized).toBeNull()
		expect(result.record.gtin).toBeNull()
		expect(result.record.price.amount).toBeNull()
		expect(result.record.price.currency).toBeNull()
	})

	test('field provenance marks every extracted field as html_attribute, and every unextracted field as missing', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, load('avignon-edt-50ml-vapo-magento-product.html'))
		if (result?.kind !== 'product' || !result.record) throw new Error('expected a product record')

		expect(result.record.fieldProvenance?.title).toBe('html_attribute')
		expect(result.record.fieldProvenance?.sku).toBe('html_attribute')
		expect(result.record.fieldProvenance?.variant).toBe('html_attribute')
		expect(result.record.fieldProvenance?.availability).toBe('html_attribute')
		expect(result.record.fieldProvenance?.brand).toBe('missing')
		expect(result.record.fieldProvenance?.gtin).toBe('missing')
		expect(result.record.fieldProvenance?.price).toBe('missing')
		expect(result.record.fieldProvenance?.currency).toBe('missing')
	})

	test('still extracts a genuine product normally when real weak markers (captcha widget, cookie banner) are present (follow-up review §2)', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, load('avignon-edt-50ml-vapo-weak-boilerplate.html'))
		expect(result?.kind).toBe('product')
		if (result?.kind !== 'product' || !result.record) throw new Error('expected a product record')
		expect(result.record.title.normalized).toBe('Avignon EDT 50ml Vapo')
		expect(result.record.sku).toBe('OVC-AVG-50EDT')
	})

	test('detects the confirmed "not available" marker and reports out_of_stock', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, load('avignon-edt-100ml-vapo-unavailable.html'))
		if (result?.kind !== 'product' || !result.record) throw new Error('expected a product record')
		expect(result.record.availability.normalized).toBe('out_of_stock')
	})

	test('returns null for volume when multiple options exist with no selected/active/checked marker, rather than guessing', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, load('avignon-multi-volume-ambiguous.html'))
		if (result?.kind !== 'product' || !result.record) throw new Error('expected a product record')
		expect(result.record.variant.normalized).toBeNull()
	})

	test('classifies a Magento category/listing page (product grid, no .product-page) as non_product, not a product', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, load('parfumuri-sezon-magento-category.html'))
		expect(result).toEqual({ kind: 'non_product' })
	})

	test('returns null (defers to the generic pipeline) for HTML matching neither confirmed structural marker', () => {
		const result = classifyAndExtractOvicoHtml(SOURCE_URL, '<html><body><p>Unrelated page</p></body></html>')
		expect(result).toBeNull()
	})
})

describe('classifyAndExtractOvicoHtml — dekorativnaja-kosmetika and weak-boilerplate category pages (Task 7.2)', () => {
	test('the real dekorativnaja-kosmetika category page is classified as non_product (structural, not URL-based)', () => {
		const result = classifyAndExtractOvicoHtml('https://ovico.md/ru/dekorativnaja-kosmetika', load('dekorativnaja-kosmetika-category.html'))
		expect(result).toEqual({ kind: 'non_product' })
	})

	test('the same category page with weak challenge-adjacent boilerplate is STILL classified as non_product, never as a product and never suppressed', () => {
		const result = classifyAndExtractOvicoHtml(
			'https://ovico.md/ru/dekorativnaja-kosmetika',
			load('dekorativnaja-kosmetika-category-weak-boilerplate.html')
		)
		expect(result).toEqual({ kind: 'non_product' })
	})

	test('a genuinely ambiguous flat-slug page (no product container, no product grid) defers rather than guessing', () => {
		const result = classifyAndExtractOvicoHtml('https://ovico.md/ru/dostavka', load('ambiguous-flat-slug.html'))
		expect(result).toBeNull()
	})
})
