import { describe, expect, test } from 'bun:test'
import { main } from '../../src/scripts/discover'

describe('discover CLI (fixture mode)', () => {
	test('runs the full discovery + extraction pipeline from the default manifest', async () => {
		const report = await main(['--manifest', 'tests/fixtures/manifest.json'])

		expect(report.mode).toBe('fixture')
		expect(report.discovery.sitemapsVisited).toHaveLength(3)
		expect(report.discovery.urls.map((u) => u.url)).toEqual([
			'https://shop.example.test/products/jasmine-body-lotion-200ml',
			'https://shop.example.test/products/sandalwood-soap-100g'
		])
		expect(report.extraction.products).toHaveLength(2)
		expect(report.extraction.skipped).toHaveLength(0)
		expect(report.stats.extractedProductCount).toBe(2)

		const jasmine = report.extraction.products.find((p) => p.sku === 'VZ-JASMINE-200')
		expect(jasmine?.variant.normalized).toBe('200ml')

		const sandalwood = report.extraction.products.find((p) => p.sku === 'VZ-SANDAL-100')
		expect(sandalwood?.price.amount).toBeNull()
		expect(sandalwood?.availability.normalized).toBe('out_of_stock')
	})

	test('rejects an unknown CLI argument', async () => {
		await expect(main(['--bogus'])).rejects.toThrow('Unknown argument')
	})

	test('reports skipped URLs when a discovered page has no mapped fixture', async () => {
		const report = await main(['--manifest', 'tests/fixtures/manifest-partial.json'])
		expect(report.extraction.skipped.length).toBeGreaterThan(0)
	})
})
