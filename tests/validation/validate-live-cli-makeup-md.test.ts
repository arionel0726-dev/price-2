import { describe, expect, test, afterEach } from 'bun:test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { main, parseArgs, runLiveMode } from '../../src/scripts/validate-live'

const MANIFEST_PATH = 'tests/fixtures/validate-live-makeup-md/manifest.json'
const ACCESS_RESTRICTED_MANIFEST_PATH = 'tests/fixtures/validate-live-makeup-md/manifest-access-restricted.json'

describe('validate-live CLI — makeup.md fixture mode (fully offline, unverified classifier)', () => {
	test('discovers through the nested sitemap index and reproduces the exact fixture report', async () => {
		const report = await main(['--domain', 'makeup.md', '--limit', '10', '--fixture-manifest', MANIFEST_PATH])

		expect(report.mode).toBe('fixture')
		expect(report.robots.failedClosed).toBe(false)
		expect(report.discovery).toEqual({
			totalSitemapUrls: 12,
			matchedProductUrlCount: 9,
			afterLanguageDedupeCount: 8,
			status: 'ok',
			sitemapDiagnostics: [],
			sitemapsAttempted: 2,
			sitemapsFailed: 0,
			truncated: false
		})
		expect(report.pages).toEqual({ attempted: 7, fetchedSuccessfully: 7, extracted: 4 })
		expect(report.outcomeCounts).toEqual({
			extracted: 4,
			network_failure: 0,
			robots_disallowed: 1,
			non_product_page: 1,
			missing_json_ld: 1,
			invalid_json_ld: 1,
			redirect_disallowed: 0,
			access_restricted: 0
		})
	})

	test('category pages, search, and cart are never classified as product candidates', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		expect(report.results.some((r) => r.url.includes('/catalog/machiaj'))).toBe(false)
		expect(report.results.some((r) => r.url.includes('/search'))).toBe(false)
		expect(report.results.some((r) => r.url.includes('/cart'))).toBe(false)
	})

	test('the disallowed product path is blocked by robots.txt and never fetched', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const disallowed = report.results.find((r) => r.url.includes('discontinued-item'))
		expect(disallowed?.outcome).toBe('robots_disallowed')
		expect(disallowed?.httpStatus).toBeNull()
	})

	test('a complete product with a valid GTIN reports zero missing fields', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const complete = report.results.find((r) => r.url.includes('ruj-mat-catrice-010'))
		expect(complete?.outcome).toBe('extracted')
		expect(complete?.extracted?.gtin).toBe('5901234123457')
		expect(complete?.missingFields).toEqual([])
	})

	test('a product with no GTIN in its JSON-LD reports gtin as missing, never fabricating one', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const missingGtin = report.results.find((r) => r.url.includes('rimel-maybelline-24h'))
		expect(missingGtin?.outcome).toBe('extracted')
		expect(missingGtin?.extracted?.gtin).toBeNull()
		expect(missingGtin?.missingFields).toContain('gtin')
	})

	test('a product with a GTIN that fails the GS1 checksum is treated as missing, never trusted as-is', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const invalidGtin = report.results.find((r) => r.url.includes('fond-de-ten-loreal-030'))
		expect(invalidGtin?.outcome).toBe('extracted')
		expect(invalidGtin?.extracted?.gtin).toBeNull()
		expect(invalidGtin?.missingFields).toContain('gtin')
	})

	test('the utm_source duplicate of the same product is merged into a single result', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const fondDeTen = report.results.filter((r) => r.url.includes('fond-de-ten-loreal-030'))
		expect(fondDeTen).toHaveLength(1)
	})

	test('a multi-variant product page extracts the first declared variant without conflating the others', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const multiVariant = report.results.find((r) => r.url.includes('parfum-chanel-no5-multi'))
		expect(multiVariant?.outcome).toBe('extracted')
		expect(multiVariant?.extracted?.gtin).toBe('5901234123457')
	})

	test('a page with no JSON-LD at all is reported as missing_json_ld, not extracted', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const noJsonLd = report.results.find((r) => r.url.includes('no-jsonld-sample'))
		expect(noJsonLd?.outcome).toBe('missing_json_ld')
		expect(noJsonLd?.extracted).toBeNull()
	})

	test('a page with malformed JSON-LD is reported as invalid_json_ld, not extracted', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const malformed = report.results.find((r) => r.url.includes('malformed-jsonld-sample'))
		expect(malformed?.outcome).toBe('invalid_json_ld')
		expect(malformed?.extracted).toBeNull()
	})

	test('a non-Product page (CollectionPage) that slipped past the classifier is reported as non_product_page', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', MANIFEST_PATH])
		const category = report.results.find((r) => r.url.includes('machiaj-not-a-product'))
		expect(category?.outcome).toBe('non_product_page')
		expect(category?.extracted).toBeNull()
	})
})

describe('validate-live CLI — makeup.md discovery failure (sitemap cannot be found/parsed)', () => {
	test('a 404/malformed sitemap yields a clear discovery_failed diagnostic rather than silently crawling', async () => {
		const brokenManifestPath = 'tests/fixtures/validate-live-makeup-md/manifest-broken-sitemap.json'
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', brokenManifestPath])
		expect(report.discovery.status).toBe('discovery_failed')
		expect(report.discovery.totalSitemapUrls).toBe(0)
		expect(report.discovery.sitemapDiagnostics.length).toBeGreaterThan(0)
		expect(report.pages.attempted).toBe(0)
	})
})

describe('validate-live CLI — redirects to a disallowed host are refused, not silently followed (store-agnostic mechanism, exercised via a local server since makeup.md is not DNS-resolvable here)', () => {
	let server: http.Server | null = null
	let evilServer: http.Server | null = null

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()))
			server = null
		}
		if (evilServer) {
			await new Promise<void>((resolve) => evilServer!.close(() => resolve()))
			evilServer = null
		}
	})

	test('a product page that redirects to a non-allowlisted host is reported as redirect_disallowed, never extracted', async () => {
		evilServer = http.createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' })
			res.end(
				'<html><head><script type="application/ld+json">' +
					'{"@context":"https://schema.org","@type":"Product","name":"Should never be trusted","brand":{"@type":"Brand","name":"Evil"},"sku":"EVIL-1","offers":{"@type":"Offer","price":"1.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
					'</script></head><body></body></html>'
			)
		})
		await new Promise<void>((resolve) => evilServer!.listen(0, '127.0.0.1', () => resolve()))
		const evilPort = (evilServer!.address() as AddressInfo).port
		const evilHost = `127.0.0.1:${evilPort}`

		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' }
		}

		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			if (path === '/ro/catalog/redirect-test/9999') {
				res.writeHead(302, { location: `http://${evilHost}/ro/catalog/redirect-test/9999` })
				res.end()
				return
			}
			const route = routes[path]
			if (!route) {
				res.writeHead(404)
				res.end()
				return
			}
			res.writeHead(route.status, { 'content-type': route.contentType ?? 'text/plain' })
			res.end(route.body)
		})

		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
		const { port } = server!.address() as AddressInfo
		const domain = `127.0.0.1:${port}`
		routes['/sitemap.xml'] = {
			status: 200,
			body:
				'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<url><loc>http://${domain}/ro/catalog/redirect-test/9999</loc></url>` +
				'</urlset>'
		}

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000'])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http'
		})

		expect(report.mode).toBe('live')
		expect(report.results[0].outcome).toBe('redirect_disallowed')
		expect(report.results[0].extracted).toBeNull()
	}, 15_000)
})

describe('validate-live CLI — makeup.md fails closed when robots.txt cannot be obtained', () => {
	let server: http.Server | null = null

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()))
			server = null
		}
	})

	test('a non-2xx robots.txt response means nothing is assumed allowed, zero pages attempted', async () => {
		server = http.createServer((_req, res) => {
			res.writeHead(503)
			res.end()
		})
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
		const { port } = server!.address() as AddressInfo
		const domain = `127.0.0.1:${port}`

		const args = parseArgs(['--domain', domain, '--live'])
		const report = await runLiveMode(args, { allowlist: new Set([domain]), allowPrivateNetworks: true, protocol: 'http' })

		expect(report.robots.failedClosed).toBe(true)
		expect(report.pages.attempted).toBe(0)
	}, 15_000)
})

describe('validate-live CLI — makeup.md access-restricted (AWS WAF challenge) responses (Task 6.2)', () => {
	test('a confirmed AWS WAF JavaScript challenge is reported as access_restricted, never missing_json_ld, and never stored as extracted product data', async () => {
		const report = await main(['--domain', 'makeup.md', '--fixture-manifest', ACCESS_RESTRICTED_MANIFEST_PATH])

		expect(report.pages.fetchedSuccessfully).toBe(2)
		expect(report.pages.extracted).toBe(0)
		expect(report.outcomeCounts.access_restricted).toBe(2)
		expect(report.outcomeCounts.missing_json_ld).toBe(0)
		expect(report.outcomeCounts.extracted).toBe(0)

		for (const result of report.results) {
			expect(result.outcome).toBe('access_restricted')
			expect(result.extracted).toBeNull()
			expect(result.errorMessage).toContain('AWS WAF')
		}
	})
})
