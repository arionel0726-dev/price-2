#!/usr/bin/env bun
/**
 * CLI for exercising the discovery + extraction pipeline end-to-end.
 *
 * Offline (default): reads a JSON "fixture manifest" that maps sitemap and
 * product page URLs to local files, so the full pipeline runs without any
 * network access. See tests/fixtures/manifest.json for the format and an
 * example built from this repo's test fixtures.
 *
 * Live (opt-in only): pass --live <sitemapUrl> to discover and fetch a real
 * site through the SSRF-safe HTTP client. This performs real network
 * requests and must only be pointed at a target you have explicit
 * permission to crawl — it is disabled unless --live is passed explicitly.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { discoverSitemapUrls } from '../lib/discovery/sitemap'
import { extractProductsFromHtml } from '../lib/scraping/extract'
import { safeFetch } from '../lib/net/safe-fetch'
import { DomainScheduler } from '../lib/net/rate-limit'
import type { DiscoveryReport } from './report-types'

interface FixtureManifest {
	sitemapEntryPoints: string[]
	sitemapFixtures: Record<string, string>
	pageFixtures: Record<string, string>
}

interface CliArgs {
	mode: 'fixture' | 'live'
	manifestPath: string
	liveSitemapUrl?: string
	outPath?: string
	maxDepth?: number
	maxSitemaps?: number
	maxUrls?: number
	userAgent: string
}

const DEFAULT_MANIFEST_PATH = 'tests/fixtures/manifest.json'
const DEFAULT_USER_AGENT = 'price2-discovery-bot/0.1 (+https://example.invalid/bot; contact=ops@example.invalid)'

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		mode: 'fixture',
		manifestPath: DEFAULT_MANIFEST_PATH,
		userAgent: DEFAULT_USER_AGENT
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case '--live':
				args.mode = 'live'
				args.liveSitemapUrl = argv[++i]
				if (!args.liveSitemapUrl) throw new Error('--live requires a sitemap URL argument')
				break
			case '--manifest':
				args.manifestPath = argv[++i]
				break
			case '--out':
				args.outPath = argv[++i]
				break
			case '--max-depth':
				args.maxDepth = Number(argv[++i])
				break
			case '--max-sitemaps':
				args.maxSitemaps = Number(argv[++i])
				break
			case '--max-urls':
				args.maxUrls = Number(argv[++i])
				break
			case '--user-agent':
				args.userAgent = argv[++i]
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}

	return args
}

function loadManifest(path: string): FixtureManifest {
	const raw = readFileSync(resolve(path), 'utf-8')
	return JSON.parse(raw) as FixtureManifest
}

async function runFixtureMode(args: CliArgs): Promise<DiscoveryReport> {
	const manifest = loadManifest(args.manifestPath)

	const fetchSitemap = async (url: string): Promise<string> => {
		const path = manifest.sitemapFixtures[url]
		if (!path) throw new Error(`No fixture mapped for sitemap URL: ${url}`)
		return readFileSync(resolve(path), 'utf-8')
	}

	const discovery = await discoverSitemapUrls(manifest.sitemapEntryPoints, {
		fetchSitemap,
		maxDepth: args.maxDepth,
		maxSitemaps: args.maxSitemaps,
		maxUrls: args.maxUrls
	})

	return buildReport('fixture', discovery, (url) => {
		const path = manifest.pageFixtures[url]
		if (!path) return null
		return readFileSync(resolve(path), 'utf-8')
	})
}

async function runLiveMode(args: CliArgs): Promise<DiscoveryReport> {
	if (!args.liveSitemapUrl) throw new Error('Live mode requires a sitemap URL')

	const scheduler = new DomainScheduler({ globalConcurrency: 4, perDomainConcurrency: 1, minDelayPerDomainMs: 1000 })

	const fetchViaSafeFetch = (url: string): Promise<string> => {
		const domain = new URL(url).hostname
		return scheduler.schedule(domain, async () => {
			const response = await safeFetch(url, { userAgent: args.userAgent })
			return response.body
		})
	}

	const discovery = await discoverSitemapUrls([args.liveSitemapUrl], {
		fetchSitemap: fetchViaSafeFetch,
		maxDepth: args.maxDepth,
		maxSitemaps: args.maxSitemaps,
		maxUrls: args.maxUrls
	})

	const pageCache = new Map<string, string | null>()
	const getPageHtml = async (url: string): Promise<string | null> => {
		if (pageCache.has(url)) return pageCache.get(url) ?? null
		try {
			const html = await fetchViaSafeFetch(url)
			pageCache.set(url, html)
			return html
		} catch {
			pageCache.set(url, null)
			return null
		}
	}

	return buildReportAsync('live', discovery, getPageHtml)
}

function buildReport(
	mode: 'fixture' | 'live',
	discovery: Awaited<ReturnType<typeof discoverSitemapUrls>>,
	getPageHtml: (url: string) => string | null
): DiscoveryReport {
	const products: DiscoveryReport['extraction']['products'] = []
	const failures: DiscoveryReport['extraction']['failures'] = []
	const skipped: DiscoveryReport['extraction']['skipped'] = []

	for (const discovered of discovery.urls) {
		const html = getPageHtml(discovered.url)
		if (html === null) {
			skipped.push({ url: discovered.url, reason: 'no_fixture_mapped' })
			continue
		}
		const result = extractProductsFromHtml(discovered.url, html)
		products.push(...result.products)
		failures.push(...result.failures)
	}

	return assembleReport(mode, discovery, products, failures, skipped)
}

async function buildReportAsync(
	mode: 'fixture' | 'live',
	discovery: Awaited<ReturnType<typeof discoverSitemapUrls>>,
	getPageHtml: (url: string) => Promise<string | null>
): Promise<DiscoveryReport> {
	const products: DiscoveryReport['extraction']['products'] = []
	const failures: DiscoveryReport['extraction']['failures'] = []
	const skipped: DiscoveryReport['extraction']['skipped'] = []

	for (const discovered of discovery.urls) {
		const html = await getPageHtml(discovered.url)
		if (html === null) {
			skipped.push({ url: discovered.url, reason: 'fetch_failed' })
			continue
		}
		const result = extractProductsFromHtml(discovered.url, html)
		products.push(...result.products)
		failures.push(...result.failures)
	}

	return assembleReport(mode, discovery, products, failures, skipped)
}

function assembleReport(
	mode: 'fixture' | 'live',
	discovery: Awaited<ReturnType<typeof discoverSitemapUrls>>,
	products: DiscoveryReport['extraction']['products'],
	failures: DiscoveryReport['extraction']['failures'],
	skipped: DiscoveryReport['extraction']['skipped']
): DiscoveryReport {
	return {
		generatedAt: new Date().toISOString(),
		mode,
		discovery: {
			sitemapsVisited: discovery.sitemapsVisited,
			diagnostics: discovery.diagnostics,
			urls: discovery.urls,
			truncated: discovery.truncated
		},
		extraction: { products, failures, skipped },
		stats: {
			sitemapsVisitedCount: discovery.sitemapsVisited.length,
			discoveredUrlCount: discovery.urls.length,
			likelyProductUrlCount: discovery.urls.filter((u) => u.candidateConfidence === 'likely').length,
			extractedProductCount: products.length,
			extractionFailureCount: failures.length,
			skippedUrlCount: skipped.length
		}
	}
}

export async function main(argv: string[]): Promise<DiscoveryReport> {
	const args = parseArgs(argv)
	const report = args.mode === 'live' ? await runLiveMode(args) : await runFixtureMode(args)

	const json = JSON.stringify(report, null, 2)
	if (args.outPath) {
		writeFileSync(resolve(args.outPath), json, 'utf-8')
	} else {
		console.log(json)
	}
	return report
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exit(1)
	})
}
