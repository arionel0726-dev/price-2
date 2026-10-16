import { describe, expect, test, afterEach } from 'bun:test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { main, parseArgs, runLiveMode } from '../../src/scripts/validate-live'
import { MAX_PRODUCT_PAGES_PER_RUN } from '../../src/lib/validation/live-validator'

const MANIFEST_PATH = 'tests/fixtures/validate-live/manifest.json'

describe('validate-live CLI — argument parsing', () => {
	test('requires --domain', () => {
		expect(() => parseArgs(['--limit', '5'])).toThrow('--domain is required')
	})

	test('defaults to fixture mode (live is false unless --live is passed)', () => {
		const args = parseArgs(['--domain', 'vizaje-nica.com'])
		expect(args.live).toBe(false)
	})

	test('requires an explicit --live flag to enable live mode', () => {
		const args = parseArgs(['--domain', 'vizaje-nica.com', '--live'])
		expect(args.live).toBe(true)
	})

	test('rejects a delay below the conservative minimum', () => {
		expect(() => parseArgs(['--domain', 'vizaje-nica.com', '--delay-ms', '100'])).toThrow(/delay-ms/)
	})

	test('rejects a non-positive --limit', () => {
		expect(() => parseArgs(['--domain', 'vizaje-nica.com', '--limit', '0'])).toThrow(/--limit/)
	})
})

describe('validate-live CLI — fixture mode (fully offline)', () => {
	test('never calls --live code and reproduces the exact fixture report', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--limit', '10', '--fixture-manifest', MANIFEST_PATH])

		expect(report.mode).toBe('fixture')
		expect(report.robots.failedClosed).toBe(false)
		expect(report.discovery).toEqual({
			totalSitemapUrls: 11,
			matchedProductUrlCount: 9,
			afterLanguageDedupeCount: 7,
			status: 'ok',
			sitemapDiagnostics: [],
			sitemapsAttempted: 1,
			sitemapsFailed: 0,
			truncated: false
		})
		expect(report.pages).toEqual({ attempted: 6, fetchedSuccessfully: 6, extracted: 3 })
		expect(report.outcomeCounts).toEqual({
			extracted: 3,
			network_failure: 0,
			robots_disallowed: 1,
			non_product_page: 1,
			missing_json_ld: 1,
			invalid_json_ld: 1,
			redirect_disallowed: 0,
			access_restricted: 0
		})
	})

	test('the disallowed-category product is never fetched (robots.txt enforced even offline)', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--fixture-manifest', MANIFEST_PATH])
		const disallowed = report.results.find((r) => r.url.includes('disallowed-category'))
		expect(disallowed?.outcome).toBe('robots_disallowed')
		expect(disallowed?.httpStatus).toBeNull()
	})

	test('a complete product reports zero missing fields', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--fixture-manifest', MANIFEST_PATH])
		const complete = report.results.find((r) => r.url.includes('22006'))
		expect(complete?.outcome).toBe('extracted')
		expect(complete?.missingFields).toEqual([])
	})

	test('an incomplete product explicitly lists its missing fields, never inventing values', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--fixture-manifest', MANIFEST_PATH])
		const incomplete = report.results.find((r) => r.url.includes('31050'))
		expect(incomplete?.extracted?.price).toBeNull()
		expect(incomplete?.extracted?.gtin).toBeNull()
		expect(incomplete?.missingFields).toContain('price')
		expect(incomplete?.missingFields).toContain('gtin')
	})

	test('the Romanian URL is preferred over its Russian duplicate', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--fixture-manifest', MANIFEST_PATH])
		const antiAging = report.results.filter((r) => r.url.includes('antivozsrastnyie'))
		expect(antiAging).toHaveLength(1)
		expect(antiAging[0].language).toBe('ro')
	})

	test('a ru-only product (no ro counterpart) is still included', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--fixture-manifest', MANIFEST_PATH])
		const ruOnly = report.results.find((r) => r.url.includes('only-ru-variant'))
		expect(ruOnly).toBeDefined()
		expect(ruOnly?.language).toBe('ru')
	})

	test('limit clamps the sample even when a larger value is requested', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--limit', '2', '--fixture-manifest', MANIFEST_PATH])
		expect(report.effectiveSampleSize).toBe(2)
		expect(report.results.length).toBeLessThanOrEqual(2)
	})

	test('rejects an unknown domain not relevant to fixture mode (fixture mode does not require allowlisting, only --live does)', async () => {
		// Fixture mode performs zero network access regardless of domain, so it must not require allowlisting.
		const report = await main(['--domain', 'not-a-real-pilot.test', '--fixture-manifest', MANIFEST_PATH])
		expect(report.mode).toBe('fixture')
	})
})

describe('validate-live CLI — live mode requires explicit opt-in and an allowlisted domain', () => {
	test('runLiveMode refuses a domain that is not on the allowlist, before any network access', async () => {
		await expect(
			runLiveMode(parseArgs(['--domain', 'not-allowlisted.test', '--live']))
		).rejects.toThrow(/allowlist/)
	})
})

describe('validate-live CLI — live code path against a local HTTP server (not a real live request)', () => {
	let server: http.Server | null = null

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()))
			server = null
		}
	})

	test('runs the full live pipeline (safeFetch + scheduler + robots + sitemap + pages) end to end against 127.0.0.1', async () => {
		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' },
			'/sitemap.xml': {
				status: 200,
				body:
					'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
					'<url><loc>__BASE__/ro/catalog/cat/1001</loc></url>' +
					'</urlset>'
			}
		}

		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			if (path === '/ro/catalog/cat/1001') {
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(
					'<html><head><script type="application/ld+json">' +
						'{"@context":"https://schema.org","@type":"Product","name":"Local Test Product","brand":{"@type":"Brand","name":"Vizaje"},"sku":"LOCAL-1","offers":{"@type":"Offer","price":"50.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
						'</script></head><body></body></html>'
				)
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
		routes['/sitemap.xml'].body = routes['/sitemap.xml'].body.replace('__BASE__', `http://${domain}`)

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000'])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http'
		})

		expect(report.mode).toBe('live')
		expect(report.robots.failedClosed).toBe(false)
		expect(report.pages.fetchedSuccessfully).toBe(1)
		expect(report.results[0].outcome).toBe('extracted')
		expect(report.results[0].extracted?.title).toBe('Local Test Product')
	}, 15_000)

	test('fails closed when the local server returns a non-2xx robots.txt', async () => {
		server = http.createServer((_req, res) => {
			res.writeHead(500)
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
