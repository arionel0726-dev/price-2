import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractJsonLdBlocks, filterProductNodes } from '../../src/lib/scraping/jsonld'

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures', 'html')

function loadFixture(name: string): string {
	return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
}

describe('extractJsonLdBlocks', () => {
	test('extracts a single top-level Product node', () => {
		const { nodes, failures } = extractJsonLdBlocks(loadFixture('product-jsonld.html'))
		expect(failures).toHaveLength(0)
		expect(nodes).toHaveLength(1)
		expect(nodes[0]['@type']).toBe('Product')
	})

	test('flattens a Product node nested inside @graph', () => {
		const { nodes } = extractJsonLdBlocks(loadFixture('product-graph.html'))
		const products = filterProductNodes(nodes)
		expect(products).toHaveLength(1)
		expect(products[0].name).toBe('Jasmine Body Lotion')
	})

	test('reports a parse failure for one malformed block but still extracts the valid one', () => {
		const { nodes, failures } = extractJsonLdBlocks(loadFixture('malformed-jsonld.html'))
		expect(failures).toHaveLength(1)
		expect(failures[0].message).toBeTruthy()
		const products = filterProductNodes(nodes)
		expect(products).toHaveLength(1)
		expect(products[0].name).toBe('Chamomile Face Cream')
	})

	test('returns no nodes for a page without structured data', () => {
		const { nodes, failures } = extractJsonLdBlocks(loadFixture('no-structured-data.html'))
		expect(nodes).toHaveLength(0)
		expect(failures).toHaveLength(0)
	})
})
