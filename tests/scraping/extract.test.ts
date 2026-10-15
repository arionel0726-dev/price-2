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

describe('extractProductsFromHtml — text encoding', () => {
	test('repairs a mojibake-corrupted title in normalized form while preserving the raw value as extracted', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/moresque-jasminisha',
			loadFixture('product-mojibake-title.html')
		)

		expect(products).toHaveLength(1)
		expect(products[0].title.raw).toBe('MORESQUE Jasminisha 75 ml ApДѓ de parfum')
		expect(products[0].title.normalized).toBe('MORESQUE Jasminisha 75 ml Apă de parfum')
	})
})

describe('extractProductsFromHtml — GTIN validation', () => {
	test('rejects a gtin13 value that fails the GS1 checksum, reporting it as missing rather than keeping a wrong value', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/crema-de-fata',
			loadFixture('product-invalid-gtin.html')
		)

		expect(products).toHaveLength(1)
		expect(products[0].gtin).toBeNull()
		expect(products[0].fieldProvenance?.gtin).toBe('missing')
	})
})

describe('extractProductsFromHtml — variant/GTIN extraction precedence', () => {
	test('uses a reliable HTML attribute for variant when JSON-LD has none', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/apa-de-parfum-lumina',
			loadFixture('product-html-fallback-variant.html')
		)

		expect(products[0].variant.normalized).toBe('75 ml')
		expect(products[0].fieldProvenance?.variant).toBe('html_attribute')
	})

	test('uses a reliable HTML attribute for GTIN when JSON-LD has none', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/sapun-natural',
			loadFixture('product-html-fallback-gtin.html')
		)

		expect(products[0].gtin).toBe('5901234123457')
		expect(products[0].fieldProvenance?.gtin).toBe('html_attribute')
	})

	test('falls back to conservative title extraction for variant only when JSON-LD and HTML attributes both lack it', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/apa-de-toaleta-citrice',
			loadFixture('product-title-volume.html')
		)

		expect(products[0].variant.normalized).toBe('100 ml')
		expect(products[0].fieldProvenance?.variant).toBe('title')
	})

	test('never invents a variant from a title that has no explicit size (e.g. a shade code)', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/ruj-mat-catrice',
			loadFixture('product-shade-not-volume.html')
		)

		expect(products[0].variant.normalized).toBeNull()
		expect(products[0].fieldProvenance?.variant).toBe('missing')
	})

	test('extracts a GTIN only when explicitly labeled as a barcode in the page body', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/parfum-de-corp',
			loadFixture('product-labeled-barcode-body.html')
		)

		expect(products[0].gtin).toBe('5901234123457')
		expect(products[0].fieldProvenance?.gtin).toBe('html_attribute')
	})
})

describe('extractProductsFromHtml — conflicting JSON-LD vs. HTML data', () => {
	test('keeps the JSON-LD variant and reports the conflict rather than silently picking one', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/crema-de-corp',
			loadFixture('product-conflicting-variant.html')
		)

		expect(products[0].variant.normalized).toBe('50ml') // JSON-LD value kept, never overwritten
		expect(products[0].fieldProvenance?.variant).toBe('json_ld')
		expect(products[0].conflicts).toEqual([{ field: 'variant', jsonLdValue: '50ml', htmlValue: '75 ml' }])
	})

	test('keeps the JSON-LD GTIN and reports the conflict rather than silently picking one', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/lotiune-de-corp',
			loadFixture('product-conflicting-gtin.html')
		)

		expect(products[0].gtin).toBe('5901234123457') // JSON-LD value kept
		expect(products[0].fieldProvenance?.gtin).toBe('json_ld')
		expect(products[0].conflicts).toEqual([{ field: 'gtin', jsonLdValue: '5901234123457', htmlValue: '4006381333931' }])
	})
})

describe('extractProductsFromHtml — incorrectly formatted prices', () => {
	test('parses a price string with a thousands separator and trailing currency text', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/crema-de-noapte',
			loadFixture('product-dirty-price.html')
		)

		expect(products[0].price.amount).toBe(1250)
		expect(products[0].price.currency).toBe('MDL')
	})
})

describe('extractProductsFromHtml — field provenance (regression: fully-populated JSON-LD)', () => {
	test('every present field is attributed to json_ld when extraction has no fallback involvement', () => {
		const { products } = extractProductsFromHtml(
			'https://shop.example.test/products/rose-50ml',
			loadFixture('product-jsonld.html')
		)

		expect(products[0].fieldProvenance).toEqual({
			title: 'json_ld',
			brand: 'json_ld',
			sku: 'json_ld',
			gtin: 'json_ld',
			variant: 'json_ld',
			price: 'json_ld',
			currency: 'json_ld',
			availability: 'json_ld'
		})
		expect(products[0].conflicts).toBeUndefined()
	})
})
