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

	const fetchText = (url: string): Promise<RobotsPageFetch> => {
		const domain = new URL(url).hostname
		return scheduler.schedule(domain, async () => {
			const response = await safeFetch(url, { userAgent: args.userAgent, allowPrivateNetworks: overrides.allowPrivateNetworks })

			// The allowlist is otherwise only checked once, against --domain,
			// before the first request. Re-check the final URL and every
			// redirect hop here so a same-origin request that redirects to an
			// unrelated (but still publicly routable) host is never silently
			// followed — see src/lib/net/allowlist.ts: DisallowedRedirectError.
			for (const visitedUrl of [...response.redirectChain, response.url]) {
				// `.host` (not `.hostname`) so this matches the same authority
				// string used everywhere else a domain is compared against the
				// allowlist (including test fixtures that encode a local
				// server's port, e.g. "127.0.0.1:54321") — a real allowlisted
				// domain never has a port, so `.host` and `.hostname` agree there.
				const host = new URL(visitedUrl).host
				if (!isDomainAllowlistedForLiveValidation(host, allowlist)) {
					throw new DisallowedRedirectError(host)
				}
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
