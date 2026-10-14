import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractProductsFromHtml } from '../../src/lib/scraping/extract'

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures', 'html')

function loadFixture(name: string): string {
	return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
}

describe('extractProductsFromHtml', () => {
	test('extracts a fully-populated Product with normalized and raw values preserved', () => {
		const { products, failures } = extractProductsFromHtml(
			'https://shop.example.test/products/rose-50ml',
			loadFixture('product-jsonld.html')
		)

		expect(failures).toHaveLength(0)
		expect(products).toHaveLength(1)
		const [product] = products

		expect(product.title.raw).toBe('  Rose   Eau de Parfum  ')
		expect(product.title.normalized).toBe('Rose Eau de Parfum')
		expect(product.brand.normalized).toBe('Vizaje')
		expect(product.sku).toBe('VZ-ROSE-50')
		expect(product.gtin).toBe('5901234123457')
		expect(product.variant.normalized).toBe('50ml')
		expect(product.price).toEqual({ raw: '349.00', amount: 349, currency: 'MDL' })
		expect(product.availability.normalized).toBe('in_stock')
	})

	test('extracts a Product nested in @graph with a variant from additionalProperty', () => {
		const { products, failures } = extractProductsFromHtml(
			'https://shop.example.test/products/jasmine-200ml',
			loadFixture('product-graph.html')
		)

		expect(failures).toHaveLength(0)
		expect(products).toHaveLength(1)
		expect(products[0].variant.normalized).toBe('200ml')
	})

	test('does not invent a price when none is present, and keeps it distinguishable from zero', () => {
		const { products, failures } = extractProductsFromHtml(
			'https://shop.example.test/products/sandalwood-100g',
			loadFixture('product-missing-price.html')
		)

		expect(failures).toHaveLength(0)
		expect(products).toHaveLength(1)
		expect(products[0].price.amount).toBeNull()
		expect(products[0].price.currency).toBe('MDL')
		expect(products[0].availability.normalized).toBe('out_of_stock')
	})

	test('uses the first offer when multiple offers are present, without merging them', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/lavender-shampoo',
			loadFixture('product-multiple-offers.html')
		)

		expect(products).toHaveLength(1)
		expect(products[0].price).toEqual({ raw: '129.00', amount: 129, currency: 'MDL' })
	})

	test('reports a parse failure for malformed JSON-LD but still extracts the valid block', () => {
		const { products, failures } = extractProductsFromHtml(
			'https://shop.example.test/products/chamomile-50ml',
			loadFixture('malformed-jsonld.html')
		)

		expect(failures.some((f) => f.reason === 'malformed_json_ld')).toBe(true)
		expect(products).toHaveLength(1)
		expect(products[0].title.normalized).toBe('Chamomile Face Cream')
	})

	test('reports no_structured_data_found for a page without any JSON-LD', () => {
		const { products, failures } = extractProductsFromHtml(
			'https://shop.example.test/products/plain-page',
			loadFixture('no-structured-data.html')
		)

		expect(products).toHaveLength(0)
		expect(failures).toEqual([
			{
				sourceUrl: 'https://shop.example.test/products/plain-page',
				reason: 'no_structured_data_found',
				message: expect.any(String)
			}
		])
	})

	test('distinguishes same-name products with different sizes as separate records', () => {
		const a = extractProductsFromHtml(
			'https://shop.example.test/products/ocean-breeze-50ml',
			loadFixture('product-variant-50ml.html')
		)
		const b = extractProductsFromHtml(
			'https://shop.example.test/products/ocean-breeze-100ml',
			loadFixture('product-variant-100ml.html')
		)

		expect(a.products[0].title.normalized).toBe(b.products[0].title.normalized)
		expect(a.products[0].variant.normalized).toBe('50ml')
		expect(b.products[0].variant.normalized).toBe('100ml')
		expect(a.products[0].sku).not.toBe(b.products[0].sku)
		expect(a.products[0].price.amount).not.toBe(b.products[0].price.amount)
	})
})
