import { afterEach, describe, expect, test } from 'bun:test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { main, parseArgs, runLiveMode } from '../../src/scripts/validate-live'

const MANIFEST_PATH = 'tests/fixtures/validate-live/manifest.json'
const MAKEUP_MANIFEST_PATH = 'tests/fixtures/validate-live-makeup-md/manifest.json'

describe('validate-live — oversized/partial sitemap handling and candidate diagnostics (Task 6.1)', () => {
	let server: http.Server | null = null

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()))
			server = null
		}
	})

	test('a nested sitemap file exceeding the per-file size cap is recorded as a diagnostic, not silently dropped, and discovery.status becomes partial (never ok)', async () => {
		const oversizedBody = '<urlset>' + 'x'.repeat(2000) + '</urlset>'

		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' }
		}

		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			if (path === '/sitemap-small.xml') {
				const route = routes['/sitemap-small.xml']
				res.writeHead(200, { 'content-type': 'application/xml' })
				res.end(route.body)
				return
			}
			if (path === '/sitemap-oversized.xml') {
				res.writeHead(200, { 'content-type': 'application/xml' })
				res.end(oversizedBody)
				return
			}
			if (path === '/ro/catalog/ok-product/1') {
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(
					'<html><head><script type="application/ld+json">' +
						'{"@context":"https://schema.org","@type":"Product","name":"OK Product","brand":{"@type":"Brand","name":"Vizaje"},"sku":"OK-1","offers":{"@type":"Offer","price":"10.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
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

		routes['/sitemap.xml'] = {
			status: 200,
			body:
				'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<sitemap><loc>${base}/sitemap-small.xml</loc></sitemap>` +
				`<sitemap><loc>${base}/sitemap-oversized.xml</loc></sitemap>` +
				'</sitemapindex>'
		}
		routes['/sitemap-small.xml'] = {
			status: 200,
			body:
				'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<url><loc>${base}/ro/catalog/ok-product/1</loc></url>` +
				'</urlset>'
		}

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000'])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			sitemapLimits: { maxResponseBytes: 500 }
		})

		expect(report.discovery.status).toBe('partial')
		expect(report.discovery.sitemapsAttempted).toBe(3) // index + small + oversized
		expect(report.discovery.sitemapsFailed).toBe(1)
		expect(report.discovery.sitemapDiagnostics.some((d) => d.issue === 'fetch_failed')).toBe(true)
		// The small sitemap's URL was still collected and extracted — one bad
		// nested file never loses the rest of a real, partially-successful run.
		expect(report.discovery.totalSitemapUrls).toBe(1)
		expect(report.results.some((r) => r.outcome === 'extracted')).toBe(true)
	}, 15_000)

	test('the run-wide cumulative sitemap byte budget stops discovery (with a diagnostic) once exceeded, even when every individual file is within its own cap', async () => {
		const routes: Record<string, { status: number; body: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' }
		}

		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			const route = routes[path]
			if (!route) {
				res.writeHead(404)
				res.end()
				return
			}
			res.writeHead(route.status, { 'content-type': 'application/xml' })
			res.end(route.body)
		})

		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
		const { port } = server!.address() as AddressInfo
		const domain = `127.0.0.1:${port}`
		const base = `http://${domain}`

		// Each nested file is comfortably under any per-file cap, but three of
		// them together exceed a small run-wide budget.
		const nestedBody = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
		routes['/sitemap.xml'] = {
			status: 200,
			body:
				'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<sitemap><loc>${base}/n1.xml</loc></sitemap>` +
				`<sitemap><loc>${base}/n2.xml</loc></sitemap>` +
				`<sitemap><loc>${base}/n3.xml</loc></sitemap>` +
				'</sitemapindex>'
		}
		routes['/n1.xml'] = { status: 200, body: nestedBody }
		routes['/n2.xml'] = { status: 200, body: nestedBody }
		routes['/n3.xml'] = { status: 200, body: nestedBody }

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000'])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			// The index body alone is already close to this budget, so by the
			// second or third nested file the cumulative total crosses it.
			sitemapLimits: { maxTotalRunBytes: nestedBody.length + 50 }
		})

		expect(report.discovery.status).not.toBe('ok')
		expect(report.discovery.sitemapsFailed).toBeGreaterThan(0)
		expect(report.discovery.sitemapDiagnostics.some((d) => d.message.includes('run-wide budget'))).toBe(true)
	}, 15_000)
})

describe('candidate URL diagnostics (Task 6.1 §1) — fixture mode, both store profiles', () => {
	test('vizaje-nica.com: candidateDiagnostics reports the verified pattern confidence and a matching reason for every selected URL', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--limit', '10', '--fixture-manifest', MANIFEST_PATH])

		expect(report.candidateDiagnostics.length).toBe(report.results.length)
		for (const diag of report.candidateDiagnostics) {
			expect(diag.patternConfidence).toBe('verified')
			expect(diag.reason).toContain('verified pilot pattern')
		}
		expect(report.candidateDiagnostics.map((d) => d.url)).toEqual(report.results.map((r) => r.url))
	})

	test('makeup.md: candidateDiagnostics reports unverified pattern confidence and never claims a confirmed product match', async () => {
		const report = await main(['--domain', 'makeup.md', '--limit', '10', '--fixture-manifest', MAKEUP_MANIFEST_PATH])

		expect(report.candidateDiagnostics.length).toBeGreaterThan(0)
		for (const diag of report.candidateDiagnostics) {
			expect(diag.patternConfidence).toBe('unverified')
			expect(diag.reason).toContain('UNVERIFIED')
			expect(diag.reason).toContain('not a confirmed product page')
		}
	})
})
