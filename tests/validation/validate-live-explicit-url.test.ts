import { afterEach, describe, expect, test } from 'bun:test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { vizajeNicaStoreProfile } from '../../src/lib/discovery/stores/vizaje-nica'
import { main, parseArgs, runFixtureMode, runLiveMode } from '../../src/scripts/validate-live'

const OVICO_MAGENTO_MANIFEST = 'tests/fixtures/validate-live-ovico/manifest-magento.json'
const OVICO_MANIFEST = 'tests/fixtures/validate-live-ovico/manifest.json'
const VIZAJE_MANIFEST = 'tests/fixtures/validate-live/manifest.json'

const OVICO_PRODUCT_URL = 'https://ovico.md/ru/avignon-edt-50ml-vapo'
const VIZAJE_PRODUCT_URL = 'https://vizaje-nica.com/ro/catalog/antivozsrastnyie-sredstva-dlya-litsa/22006'

describe('validate-live --url — fully offline explicit product URL validation (Task 7.3)', () => {
	test('a valid Ovico product URL is extracted via --url, and the report explicitly reports discovery as skipped', async () => {
		const report = await main(['--domain', 'ovico.md', '--url', OVICO_PRODUCT_URL, '--fixture-manifest', OVICO_MAGENTO_MANIFEST])

		expect(report.mode).toBe('fixture')
		expect(report.discovery).toEqual({
			totalSitemapUrls: 0,
			matchedProductUrlCount: 1,
			afterLanguageDedupeCount: 1,
			status: 'skipped',
			sitemapDiagnostics: [],
			sitemapsAttempted: 0,
			sitemapsFailed: 0,
			truncated: false
		})
		expect(report.effectiveSampleSize).toBe(1)
		expect(report.results).toHaveLength(1)
		expect(report.results[0].url).toBe(OVICO_PRODUCT_URL)
		expect(report.results[0].outcome).toBe('extracted')
		expect(report.results[0].extracted?.title).toBe('Avignon EDT 50ml Vapo')
		expect(report.results[0].extracted?.sku).toBe('OVC-AVG-50EDT')
	})

	test('a valid Vizaje-Nica product URL is extracted via --url, and the report explicitly reports discovery as skipped', async () => {
		const report = await main(['--domain', 'vizaje-nica.com', '--url', VIZAJE_PRODUCT_URL, '--fixture-manifest', VIZAJE_MANIFEST])

		expect(report.mode).toBe('fixture')
		expect(report.discovery.status).toBe('skipped')
		expect(report.discovery.totalSitemapUrls).toBe(0)
		expect(report.results).toHaveLength(1)
		expect(report.results[0].outcome).toBe('extracted')
		expect(report.results[0].missingFields).toEqual([])
	})

	test('a cross-store URL (host does not match --domain) is rejected before any fixture is read', async () => {
		await expect(
			main(['--domain', 'ovico.md', '--url', VIZAJE_PRODUCT_URL, '--fixture-manifest', OVICO_MAGENTO_MANIFEST])
		).rejects.toThrow(/does not match --domain/)
	})

	test('a URL that fails the store profile product classifier (a confirmed category URL) is rejected, never fetched', async () => {
		await expect(
			main(['--domain', 'ovico.md', '--url', 'https://ovico.md/ru/dekorativnaja-kosmetika', '--fixture-manifest', OVICO_MAGENTO_MANIFEST])
		).rejects.toThrow(/product-page classifier/)
	})

	test('a non-HTTPS --url is rejected', async () => {
		await expect(
			main(['--domain', 'ovico.md', '--url', 'http://ovico.md/ru/avignon-edt-50ml-vapo', '--fixture-manifest', OVICO_MAGENTO_MANIFEST])
		).rejects.toThrow(/must use https:\/\//)
	})

	test('a --url containing credentials is rejected', async () => {
		await expect(
			main([
				'--domain',
				'ovico.md',
				'--url',
				'https://user:pass@ovico.md/ru/avignon-edt-50ml-vapo',
				'--fixture-manifest',
				OVICO_MAGENTO_MANIFEST
			])
		).rejects.toThrow(/credentials/)
	})

	test('a --url containing a fragment is rejected', async () => {
		await expect(
			main([
				'--domain',
				'ovico.md',
				'--url',
				'https://ovico.md/ru/avignon-edt-50ml-vapo#reviews',
				'--fixture-manifest',
				OVICO_MAGENTO_MANIFEST
			])
		).rejects.toThrow(/fragment/)
	})

	test('a malformed --url is rejected', async () => {
		await expect(main(['--domain', 'ovico.md', '--url', 'not a url at all', '--fixture-manifest', OVICO_MAGENTO_MANIFEST])).rejects.toThrow(
			/well-formed absolute URL/
		)
	})

	test('--url without --live still runs in fixture mode, never attempting a live request', async () => {
		const args = parseArgs(['--domain', 'ovico.md', '--url', OVICO_PRODUCT_URL, '--fixture-manifest', OVICO_MAGENTO_MANIFEST])
		expect(args.live).toBe(false)

		const report = await runFixtureMode(args)
		expect(report.mode).toBe('fixture')
		expect(report.results[0].outcome).toBe('extracted')
	})

	test('--url honors robots.txt: a disallowed path is never fetched even offline', async () => {
		const report = await main([
			'--domain',
			'ovico.md',
			'--url',
			'https://ovico.md/ru/discontinued-product-99ml',
			'--fixture-manifest',
			OVICO_MANIFEST
		])

		expect(report.results).toHaveLength(1)
		expect(report.results[0].outcome).toBe('robots_disallowed')
		expect(report.results[0].httpStatus).toBeNull()
		expect(report.results[0].extracted).toBeNull()
	})

	test('existing sitemap-based fixture mode is unaffected when --url is absent (regression)', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', OVICO_MAGENTO_MANIFEST])
		expect(report.discovery.status).toBe('ok')
		expect(report.discovery.totalSitemapUrls).toBeGreaterThan(0)
		const available = report.results.find((r) => r.url === OVICO_PRODUCT_URL)
		expect(available?.outcome).toBe('extracted')
	})
})

describe('validate-live --url — live mode (local HTTP server, Task 7.3)', () => {
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

	test('rejects an unknown/non-allowlisted domain before any network access', async () => {
		await expect(
			runLiveMode(parseArgs(['--domain', 'not-allowlisted.test', '--live', '--url', 'https://not-allowlisted.test/ro/catalog/cat/1']))
		).rejects.toThrow(/allowlist/)
	})

	test('production live --url rejects an allowlisted domain that has no EXPLICITLY REGISTERED store profile — no silent Vizaje-Nica fallback (follow-up safety review §1)', async () => {
		// "www.ovico.md" is on the production live-validation allowlist
		// (src/lib/net/allowlist.ts) but is NOT a key in the store profile
		// registry (src/lib/discovery/stores/registry.ts — only the bare
		// "ovico.md" is registered). Before this safety review, --url mode
		// would have silently matched this against vizaje-nica.com's generic
		// /catalog/<category>/<id> pattern instead of refusing it outright.
		// No overrides are used here — this exercises the real production
		// allowlist and registry, never touching the network because the
		// rejection happens before the scheduler or any socket is created.
		const args = parseArgs(['--domain', 'www.ovico.md', '--live', '--url', 'https://www.ovico.md/ru/some-product'])
		await expect(runLiveMode(args)).rejects.toThrow(/explicitly registered store profile/)
	})

	test('a test that supplies overrides.storeProfile explicitly still works end to end, proving the test-only override is real (not just "any profile" silently accepted) (follow-up safety review §2)', async () => {
		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' }
		}
		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			if (path === '/ru/avignon-edt-50ml-vapo') {
				res.writeHead(404)
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

		// This URL's shape (/ru/<slug>) only matches ovico.md's classifier,
		// never vizaje-nica.com's /catalog/<category>/<id> pattern — so this
		// only passes the classifier check if the test's explicit
		// overrides.storeProfile (ovicoMdStoreProfile) is actually the one
		// consulted, proving the override is wired through and not silently
		// ignored in favor of some other default.
		const { ovicoMdStoreProfile } = await import('../../src/lib/discovery/stores/registry')
		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000', '--url', `http://${domain}/ru/avignon-edt-50ml-vapo`])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			storeProfile: ovicoMdStoreProfile
		})

		// The page 404s (deliberately — this test only needs to prove the
		// classifier/profile resolution, not a full extraction), but the URL
		// must have been ACCEPTED (not rejected for failing the classifier)
		// and robots.txt/the page must have actually been requested.
		expect(report.results).toHaveLength(1)
		expect(report.results[0].outcome).toBe('network_failure')
		expect(report.results[0].httpStatus).toBe(404)
	}, 15_000)

	test('explicit --url mode never fetches sitemap files, even when a conspicuous /sitemap.xml route is available to request', async () => {
		let sitemapWasRequested = false
		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' },
			'/sitemap.xml': {
				status: 200,
				body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
			}
		}
		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			if (path === '/sitemap.xml') sitemapWasRequested = true
			if (path === '/ro/catalog/cat/6006') {
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(
					'<html><head><script type="application/ld+json">' +
						'{"@context":"https://schema.org","@type":"Product","name":"No Sitemap Needed","brand":{"@type":"Brand","name":"Vizaje"},"sku":"NOSITEMAP-1","offers":{"@type":"Offer","price":"5.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
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

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000', '--url', `http://${domain}/ro/catalog/cat/6006`])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			storeProfile: vizajeNicaStoreProfile
		})

		expect(report.results[0].outcome).toBe('extracted')
		expect(report.discovery.status).toBe('skipped')
		expect(report.discovery.sitemapsAttempted).toBe(0)
		expect(report.discovery.totalSitemapUrls).toBe(0)
		expect(sitemapWasRequested).toBe(false)
	}, 15_000)

	test('a genuine product page is extracted end-to-end via --url, routed through safeFetch + the DomainScheduler', async () => {
		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' }
		}
		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			if (path === '/ro/catalog/cat/1001') {
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(
					'<html><head><script type="application/ld+json">' +
						'{"@context":"https://schema.org","@type":"Product","name":"Explicit URL Product","brand":{"@type":"Brand","name":"Vizaje"},"sku":"EXPLICIT-1","offers":{"@type":"Offer","price":"30.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
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

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000', '--url', `http://${domain}/ro/catalog/cat/1001`])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			storeProfile: vizajeNicaStoreProfile
		})

		expect(report.mode).toBe('live')
		expect(report.discovery.status).toBe('skipped')
		expect(report.results).toHaveLength(1)
		expect(report.results[0].outcome).toBe('extracted')
		expect(report.results[0].extracted?.title).toBe('Explicit URL Product')
	}, 15_000)

	test('a --url whose scheme does not match the live protocol is rejected before any network access', async () => {
		server = http.createServer((_req, res) => {
			res.writeHead(200)
			res.end()
		})
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
		const { port } = server!.address() as AddressInfo
		const domain = `127.0.0.1:${port}`

		// Live test server speaks plain HTTP, but --url claims https:// — must
		// be rejected rather than silently downgraded or upgraded.
		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000', '--url', `https://${domain}/ro/catalog/cat/1001`])
		await expect(runLiveMode(args, { allowlist: new Set([domain]), allowPrivateNetworks: true, protocol: 'http' })).rejects.toThrow(
			/must use http:\/\//
		)
	})

	test('honors robots.txt Crawl-delay before fetching the explicit product page', async () => {
		const requestTimestamps: Record<string, number> = {}
		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\nCrawl-delay: 2\n' }
		}
		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			requestTimestamps[path] = Date.now()
			if (path === '/ro/catalog/cat/3003') {
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(
					'<html><head><script type="application/ld+json">' +
						'{"@context":"https://schema.org","@type":"Product","name":"Delay Test Product","brand":{"@type":"Brand","name":"Vizaje"},"sku":"DLY-URL-1","offers":{"@type":"Offer","price":"15.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
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

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000', '--url', `http://${domain}/ro/catalog/cat/3003`])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			storeProfile: vizajeNicaStoreProfile
		})

		expect(report.results[0].outcome).toBe('extracted')

		const robotsAt = requestTimestamps['/robots.txt']
		const productAt = requestTimestamps['/ro/catalog/cat/3003']
		expect(productAt - robotsAt).toBeGreaterThanOrEqual(1900)
	}, 15_000)

	test('robots.txt disallow for the explicit path is honored — the page is never fetched', async () => {
		const routes: Record<string, { status: number; body: string; contentType?: string }> = {
			'/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /ro/catalog/cat/4004\nAllow: /\n' }
		}
		let productWasFetched = false
		server = http.createServer((req, res) => {
			const path = req.url ?? '/'
			if (path === '/ro/catalog/cat/4004') {
				productWasFetched = true
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end('<html><body>should never be reached</body></html>')
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

		const args = parseArgs(['--domain', domain, '--live', '--delay-ms', '1000', '--url', `http://${domain}/ro/catalog/cat/4004`])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			storeProfile: vizajeNicaStoreProfile
		})

		expect(report.results[0].outcome).toBe('robots_disallowed')
		expect(report.results[0].httpStatus).toBeNull()
		expect(productWasFetched).toBe(false)
	}, 15_000)

	test('a redirect from the explicit URL to a disallowed host is reported redirect_disallowed, never extracted', async () => {
		evilServer = http.createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' })
			res.end(
				'<html><head><script type="application/ld+json">' +
					'{"@context":"https://schema.org","@type":"Product","name":"Should never be trusted","brand":{"@type":"Brand","name":"Evil"},"sku":"EVIL-URL-1","offers":{"@type":"Offer","price":"1.00","priceCurrency":"MDL","availability":"https://schema.org/InStock"}}' +
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
			if (path === '/ro/catalog/redirect-url-test/5005') {
				res.writeHead(302, { location: `http://${evilHost}/ro/catalog/redirect-url-test/5005` })
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

		const args = parseArgs([
			'--domain',
			domain,
			'--live',
			'--delay-ms',
			'1000',
			'--url',
			`http://${domain}/ro/catalog/redirect-url-test/5005`
		])
		const report = await runLiveMode(args, {
			allowlist: new Set([domain]),
			allowPrivateNetworks: true,
			protocol: 'http',
			storeProfile: vizajeNicaStoreProfile
		})

		expect(report.results[0].outcome).toBe('redirect_disallowed')
		expect(report.results[0].extracted).toBeNull()
	}, 15_000)
})
