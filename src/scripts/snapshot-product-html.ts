#!/usr/bin/env bun
/**
 * Opt-in diagnostic tool: fetches a SMALL, explicitly-named set of public
 * product-page URLs (at most 3) and saves the raw HTML locally, so a human
 * can inspect what a store actually returns before any extraction selector
 * is written (see Task 6.1 §3 — "Do not invent HTML structure").
 *
 * This is NOT a crawler and never discovers URLs itself: every URL must be
 * passed explicitly via --url. It reuses the same safety controls as
 * validate-live.ts: an explicit --live opt-in, the domain allowlist
 * (src/lib/net/allowlist.ts), robots.txt (fail-closed), SSRF protection,
 * and normal response-size/timeout bounds — this tool fetches ordinary
 * product pages, so it deliberately does NOT use the larger sitemap-sized
 * limits from validate-live.ts.
 *
 * Saved HTML is written ONLY to a local, explicitly-named output directory
 * (default: .local/snapshots/, which is gitignored — see .gitignore) and is
 * NEVER committed or pushed automatically by this tool or by any other part
 * of this codebase.
 *
 * Offline companion mode (no network, no --live required): --analyze <file>
 * runs the same classifier (src/lib/diagnostics/html-snapshot.ts) against
 * an already-saved local HTML file, e.g. one collected via the PowerShell
 * commands documented in the Task 6.1 delivery notes when this environment
 * itself has no network access.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyHtmlSnapshot } from '../lib/diagnostics/html-snapshot'
import { getStoreProfile } from '../lib/discovery/stores/registry'
import { isDomainAllowlistedForLiveValidation } from '../lib/net/allowlist'
import { fetchRobotsRules, isPathAllowed } from '../lib/net/robots-fetch'
import { safeFetch } from '../lib/net/safe-fetch'

const DEFAULT_USER_AGENT = 'price2-validation-bot/0.1 (+https://example.invalid/bot; contact=ops@example.invalid)'
const DEFAULT_OUT_DIR = '.local/snapshots'
const MAX_URLS = 3

export interface SnapshotCliArgs {
	urls: string[]
	live: boolean
	outDir: string
	userAgent: string
	analyzePath?: string
}

export function parseArgs(argv: string[]): SnapshotCliArgs {
	const args: SnapshotCliArgs = { urls: [], live: false, outDir: DEFAULT_OUT_DIR, userAgent: DEFAULT_USER_AGENT }

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case '--url':
				args.urls.push(argv[++i])
				break
			case '--live':
				args.live = true
				break
			case '--out-dir':
				args.outDir = argv[++i]
				break
			case '--user-agent':
				args.userAgent = argv[++i]
				break
			case '--analyze':
				args.analyzePath = argv[++i]
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}

	if (args.analyzePath) return args

	if (args.urls.length === 0) throw new Error('--url is required (pass at least one, at most 3 explicitly-selected URLs)')
	if (args.urls.length > MAX_URLS) {
		throw new Error(`At most ${MAX_URLS} URLs may be snapshotted in one run (got ${args.urls.length}) — this is a targeted diagnostic, not a crawler.`)
	}
	if (!args.live) {
		throw new Error(
			'Refusing to fetch without --live: this tool performs real network requests. ' +
				'Pass --live to confirm, or use --analyze <file> to classify an already-saved HTML file offline.'
		)
	}

	return args
}

function slugForUrl(url: string): string {
	return url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

function printClassification(label: string, html: string): void {
	const classification = classifyHtmlSnapshot(html)
	console.log(`\n--- ${label} ---`)
	console.log(`hasAnyJsonLd=${classification.hasAnyJsonLd} hasProductJsonLd=${classification.hasProductJsonLd} jsonLdParseFailures=${classification.jsonLdParseFailureCount}`)
	console.log(`looksLikeChallengePage=${classification.looksLikeChallengePage} looksLikeCategoryPage=${classification.looksLikeCategoryPage} looksLikeJsEmptyShell=${classification.looksLikeJsEmptyShell}`)
	if (classification.otherJsonLdTypes.length > 0) console.log(`otherJsonLdTypes=${classification.otherJsonLdTypes.join(', ')}`)
	for (const note of classification.notes) console.log(`  - ${note}`)
}

export async function runAnalyzeMode(path: string): Promise<void> {
	const html = readFileSync(resolve(path), 'utf-8')
	printClassification(path, html)
}

export async function runSnapshotMode(args: SnapshotCliArgs): Promise<void> {
	// Fetch robots.txt for each distinct host up front and fail closed exactly
	// like validate-live.ts — never guess that a path is allowed.
	const robotsCache = new Map<string, Awaited<ReturnType<typeof fetchRobotsRules>>>()

	for (const url of args.urls) {
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			console.error(`Skipping invalid URL: ${url}`)
			continue
		}

		if (!isDomainAllowlistedForLiveValidation(parsed.hostname)) {
			console.error(`Skipping "${url}": "${parsed.hostname}" is not on the live-validation allowlist (src/lib/net/allowlist.ts).`)
			continue
		}

		if (!robotsCache.has(parsed.hostname)) {
			const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`
			const result = await fetchRobotsRules(robotsUrl, async (u) => {
				const response = await safeFetch(u, { userAgent: args.userAgent })
				return { status: response.status, body: response.body }
			})
			robotsCache.set(parsed.hostname, result)
		}

		const robots = robotsCache.get(parsed.hostname)!
		if (!isPathAllowed(robots, parsed.pathname, args.userAgent)) {
			console.error(`Skipping "${url}": disallowed by robots.txt (or robots.txt could not be fetched — fails closed).`)
			continue
		}

		let html: string
		try {
			const response = await safeFetch(url, { userAgent: args.userAgent })
			html = response.body
		} catch (cause) {
			console.error(`Failed to fetch "${url}": ${cause instanceof Error ? cause.message : String(cause)}`)
			continue
		}

		if (!existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true })
		const filename = `${Date.now()}-${slugForUrl(url)}.html`
		const outPath = resolve(args.outDir, filename)
		writeFileSync(outPath, html, 'utf-8')
		console.log(`Saved ${url} -> ${outPath} (local only — never committed automatically)`)

		printClassification(url, html)

		// Surface which store profile (if any) this host maps to, and its
		// pattern confidence — purely informational, never used to decide
		// what to fetch here (every URL in this tool is explicit).
		const profile = getStoreProfile(parsed.hostname)
		if (profile) console.log(`  (store profile: ${profile.domain}, patternConfidence=${profile.patternConfidence})`)
	}
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv)
	if (args.analyzePath) {
		await runAnalyzeMode(args.analyzePath)
		return
	}
	await runSnapshotMode(args)
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exit(1)
	})
}
