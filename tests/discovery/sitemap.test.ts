import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverSitemapUrls, parseSitemapXml } from '../../src/lib/discovery/sitemap'

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures', 'sitemaps')

/** Maps a sitemap URL on the fake `shop.example.test` domain to its local fixture file. */
function fixtureFetcher(overrides: Record<string, string> = {}) {
	return async (url: string): Promise<string> => {
		const path = new URL(url).pathname.split('/').pop()!
		if (overrides[path]) return overrides[path]
		const filePath = join(FIXTURES_DIR, path)
		return readFileSync(filePath, 'utf-8')
	}
}

describe('parseSitemapXml', () => {
	test('parses a standard urlset sitemap', () => {
		const xml = readFileSync(join(FIXTURES_DIR, 'standard-sitemap.xml'), 'utf-8')
		const result = parseSitemapXml(xml)
		expect(result.kind).toBe('urlset')
		if (result.kind === 'urlset') {
			expect(result.locs).toHaveLength(4)
			expect(result.locs).toContain('https://shop.example.test/products/rose-eau-de-parfum-50ml')
		}
	})

	test('parses a sitemap index', () => {
		const xml = readFileSync(join(FIXTURES_DIR, 'sitemap-index.xml'), 'utf-8')
		const result = parseSitemapXml(xml)
		expect(result.kind).toBe('sitemapindex')
		if (result.kind === 'sitemapindex') {
			expect(result.locs).toEqual([
				'https://shop.example.test/sitemaps/nested-sitemap-1.xml',
				'/sitemaps/nested-sitemap-2.xml'
			])
		}
	})

	test('throws a descriptive error for malformed XML', () => {
		const xml = readFileSync(join(FIXTURES_DIR, 'malformed.xml'), 'utf-8')
		expect(() => parseSitemapXml(xml)).toThrow()
	})
})

describe('discoverSitemapUrls', () => {
	test('collects URLs from a standard sitemap and excludes obvious non-page assets', async () => {
		const result = await discoverSitemapUrls(['https://shop.example.test/sitemaps/standard-sitemap.xml'], {
			fetchSitemap: fixtureFetcher()
		})

		expect(result.diagnostics).toHaveLength(0)
		expect(result.sitemapsVisited).toEqual(['https://shop.example.test/sitemaps/standard-sitemap.xml'])
		const urls = result.urls.map((u) => u.url)
		expect(urls).toContain('https://shop.example.test/products/rose-eau-de-parfum-50ml')
		expect(urls).not.toContain('https://shop.example.test/assets/logo.png')
	})

	test('classifies product-looking paths as "likely" and others as "unknown" without discarding them', async () => {
		const result = await discoverSitemapUrls(['https://shop.example.test/sitemaps/standard-sitemap.xml'], {
			fetchSitemap: fixtureFetcher()
		})

		const product = result.urls.find((u) => u.url.includes('/products/rose-eau-de-parfum-50ml'))
		const category = result.urls.find((u) => u.url.includes('/category/perfume'))
		expect(product?.candidateConfidence).toBe('likely')
		expect(category?.candidateConfidence).toBe('unknown')
	})

	test('follows a nested sitemap index with relative and absolute references, and dedupes URLs', async () => {
		const result = await discoverSitemapUrls(['https://shop.example.test/sitemaps/sitemap-index.xml'], {
			fetchSitemap: fixtureFetcher()
		})

		expect(result.diagnostics).toHaveLength(0)
		expect(result.sitemapsVisited).toHaveLength(3) // index + 2 nested
		const urls = result.urls.map((u) => u.url)
		expect(urls).toEqual([
			'https://shop.example.test/products/jasmine-body-lotion-200ml',
			'https://shop.example.test/products/sandalwood-soap-100g'
		])
	})

	test('reports malformed XML as a diagnostic without aborting the whole run', async () => {
		const result = await discoverSitemapUrls(['https://shop.example.test/sitemaps/malformed.xml'], {
			fetchSitemap: fixtureFetcher()
		})

		expect(result.urls).toHaveLength(0)
		expect(result.diagnostics).toHaveLength(1)
		expect(result.diagnostics[0].issue).toBe('malformed_xml')
	})

	test('reports fetch failures as a diagnostic', async () => {
		const result = await discoverSitemapUrls(['https://shop.example.test/sitemaps/does-not-exist.xml'], {
			fetchSitemap: async () => {
				throw new Error('404 Not Found')
			}
		})

		expect(result.diagnostics).toHaveLength(1)
		expect(result.diagnostics[0].issue).toBe('fetch_failed')
	})

	test('stops descending once maxDepth is reached and reports it', async () => {
		const result = await discoverSitemapUrls(['https://shop.example.test/sitemaps/depth-chain-0.xml'], {
			fetchSitemap: fixtureFetcher(),
			maxDepth: 2
		})

		// depth-chain-0 (depth 0) -> depth-chain-1 (depth 1) -> depth-chain-2 (depth 2) -> depth-chain-3 (depth 3, blocked)
		expect(result.sitemapsVisited).toHaveLength(3)
		expect(result.urls).toHaveLength(0)
		expect(result.diagnostics.some((d) => d.issue === 'depth_limit_reached')).toBe(true)
	})

	test('stops collecting once maxUrls is reached and marks the result truncated', async () => {
		const result = await discoverSitemapUrls(['https://shop.example.test/sitemaps/standard-sitemap.xml'], {
			fetchSitemap: fixtureFetcher(),
			maxUrls: 1
		})

		expect(result.truncated).toBe(true)
		expect(result.urls).toHaveLength(1)
	})
})
