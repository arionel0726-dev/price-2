import { afterEach, describe, expect, test } from 'bun:test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs, runLiveMode } from '../../src/scripts/validate-live'

describe('validate-live — robots.txt Crawl-delay overrides the CLI --delay-ms default (Task 7 §9)', () => {
	let server: http.Server | null = null

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()))
			server = null
		}
	})

	test('a Crawl-delay longer than --delay-ms is honored, not silently replaced by the shorter CLI default', async () => {
		const requestTimestamps: Record<string, number> = {}

		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			// Crawl-delay deliberately set well above the CLI's own --delay-ms
			// (1000ms, the minimum allowed) to make the override unambiguous.
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\nCrawl-delay: 2\n' }
		}

		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			requestTimestamps[path] = Date.now()
			if (path === '/ro/catalog/cat/1001') {
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(
					'<html><head><script type="application/ld+json">' +
						'{"@context":"https://schema.org","@type":"Product","name":"Delay Test Product","brand":{"@type":"Brand","name":"Vizaje"},"sku":"DLY-1","offers":{"@type":"Offer","price":"10.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
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
		routes['/sitemap.xml'] = {
			status: 200,
			body:
				'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<url><loc>http://${domain}/ro/catalog/cat/1001</loc></url>` +
				'</urlset>'
		}

		// --delay-ms at the allowed minimum (1000ms) — Crawl-delay (2000ms) must
		// still win, proving this is never silently capped at the CLI default.
		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000'])
		const report = await runLiveMode(args, { allowlist: new Set([domain]), allowPrivateNetworks: true, protocol: 'http' })

		expect(report.pages.fetchedSuccessfully).toBe(1)
		expect(report.results[0].outcome).toBe('extracted')

		// robots.txt is always the first request; the sitemap is the second —
		// the >=2000ms Crawl-delay must apply to THIS gap, not the CLI's 1000ms.
		const robotsAt = requestTimestamps['/robots.txt']
		const sitemapAt = requestTimestamps['/sitemap.xml']
		expect(sitemapAt - robotsAt).toBeGreaterThanOrEqual(1900) // small allowance for scheduler jitter
	}, 15_000)

	test('every hop after robots.txt — the sitemap index, a NESTED sitemap, and the product page — shares the same scheduler and honors Crawl-delay (follow-up review §1)', async () => {
		const requestTimestamps: Record<string, number> = {}

		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\nCrawl-delay: 1\n' }
		}

		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			requestTimestamps[path] = Date.now()
			if (path === '/ro/catalog/cat/2002') {
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(
					'<html><head><script type="application/ld+json">' +
						'{"@context":"https://schema.org","@type":"Product","name":"Nested Sitemap Product","brand":{"@type":"Brand","name":"Vizaje"},"sku":"NEST-1","offers":{"@type":"Offer","price":"20.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
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
		const base = `http://${domain}`

		routes['/sitemap-index.xml'] = {
			status: 200,
			body:
				'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<sitemap><loc>${base}/sitemap-nested.xml</loc></sitemap>` +
				'</sitemapindex>'
		}
		routes['/sitemap-nested.xml'] = {
			status: 200,
			body:
				'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<url><loc>${base}/ro/catalog/cat/2002</loc></url>` +
				'</urlset>'
		}

		// --delay-ms at its allowed minimum; Crawl-delay (1000ms) must still be
		// the one actually enforced on every hop below.
		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000', '--sitemap-url', `${base}/sitemap-index.xml`])
		const report = await runLiveMode(args, { allowlist: new Set([domain]), allowPrivateNetworks: true, protocol: 'http' })

		expect(report.pages.fetchedSuccessfully).toBe(1)
		expect(report.results[0].outcome).toBe('extracted')

		const robotsAt = requestTimestamps['/robots.txt']
		const indexAt = requestTimestamps['/sitemap-index.xml']
		const nestedAt = requestTimestamps['/sitemap-nested.xml']
		const productAt = requestTimestamps['/ro/catalog/cat/2002']

		// Every consecutive hop — robots -> index, index -> nested, nested ->
		// product page — must individually respect the ~1000ms Crawl-delay,
		// proving the SAME scheduler/delay governs sitemap and page requests
		// alike, not just the very first one.
		expect(indexAt - robotsAt).toBeGreaterThanOrEqual(900)
		expect(nestedAt - indexAt).toBeGreaterThanOrEqual(900)
		expect(productAt - nestedAt).toBeGreaterThanOrEqual(900)
	}, 15_000)
})
