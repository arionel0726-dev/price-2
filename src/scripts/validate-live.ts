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
import type { StoreProfile } from '../lib/discovery/stores/types'
import { vizajeNicaStoreProfile } from '../lib/discovery/stores/vizaje-nica'
import { DisallowedRedirectError, isDomainAllowlistedForLiveValidation } from '../lib/net/allowlist'
import { DomainScheduler } from '../lib/net/rate-limit'
import { getCrawlDelaySeconds, type RobotsRules } from '../lib/net/robots'
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
	/**
	 * Validate exactly this one product page instead of sampling candidates
	 * from the sitemap (Task 7.3). Must be an absolute HTTPS URL (the live
	 * server's protocol in test mode — see LiveModeTestOverrides.protocol),
	 * with no credentials or fragment, whose host exactly matches `domain`.
	 */
	url?: string
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
			case '--url':
				args.url = argv[++i]
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

/**
 * Validates a `--url` argument fully offline (Task 7.3): well-formed,
 * absolute, the expected scheme, no credentials, no fragment, and belonging
 * to exactly `args.domain`. Also rejects any URL that `args.domain`'s store
 * profile classifier does not recognize as a product candidate — a known
 * category, search, account, or checkout URL (req. §8) — without ever
 * making a network request.
 *
 * `expectedProtocol` is 'https' in production (the only scheme --url may
 * use for a real run). Live-mode tests pass the same `protocol` override
 * already used everywhere else in this file to point the whole pipeline at
 * a local http:// test server; this keeps --url's scheme check consistent
 * with every other URL this file constructs, rather than special-casing it.
 *
 * `storeProfilePolicy` controls how `--domain` is resolved to a store
 * profile (Task 7.3 follow-up safety review §1-2):
 *   - `{ kind: 'fallback' }` (fixture mode): resolves via the registry,
 *     falling back to vizaje-nica.com's profile for an unregistered domain
 *     — unchanged from before, and safe because fixture mode never opens a
 *     socket regardless of domain.
 *   - `{ kind: 'strict' }` (live mode, production): requires `--domain` to
 *     have an EXPLICITLY REGISTERED profile (src/lib/discovery/stores/registry.ts).
 *     An unregistered domain is rejected outright — explicit --url mode
 *     must never silently validate an unknown live domain against a
 *     generic pattern borrowed from a different store.
 *   - `{ kind: 'test-override', storeProfile }` (live mode, tests only):
 *     uses the given profile directly, bypassing the registry entirely, so
 *     a local HTTP test server (whose domain is never registered) can still
 *     exercise this code path end-to-end — without reintroducing the
 *     production fallback this safety review removed. Never set from the
 *     CLI; only `runLiveMode`'s `overrides.storeProfile` test hatch
 *     constructs this variant.
 */
type StoreProfilePolicy = { kind: 'fallback' } | { kind: 'strict' } | { kind: 'test-override'; storeProfile: StoreProfile }

function resolveExplicitUrl(
	args: CliArgs,
	expectedProtocol: 'http' | 'https',
	storeProfilePolicy: StoreProfilePolicy
): { url: string; storeProfile: StoreProfile } {
	const raw = args.url
	if (!raw) throw new Error('internal error: resolveExplicitUrl called without --url')

	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new Error(`--url must be a well-formed absolute URL (received "${raw}")`)
	}

	if (parsed.protocol !== `${expectedProtocol}:`) {
		throw new Error(`--url must use ${expectedProtocol}:// — refusing unsupported scheme "${parsed.protocol}"`)
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new Error('--url must not contain credentials (username/password)')
	}
	if (parsed.hash !== '') {
		throw new Error('--url must not contain a fragment')
	}
	if (parsed.host.toLowerCase() !== args.domain.toLowerCase()) {
		throw new Error(`--url host "${parsed.host}" does not match --domain "${args.domain}" — refusing a cross-store URL`)
	}

	let storeProfile: StoreProfile
	if (storeProfilePolicy.kind === 'test-override') {
		storeProfile = storeProfilePolicy.storeProfile
	} else {
		const registered = getStoreProfile(args.domain)
		if (registered) {
			storeProfile = registered
		} else if (storeProfilePolicy.kind === 'fallback') {
			storeProfile = vizajeNicaStoreProfile
		} else {
			throw new Error(
				`--url requires an explicitly registered store profile for domain "${args.domain}" ` +
					'(see src/lib/discovery/stores/registry.ts) — live --url mode never falls back to a generic ' +
					"pattern borrowed from a different store for a domain it does not recognize."
			)
		}
	}

	const match = storeProfile.classifyProductUrl(raw)
	if (!match) {
		throw new Error(
			`Refusing to validate "${raw}": it does not match ${storeProfile.domain}'s product-page classifier — ` +
				'likely a category, search, account, or checkout URL (or an otherwise unrecognized shape).'
		)
	}

	return { url: raw, storeProfile }
}

export async function runFixtureMode(args: CliArgs): Promise<ValidateLiveReport> {
	if (args.url) {
		const { url, storeProfile } = resolveExplicitUrl(args, 'https', { kind: 'fallback' })
		const manifest = loadFixtureManifest(args.fixtureManifestPath)

		const fetchText = async (fetchUrl: string): Promise<RobotsPageFetch> => {
			if (fetchUrl === manifest.robotsUrl) return { status: 200, body: readFileSync(resolve(manifest.robotsFixture), 'utf-8') }
			const path = manifest.pageFixtures[fetchUrl] ?? null
			if (!path) return { status: 404, body: '' }
			return { status: 200, body: readFileSync(resolve(path), 'utf-8') }
		}

		return validateLiveDomain({
			domain: args.domain,
			mode: 'fixture',
			requestedSampleSize: 1,
			userAgent: args.userAgent,
			robotsUrl: manifest.robotsUrl,
			fetchText,
			storeProfile,
			explicitUrl: url
		})
	}

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
	/**
	 * Test-only escape hatch for `--url` mode specifically (Task 7.3 follow-up
	 * safety review §1-2): production live `--url` requires `--domain` to have
	 * an explicitly registered store profile (src/lib/discovery/stores/registry.ts)
	 * and never falls back to a generic pattern borrowed from a different
	 * store. A local HTTP test server's domain (e.g. "127.0.0.1:54321") is
	 * never registered, so tests pass the profile to use directly here
	 * instead — exercising the exact same classification/extraction code a
	 * registered domain would use, without reintroducing that silent
	 * fallback for production. Never set from the CLI; ignored when `--url`
	 * is not supplied.
	 */
	storeProfile?: StoreProfile
}

export async function runLiveMode(args: CliArgs, overrides: LiveModeTestOverrides = {}): Promise<ValidateLiveReport> {
	if (!isDomainAllowlistedForLiveValidation(args.domain, overrides.allowlist)) {
		throw new Error(
			`Refusing to run live validation against "${args.domain}": not on the explicit allowlist (src/lib/net/allowlist.ts). ` +
				'Add the domain there deliberately before validating it.'
		)
	}

	const allowlist = overrides.allowlist
	const protocol = overrides.protocol ?? 'https'

	// Resolved up front (fully offline) so an invalid --url, or a --domain
	// with no registered store profile, is rejected before the scheduler, or
	// any socket, is ever created (Task 7.3). Live mode uses the 'strict'
	// policy — never the registry's vizaje-nica fallback — unless a test
	// explicitly supplies its own profile via overrides.storeProfile.
	const explicitUrlResolution = args.url
		? resolveExplicitUrl(args, protocol, overrides.storeProfile ? { kind: 'test-override', storeProfile: overrides.storeProfile } : { kind: 'strict' })
		: null
	const storeProfile = explicitUrlResolution?.storeProfile ?? getStoreProfile(args.domain) ?? vizajeNicaStoreProfile

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

	const robotsUrl = `${protocol}://${args.domain}/robots.txt`

	// robots.txt's own Crawl-delay (e.g. ovico.md's `Crawl-delay: 30`) must
	// never be silently overridden by our --delay-ms default/argument — it
	// can only ever be used to make pacing MORE conservative, never less
	// (see DomainScheduler.raiseMinDelayForDomain and Task 7 §9). robots.txt
	// is always the first request made to a domain in a run, so there is no
	// request whose pacing could have already been computed with the old,
	// smaller delay by the time this fires.
	const onRobotsLoaded = (rules: RobotsRules) => {
		const crawlDelaySeconds = getCrawlDelaySeconds(rules, args.userAgent)
		if (crawlDelaySeconds !== null) {
			scheduler.raiseMinDelayForDomain(new URL(robotsUrl).hostname, crawlDelaySeconds * 1000)
		}
	}

	if (explicitUrlResolution) {
		return validateLiveDomain({
			domain: args.domain,
			mode: 'live',
			requestedSampleSize: 1,
			userAgent: args.userAgent,
			robotsUrl,
			fetchText,
			onRobotsLoaded,
			storeProfile,
			explicitUrl: explicitUrlResolution.url
		})
	}

	// A `protocol` override means a test is pointing this at a local server
	// standing in for `args.domain` (see tests/validation/validate-live-cli.test.ts)
	// — in that case the sitemap must be constructed from that same
	// domain/protocol, not the store profile's real-world default URL.
	const sitemapEntryUrl = args.sitemapUrl ?? (overrides.protocol ? `${protocol}://${args.domain}/sitemap.xml` : storeProfile.defaultSitemapUrl)

	return validateLiveDomain({
		domain: args.domain,
		mode: 'live',
		requestedSampleSize: args.limit,
		userAgent: args.userAgent,
		sitemapEntryUrl,
		robotsUrl,
		fetchText,
		fetchSitemapText,
		onRobotsLoaded,
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
