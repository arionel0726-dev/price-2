import { describe, expect, test } from 'bun:test'
import { MAX_PRODUCT_PAGES_PER_RUN, validateLiveDomain } from '../../src/lib/validation/live-validator'
import type { RobotsPageFetch } from '../../src/lib/net/robots-fetch'

const SITEMAP_URL = 'https://example.test/sitemap.xml'
const ROBOTS_URL = 'https://example.test/robots.txt'

function sitemapWithProductCount(n: number): string {
	const urls = Array.from({ length: n }, (_, i) => `<url><loc>https://example.test/ro/catalog/cat/${1000 + i}</loc></url>`).join('\n')
	return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
}

function productHtml(title: string): string {
	return `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${title}","brand":{"@type":"Brand","name":"Vizaje"},"sku":"SKU-1","offers":{"@type":"Offer","price":"10.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}</script></head><body></body></html>`
}

function buildFetchText(opts: { sitemap: string; robots: RobotsPageFetch; pageFor: (url: string) => RobotsPageFetch }) {
	return async (url: string): Promise<RobotsPageFetch> => {
		if (url === SITEMAP_URL) return { status: 200, body: opts.sitemap }
		if (url === ROBOTS_URL) return opts.robots
		return opts.pageFor(url)
	}
}

describe('validateLiveDomain — limit enforcement', () => {
	test('clamps effectiveSampleSize to the hard cap even when requestedSampleSize exceeds it', async () => {
		const fetchText = buildFetchText({
			sitemap: sitemapWithProductCount(30),
			robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
			pageFor: () => ({ status: 200, body: productHtml('X') })
		})

		const report = await validateLiveDomain({
			domain: 'example.test',
			mode: 'fixture',
			requestedSampleSize: 999,
			userAgent: 'test-bot',
			sitemapEntryUrl: SITEMAP_URL,
			robotsUrl: ROBOTS_URL,
			fetchText
		})

		expect(report.requestedSampleSize).toBe(999)
		expect(report.effectiveSampleSize).toBe(MAX_PRODUCT_PAGES_PER_RUN)
		expect(report.pages.attempted).toBeLessThanOrEqual(MAX_PRODUCT_PAGES_PER_RUN)
		expect(report.results.length).toBeLessThanOrEqual(MAX_PRODUCT_PAGES_PER_RUN)
	})

	test('never fetches more pages than the discovered sample, even when below the cap', async () => {
		const fetchText = buildFetchText({
			sitemap: sitemapWithProductCount(3),
			robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
			pageFor: () => ({ status: 200, body: productHtml('X') })
		})

		const report = await validateLiveDomain({
			domain: 'example.test',
			mode: 'fixture',
			requestedSampleSize: 10,
			userAgent: 'test-bot',
			sitemapEntryUrl: SITEMAP_URL,
			robotsUrl: ROBOTS_URL,
			fetchText
		})

		expect(report.pages.attempted).toBe(3)
	})
})

describe('validateLiveDomain — robots fail-closed', () => {
	test('aborts before discovering or fetching any page when robots.txt cannot be obtained', async () => {
		const fetchText = buildFetchText({
			sitemap: sitemapWithProductCount(5),
			robots: { status: 503, body: '' },
			pageFor: () => ({ status: 200, body: productHtml('X') })
		})

		const report = await validateLiveDomain({
			domain: 'example.test',
			mode: 'fixture',
			requestedSampleSize: 5,
			userAgent: 'test-bot',
			sitemapEntryUrl: SITEMAP_URL,
			robotsUrl: ROBOTS_URL,
			fetchText
		})

		expect(report.robots.failedClosed).toBe(true)
		expect(report.pages.attempted).toBe(0)
		expect(report.discovery.totalSitemapUrls).toBe(0)
		expect(report.results).toEqual([])
	})

	test('does not fetch a page whose path is disallowed by robots.txt', async () => {
		let disallowedWasFetched = false
		const fetchText = buildFetchText({
			sitemap: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.test/ro/catalog/cart/1</loc></url></urlset>',
			robots: { status: 200, body: 'User-agent: *\nDisallow: /ro/catalog/cart/\n' },
			pageFor: (url) => {
				if (url.includes('/cart/')) disallowedWasFetched = true
				return { status: 200, body: productHtml('X') }
			}
		})

		const report = await validateLiveDomain({
			domain: 'example.test',
			mode: 'fixture',
			requestedSampleSize: 5,
			userAgent: 'test-bot',
			sitemapEntryUrl: SITEMAP_URL,
			robotsUrl: ROBOTS_URL,
			fetchText
		})

		expect(disallowedWasFetched).toBe(false)
		expect(report.results[0].outcome).toBe('robots_disallowed')
		expect(report.pages.attempted).toBe(0)
	})
})

describe('validateLiveDomain — network failures', () => {
	test('reports a network_failure outcome without crashing the whole run', async () => {
		const fetchText = buildFetchText({
			sitemap: sitemapWithProductCount(1),
			robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
			pageFor: () => {
				throw new Error('ECONNRESET')
			}
		})

		const report = await validateLiveDomain({
			domain: 'example.test',
			mode: 'fixture',
			requestedSampleSize: 1,
			userAgent: 'test-bot',
			sitemapEntryUrl: SITEMAP_URL,
			robotsUrl: ROBOTS_URL,
			fetchText
		})

		expect(report.results[0].outcome).toBe('network_failure')
		expect(report.pages.fetchedSuccessfully).toBe(0)
	})

	test('treats a non-2xx HTTP status as a network_failure, not a successful extraction', async () => {
		const fetchText = buildFetchText({
			sitemap: sitemapWithProductCount(1),
			robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
			pageFor: () => ({ status: 404, body: '<html>not found</html>' })
		})

		const report = await validateLiveDomain({
			domain: 'example.test',
			mode: 'fixture',
			requestedSampleSize: 1,
			userAgent: 'test-bot',
			sitemapEntryUrl: SITEMAP_URL,
			robotsUrl: ROBOTS_URL,
			fetchText
		})

		expect(report.results[0].outcome).toBe('network_failure')
		expect(report.results[0].httpStatus).toBe(404)
	})
})

describe('validateLiveDomain — never reports missing data as a successful extraction', () => {
	test('a product with no JSON-LD never appears in the extracted count', async () => {
		const fetchText = buildFetchText({
			sitemap: sitemapWithProductCount(1),
			robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
			pageFor: () => ({ status: 200, body: '<html><body>no structured data</body></html>' })
		})

		const report = await validateLiveDomain({
			domain: 'example.test',
			mode: 'fixture',
			requestedSampleSize: 1,
			userAgent: 'test-bot',
			sitemapEntryUrl: SITEMAP_URL,
			robotsUrl: ROBOTS_URL,
			fetchText
		})

		expect(report.pages.extracted).toBe(0)
		expect(report.results[0].outcome).toBe('missing_json_ld')
		expect(report.results[0].extracted).toBeNull()
	})
})
