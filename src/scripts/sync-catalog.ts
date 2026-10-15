#!/usr/bin/env bun
/**
 * Orchestration layer wiring Task 1's discovery/extraction CLI into Task 2's
 * catalog synchronization service:
 *
 *   Discovery fixture (or --live) -> Extraction -> Catalog sync -> PostgreSQL
 *
 * This intentionally reuses `discover.ts`'s `main()` unchanged rather than
 * re-implementing discovery/extraction here, so Task 1's CLI behavior stays
 * exactly as it was. Arguments not recognized by this wrapper are forwarded
 * to it verbatim (e.g. --manifest, --live, --out, --max-urls, ...).
 *
 * Usage:
 *   bun run src/scripts/sync-catalog.ts --store-domain shop.example.test \
 *     -- --manifest tests/fixtures/manifest.json
 */
import { eq } from 'drizzle-orm'
import { closeDb, getDb } from '../db'
import { stores } from '../db/schema'
import { finishScanRun, startScanRun } from '../lib/catalog/scan-runs'
import { synchronizeStoreListings } from '../lib/catalog/sync'
import type { ScanRunStatus } from '../lib/catalog/types'
import { main as runDiscovery } from './discover'

interface SyncCliArgs {
	storeDomain: string
	storeName?: string
	discoverArgs: string[]
}

function parseArgs(argv: string[]): SyncCliArgs {
	let storeDomain: string | undefined
	let storeName: string | undefined
	const discoverArgs: string[] = []

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--store-domain') {
			storeDomain = argv[++i]
		} else if (arg === '--store-name') {
			storeName = argv[++i]
		} else if (arg === '--') {
			discoverArgs.push(...argv.slice(i + 1))
			break
		} else {
			discoverArgs.push(arg)
		}
	}

	if (!storeDomain) {
		throw new Error('--store-domain is required (e.g. --store-domain shop.example.test)')
	}

	return { storeDomain, storeName, discoverArgs }
}

async function ensureStore(domain: string, name: string | undefined): Promise<string> {
	const db = getDb()
	const existing = await db.select({ id: stores.id }).from(stores).where(eq(stores.domain, domain))
	if (existing[0]) return existing[0].id

	const [row] = await db.insert(stores).values({ domain, name: name ?? domain }).returning({ id: stores.id })
	return row.id
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv)
	const db = getDb()
	const storeId = await ensureStore(args.storeDomain, args.storeName)

	const report = await runDiscovery(args.discoverArgs)

	const scanRunId = await startScanRun(db, storeId, report.discovery.urls.length)

	let summary
	let status: ScanRunStatus
	try {
		summary = await synchronizeStoreListings(report.extraction.products, { db, storeId, scanRunId })
		const hasFailures = report.extraction.failures.length > 0 || summary.failedRecords > 0
		const isTruncatedOrSkipped = report.discovery.truncated || report.extraction.skipped.length > 0
		status = hasFailures || isTruncatedOrSkipped ? 'partial' : 'completed'
	} catch (cause) {
		await finishScanRun(db, {
			scanRunId,
			status: 'failed',
			extractedProductCount: report.extraction.products.length,
			newListingCount: 0,
			updatedListingCount: 0,
			failedExtractionCount: report.extraction.products.length,
			errorSummary: cause instanceof Error ? cause.message : String(cause)
		})
		throw cause
	}

	const errorMessages = [...report.extraction.failures.map((f) => f.message), ...summary.errors.map((e) => e.message)]

	await finishScanRun(db, {
		scanRunId,
		status,
		extractedProductCount: report.extraction.products.length,
		newListingCount: summary.newListings,
		updatedListingCount: summary.updatedListings,
		failedExtractionCount: report.extraction.failures.length + summary.failedRecords,
		errorSummary: errorMessages.length > 0 ? errorMessages.slice(0, 20).join('; ') : null
	})

	console.log(
		JSON.stringify(
			{
				storeId,
				scanRunId,
				status,
				discoveryStats: report.stats,
				syncSummary: summary
			},
			null,
			2
		)
	)
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : err)
			process.exitCode = 1
		})
		.finally(() => closeDb())
}
