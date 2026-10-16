#!/usr/bin/env bun
/**
 * Diagnostic CLI for validating real-world product extraction against a
 * small, bounded sample of public product pages on one pilot store.
 *
 * This is NOT a crawler. It is a controlled, explicitly-invoked validation
 * tool: it never performs network requests unless --live is passed, it
 * only ever targets a domain on an explicit allowlist
 * (src/lib/net/allowlist.ts), it respects robots.txt and fails closed if
 * robots rules cannot be obtained, and it hard-caps the number of product
 * pages fetched per run at 20 regardless of --limit.
 *
 * Offline (default): reads a fixture manifest (sitemap + robots.txt + page
 * HTML all from local files) and runs the exact same validation pipeline
 * with zero network access. Useful for testing and for dry-running the
 * logic before ever approving a live run.
 *
 * Live (opt-in only, --live): fetches the real sitemap, robots.txt, and up
 * to `--limit` (max 20) product pages through the existing SSRF-safe HTTP
 * client, at concurrency 1 with a conservative delay between requests.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getStoreProfile } from '../lib/discovery/stores/registry'
import { vizajeNicaStoreProfile } from '../lib/discovery/stores/vizaje-nica'
import { DisallowedRedirectError, isDomainAllowlistedForLiveValidation } from '../lib/net/allowlist'
import { DomainScheduler } from '../lib/net/rate-limit'
import { safeFetch } from '../lib/net/safe-fetch'
import type { RobotsPageFetch } from '../lib/net/robots-fetch'
import { MAX_PRODUCT_PAGES_PER_RUN, validateLiveDomain } from '../lib/validation/live-validator'
import type { ValidateLiveReport } from './validate-live-report-types'

const DEFAULT_USER_AGENT = 'price2-validation-bot/0.1 (+https://example.invalid/bot; contact=ops@example.invalid)'
const DEFAULT_SAMPLE_SIZE = 10
const DEFAULT_MIN_DELAY_MS = 2000
const MIN_ALLOWED_DELAY_MS = 1000

// Sitemap XML is allowed a larger (but still bounded) budget than ordinary
// HTML pages: real-world sitemaps — especially a nested/paginated set like
// makeup.md's — can legitimately run tens of megabytes, far beyond a single
// product page. Both caps stay well short of "unbounded": a 20 MiB wire cap
// per file and a 50 MiB decompressed cap per file (see safe-fetch.ts's
// bounded gzip decompression — this also guards against a "zip bomb").
const SITEMAP_MAX_RESPONSE_BYTES = 20 * 1024 * 1024
const SITEMAP_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024
// Independent of the per-file caps above: bounds the TOTAL bytes read across
// every sitemap file fetched in one discovery run (an index can reference
// many nested files, each individually under the per-file cap, that would
// still add up to unbounded memory use without a run-wide budget). Discovery
// stops with a diagnostic — not silently truncated and reported as complete —
// once this is exceeded; see Task 6.1 §2 and §5.
const SITEMAP_MAX_TOTAL_RUN_BYTES = 150 * 1024 * 1024

interface FixtureManifest {
	sitemapUrl: string
	sitemapFixture: string
	robotsUrl: string
	robotsFixture: string
	pageFixtures: Record<string, string>
}

export interface CliArgs {
	domain: string
	limit: number
	live: boolean
	fixtureManifestPath: string
	outPath?: string
	userAgent: string
	delayMs: number
	/** Overrides the store profile's default sitemap URL (see src/lib/discovery/stores/). Useful for makeup.md, whose advertised /sitemap/sitemap.xml location is an unconfirmed candidate. */
	sitemapUrl?: string
}

const DEFAULT_FIXTURE_MANIFEST_PATH = 'tests/fixtures/validate-live/manifest.json'

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		domain: '',
		limit: DEFAULT_SAMPLE_SIZE,
		live: false,
		fixtureManifestPath: DEFAULT_FIXTURE_MANIFEST_PATH,
		userAgent: DEFAULT_USER_AGENT,
		delayMs: DEFAULT_MIN_DELAY_MS
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case '--domain':
				args.domain = argv[++i]
				break
			case '--limit':
				args.limit = Number(argv[++i])
				break
			case '--live':
				args.live = true
				break
			case '--fixture-manifest':
				args.fixtureManifestPath = argv[++i]
				break
			case '--out':
				args.outPath = argv[++i]
				break
			case '--user-agent':
				args.userAgent = argv[++i]
				break
			case '--delay-ms':
				args.delayMs = Number(argv[++i])
				break
			case '--sitemap-url':
				args.sitemapUrl = argv[++i]
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}

	if (!args.domain) throw new Error('--domain is required')
	if (!Number.isFinite(args.limit) || args.limit < 1) throw new Error('--limit must be a positive number')
	if (args.limit > MAX_PRODUCT_PAGES_PER_RUN) {
		console.warn(`--limit ${args.limit} exceeds the hard cap of ${MAX_PRODUCT_PAGES_PER_RUN}; clamping to ${MAX_PRODUCT_PAGES_PER_RUN}.`)
	}
	if (!Number.isFinite(args.delayMs) || args.delayMs < MIN_ALLOWED_DELAY_MS) {
		throw new Error(`--delay-ms must be at least ${MIN_ALLOWED_DELAY_MS}ms (conservative pacing is mandatory for live mode)`)
	}

	return args
}

function loadFixtureManifest(path: string): FixtureManifest {
	return JSON.parse(readFileSync(resolve(path), 'utf-8')) as FixtureManifest
}

export async function runFixtureMode(args: CliArgs): Promise<ValidateLiveReport> {
	const manifest = loadFixtureManifest(args.fixtureManifestPath)

	const fileFor = (url: string): string | null => {
		if (url === manifest.sitemapUrl) return manifest.sitemapFixture
		if (url === manifest.robotsUrl) return manifest.robotsFixture
		return manifest.pageFixtures[url] ?? null
	}

	const fetchText = async (url: string): Promise<RobotsPageFetch> => {
		const path = fileFor(url)
		if (!path) return { status: 404, body: '' }
		return { status: 200, body: readFileSync(resolve(path), 'utf-8') }
	}

	return validateLiveDomain({
		domain: args.domain,
		mode: 'fixture',
		requestedSampleSize: args.limit,
		userAgent: args.userAgent,
		sitemapEntryUrl: manifest.sitemapUrl,
		robotsUrl: manifest.robotsUrl,
		fetchText,
		storeProfile: getStoreProfile(args.domain) ?? vizajeNicaStoreProfile
	})
}

export interface LiveModeTestOverrides {
	/**
	 * Test-only escape hatch so the live code path (safeFetch + scheduler +
	 * robots/sitemap/page fetching) can be exercised end-to-end against a
	 * local HTTP server, without widening the production allowlist. Never
	 * set from the CLI.
	 */
	allowlist?: ReadonlySet<string>
	allowPrivateNetworks?: boolean
	/** Overrides the "https://" scheme used to build the sitemap/robots URLs from `--domain` — only so tests can point this at a local http:// server. */
	protocol?: 'http' | 'https'
	/**
	 * Overrides the production sitemap size/budget constants so tests can
	 * exercise the oversized-sitemap and run-wide-budget logic without
	 * needing to actually transfer tens of megabytes. Never set from the CLI
	 * — production always uses SITEMAP_MAX_RESPONSE_BYTES /
	 * SITEMAP_MAX_DECOMPRESSED_BYTES / SITEMAP_MAX_TOTAL_RUN_BYTES.
	 */
	sitemapLimits?: {
		maxResponseBytes?: number
		maxDecompressedBytes?: number
		maxTotalRunBytes?: number
	}
}

export async function runLiveMode(args: CliArgs, overrides: LiveModeTestOverrides = {}): Promise<ValidateLiveReport> {
	if (!isDomainAllowlistedForLiveValidation(args.domain, overrides.allowlist)) {
		throw new Error(
			`Refusing to run live validation against "${args.domain}": not on the explicit allowlist (src/lib/net/allowlist.ts). ` +
				'Add the domain there deliberately before validating it.'
		)
	}

	const allowlist = overrides.allowlist
	const storeProfile = getStoreProfile(args.domain) ?? vizajeNicaStoreProfile

	// Concurrency 1, conservative pacing: one in-flight request to this
	// domain at a time, with at least --delay-ms between requests.
	const scheduler = new DomainScheduler({ globalConcurrency: 1, perDomainConcurrency: 1, minDelayPerDomainMs: args.delayMs })

	// The allowlist is otherwise only checked once, against --domain, before
	// the first request. Re-check the final URL and every redirect hop here
	// so a same-origin request that redirects to an unrelated (but still
	// publicly routable) host is never silently followed — see
	// src/lib/net/allowlist.ts: DisallowedRedirectError. Shared by both the
	// page fetcher and the sitemap fetcher below.
	function assertNoDisallowedRedirect(response: { redirectChain: string[]; url: string }): void {
		for (const visitedUrl of [...response.redirectChain, response.url]) {
			// `.host` (not `.hostname`) so this matches the same authority
			// string used everywhere else a domain is compared against the
			// allowlist (including test fixtures that encode a local server's
			// port, e.g. "127.0.0.1:54321") — a real allowlisted domain never
			// has a port, so `.host` and `.hostname` agree there.
			const host = new URL(visitedUrl).host
			if (!isDomainAllowlistedForLiveValidation(host, allowlist)) {
				throw new DisallowedRedirectError(host)
			}
		}
	}

	const fetchText = (url: string): Promise<RobotsPageFetch> => {
		const domain = new URL(url).hostname
		return scheduler.schedule(domain, async () => {
			const response = await safeFetch(url, { userAgent: args.userAgent, allowPrivateNetworks: overrides.allowPrivateNetworks })
			assertNoDisallowedRedirect(response)
			return { status: response.status, body: response.body }
		})
	}

	// Separate from `fetchText` so ordinary HTML pages keep the default
	// (smaller) response-size limits unchanged, while sitemap XML — which
	// can legitimately be far larger — gets its own bounded budget. A
	// run-wide cumulative byte counter additionally bounds total memory use
	// across every nested sitemap file, independent of each file's own cap
	// (see Task 6.1 §2: "Bound ... the total number of sitemap URLs and
	// nested sitemap files" / "Avoid unbounded memory consumption").
	const sitemapMaxResponseBytes = overrides.sitemapLimits?.maxResponseBytes ?? SITEMAP_MAX_RESPONSE_BYTES
	const sitemapMaxDecompressedBytes = overrides.sitemapLimits?.maxDecompressedBytes ?? SITEMAP_MAX_DECOMPRESSED_BYTES
	const sitemapMaxTotalRunBytes = overrides.sitemapLimits?.maxTotalRunBytes ?? SITEMAP_MAX_TOTAL_RUN_BYTES

	let cumulativeSitemapBytes = 0
	const fetchSitemapText = (url: string): Promise<RobotsPageFetch> => {
		const domain = new URL(url).hostname
		return scheduler.schedule(domain, async () => {
			const response = await safeFetch(url, {
				userAgent: args.userAgent,
				allowPrivateNetworks: overrides.allowPrivateNetworks,
				maxResponseBytes: sitemapMaxResponseBytes,
				maxDecompressedBytes: sitemapMaxDecompressedBytes
			})
			assertNoDisallowedRedirect(response)

			cumulativeSitemapBytes += response.body.length
			if (cumulativeSitemapBytes > sitemapMaxTotalRunBytes) {
				// Reported as a fetch failure for this specific sitemap file —
				// discoverSitemapUrls records it as a diagnostic and keeps
				// whatever URLs were already collected, rather than losing the
				// whole run. The report's discovery.status becomes 'partial'
				// (see live-validator.ts), never silently 'ok'.
				throw new Error(
					`Aborting: cumulative sitemap bytes fetched in this run (${cumulativeSitemapBytes}) exceeded the ` +
						`${sitemapMaxTotalRunBytes}-byte run-wide budget (bound against unbounded memory use across many nested sitemap files)`
				)
			}

			return { status: response.status, body: response.body }
		})
	}

	const protocol = overrides.protocol ?? 'https'
	// A `protocol` override means a test is pointing this at a local server
	// standing in for `args.domain` (see tests/validation/validate-live-cli.test.ts)
	// — in that case the sitemap must be constructed from that same
	// domain/protocol, not the store profile's real-world default URL.
	const sitemapEntryUrl = args.sitemapUrl ?? (overrides.protocol ? `${protocol}://${args.domain}/sitemap.xml` : storeProfile.defaultSitemapUrl)
	const robotsUrl = `${protocol}://${args.domain}/robots.txt`

	return validateLiveDomain({
		domain: args.domain,
		mode: 'live',
		requestedSampleSize: args.limit,
		userAgent: args.userAgent,
		sitemapEntryUrl,
		robotsUrl,
		fetchText,
		fetchSitemapText,
		storeProfile
	})
}

export async function main(argv: string[]): Promise<ValidateLiveReport> {
	const args = parseArgs(argv)
	const report = args.live ? await runLiveMode(args) : await runFixtureMode(args)

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
