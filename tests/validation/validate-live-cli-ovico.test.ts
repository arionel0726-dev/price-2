import { describe, expect, test } from 'bun:test'
import { main } from '../../src/scripts/validate-live'

const MANIFEST_PATH = 'tests/fixtures/validate-live-ovico/manifest.json'
const BROKEN_MANIFEST_PATH = 'tests/fixtures/validate-live-ovico/manifest-broken-sitemap.json'

describe('validate-live CLI — ovico.md fixture mode (fully offline, unverified classifier)', () => {
	test('discovers through the nested sitemap index and reproduces the exact fixture report', async () => {
		const report = await main(['--domain', 'ovico.md', '--limit', '10', '--fixture-manifest', MANIFEST_PATH])

		expect(report.mode).toBe('fixture')
		expect(report.robots.failedClosed).toBe(false)
		expect(report.discovery).toEqual({
			totalSitemapUrls: 13,
			matchedProductUrlCount: 10,
			afterLanguageDedupeCount: 9,
			status: 'ok',
			sitemapDiagnostics: [],
			sitemapsAttempted: 2,
			sitemapsFailed: 0,
			truncated: false
		})
		expect(report.pages).toEqual({ attempted: 8, fetchedSuccessfully: 8, extracted: 5 })
		expect(report.outcomeCounts).toEqual({
			extracted: 5,
			network_failure: 0,
			robots_disallowed: 1,
			non_product_page: 1,
			missing_json_ld: 1,
			invalid_json_ld: 1,
			redirect_disallowed: 0,
			access_restricted: 0
		})
	})

	test('known non-product sections (cart, catalog-*) and multi-segment paths are never classified as product candidates', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		expect(report.results.some((r) => r.url.endsWith('/ru/cart'))).toBe(false)
		expect(report.results.some((r) => r.url.includes('catalog-parfumuri'))).toBe(false)
		expect(report.results.some((r) => r.url.includes('/ru/parfumuri/jo-malone-diffuser'))).toBe(false)
	})

	test('the disallowed product path is blocked by robots.txt and never fetched', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const disallowed = report.results.find((r) => r.url.includes('discontinued-product-99ml'))
		expect(disallowed?.outcome).toBe('robots_disallowed')
		expect(disallowed?.httpStatus).toBeNull()
	})

	test('the confirmed real product URL extracts brand, title, SKU, volume, MDL price and availability with zero missing fields except GTIN (unverified/absent)', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const complete = report.results.find((r) => r.url === 'https://ovico.md/ru/jo-malone-london-pine-eucalyptus-diffuser-165ml')
		expect(complete?.outcome).toBe('extracted')
		expect(complete?.extracted?.brand).toBe('Jo Malone London')
		expect(complete?.extracted?.sku).toBe('OVC-16534')
		expect(complete?.extracted?.variant).toBe('165ml')
		expect(complete?.extracted?.price).toBe(1890)
		expect(complete?.extracted?.currency).toBe('MDL')
		expect(complete?.extracted?.availability).toBe('in_stock')
		expect(complete?.extracted?.gtin).toBeNull()
		expect(complete?.missingFields).toEqual(['gtin'])
	})

	test('a purely-numeric store SKU is never interpreted as a GTIN (Task 7 §8)', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const roVariant = report.results.find((r) => r.url === 'https://ovico.md/ro/jo-malone-london-pine-eucalyptus-diffuser-165ml')
		expect(roVariant?.outcome).toBe('extracted')
		expect(roVariant?.extracted?.sku).toBe('686263')
		expect(roVariant?.extracted?.gtin).toBeNull()
		expect(roVariant?.missingFields).toContain('gtin')
	})

	test('/ru/ and /ro/ variants of the same slug are treated as distinct results, never silently merged (equivalence unconfirmed)', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const bothVariants = report.results.filter((r) => r.url.includes('jo-malone-london-pine-eucalyptus-diffuser-165ml'))
		expect(bothVariants).toHaveLength(2)
		expect(bothVariants.map((r) => r.language).sort()).toEqual(['ro', 'ru'])
	})

	test('the utm_source duplicate of the same /ru/ URL is merged into a single result', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const ruOnly = report.results.filter((r) => r.url.startsWith('https://ovico.md/ru/jo-malone'))
		expect(ruOnly).toHaveLength(1)
	})

	test('a GTIN that fails the GS1 checksum is treated as missing, never trusted as-is', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const invalidGtin = report.results.find((r) => r.url.includes('dior-sauvage'))
		expect(invalidGtin?.outcome).toBe('extracted')
		expect(invalidGtin?.extracted?.gtin).toBeNull()
		expect(invalidGtin?.missingFields).toContain('gtin')
	})

	test('an unavailable (OutOfStock) product is extracted with its current MDL price, not silently dropped or marked in stock', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const unavailable = report.results.find((r) => r.url.includes('guerlain-shalimar'))
		expect(unavailable?.outcome).toBe('extracted')
		expect(unavailable?.extracted?.availability).toBe('out_of_stock')
		expect(unavailable?.extracted?.price).toBe(1750)
		expect(unavailable?.extracted?.currency).toBe('MDL')
	})

	test('a multi-variant product page extracts the first declared variant without conflating its price with the other variant', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const multiVariant = report.results.find((r) => r.url.includes('ysl-black-opium-multi'))
		expect(multiVariant?.outcome).toBe('extracted')
		expect(multiVariant?.extracted?.variant).toBe('50ml')
		expect(multiVariant?.extracted?.price).toBe(1690)
	})

	test('a page with no JSON-LD at all is reported as missing_json_ld, not extracted', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const noJsonLd = report.results.find((r) => r.url.includes('chanel-no5'))
		expect(noJsonLd?.outcome).toBe('missing_json_ld')
		expect(noJsonLd?.extracted).toBeNull()
	})

	test('a page with malformed JSON-LD is reported as invalid_json_ld, not extracted', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const malformed = report.results.find((r) => r.url.includes('versace-eros'))
		expect(malformed?.outcome).toBe('invalid_json_ld')
		expect(malformed?.extracted).toBeNull()
	})

	test('a non-Product flat page (CollectionPage) that slipped past the classifier is reported as non_product_page', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		const category = report.results.find((r) => r.url.includes('parfumuri-sezon'))
		expect(category?.outcome).toBe('non_product_page')
		expect(category?.extracted).toBeNull()
	})

	test('candidateDiagnostics marks every selected URL as unverified, never a confirmed product match', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', MANIFEST_PATH])
		expect(report.candidateDiagnostics.length).toBe(report.results.length)
		for (const diag of report.candidateDiagnostics) {
			expect(diag.patternConfidence).toBe('unverified')
			expect(diag.reason).toContain('UNVERIFIED')
		}
	})
})

describe('validate-live CLI — ovico.md discovery failure (sitemap cannot be found/parsed)', () => {
	test('a malformed sitemap yields a clear discovery_failed diagnostic rather than silently crawling', async () => {
		const report = await main(['--domain', 'ovico.md', '--fixture-manifest', BROKEN_MANIFEST_PATH])
		expect(report.discovery.status).toBe('discovery_failed')
		expect(report.discovery.totalSitemapUrls).toBe(0)
		expect(report.discovery.sitemapDiagnostics.length).toBeGreaterThan(0)
		expect(report.pages.attempted).toBe(0)
	})
})
