import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { DbHandle } from '../../src/db'
import { catalogScanRuns, stores, storeListings } from '../../src/db/schema'
import { finishScanRun, startScanRun } from '../../src/lib/catalog/scan-runs'
import { synchronizeStoreListings } from '../../src/lib/catalog/sync'
import type { NormalizedProductRecord } from '../../src/lib/scraping/types'
import { openTestDb, resetTestDb, testDatabaseUrl } from './test-db'

let handle: DbHandle | null = null
let dbUnavailableReason: string | null = null

try {
	handle = await openTestDb()
} catch (cause) {
	dbUnavailableReason = cause instanceof Error ? cause.message : String(cause)
}

const maybeDescribe = handle ? describe : describe.skip

if (!handle) {
	console.warn(
		`Skipping catalog sync integration tests: could not reach PostgreSQL at ${testDatabaseUrl()} (${dbUnavailableReason}). ` +
			'Start PostgreSQL (e.g. `docker compose up -d` or a local `service postgresql start`), run migrations against ' +
			'TEST_DATABASE_URL, and re-run tests to exercise this suite.'
	)
}

function baseRecord(overrides: Partial<NormalizedProductRecord> = {}): NormalizedProductRecord {
	return {
		sourceUrl: 'https://shop.example.test/products/rose-50ml',
		extractedAt: new Date().toISOString(),
		title: { raw: 'Rose Eau de Parfum', normalized: 'Rose Eau de Parfum' },
		brand: { raw: 'Vizaje', normalized: 'Vizaje' },
		sku: 'VZ-ROSE-50',
		gtin: null,
		variant: { normalized: '50ml' },
		price: { raw: '349.00', amount: 349, currency: 'MDL' },
		availability: { raw: 'https://schema.org/InStock', normalized: 'in_stock' },
		rawJsonLd: { '@type': 'Product', name: 'Rose Eau de Parfum' },
		...overrides
	}
}

maybeDescribe('catalog synchronization (integration, requires PostgreSQL)', () => {
	// `handle` is only ever null when `maybeDescribe` is `describe.skip`, in
	// which case none of these test bodies actually run — but the test
	// framework still constructs them, so nothing here may dereference
	// `handle` outside of a callback body.
	function requireDb() {
		if (!handle) throw new Error('PostgreSQL handle unavailable')
		return handle.db
	}

	beforeEach(async () => {
		if (handle) await resetTestDb(handle)
	})

	afterAll(async () => {
		if (handle) await handle.client.end()
	})

	async function createStore(domain: string): Promise<string> {
		const db = requireDb()
		const [row] = await db.insert(stores).values({ name: domain, domain }).returning({ id: stores.id })
		return row.id
	}

	async function createScanRun(storeId: string): Promise<string> {
		return startScanRun(requireDb(), storeId, 1)
	}

	test('first import creates a listing', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRunId = await createScanRun(storeId)

		const summary = await synchronizeStoreListings([baseRecord()], { db, storeId, scanRunId })

		expect(summary).toEqual({ newListings: 1, updatedListings: 0, unchangedListings: 0, failedRecords: 0, errors: [] })

		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows).toHaveLength(1)
		expect(rows[0].normalizedTitle).toBe('Rose Eau de Parfum')
		expect(rows[0].price).toBe('349.00')
	})

	test('repeated import of an unchanged record creates no duplicates', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRun1 = await createScanRun(storeId)
		await synchronizeStoreListings([baseRecord()], { db, storeId, scanRunId: scanRun1 })

		const scanRun2 = await createScanRun(storeId)
		const summary = await synchronizeStoreListings([baseRecord()], { db, storeId, scanRunId: scanRun2 })

		expect(summary.newListings).toBe(0)
		expect(summary.unchangedListings).toBe(1)

		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows).toHaveLength(1)
	})

	test('a changed price updates the listing', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRun1 = await createScanRun(storeId)
		await synchronizeStoreListings([baseRecord()], { db, storeId, scanRunId: scanRun1 })

		const scanRun2 = await createScanRun(storeId)
		const updated = baseRecord({ price: { raw: '399.00', amount: 399, currency: 'MDL' } })
		const summary = await synchronizeStoreListings([updated], { db, storeId, scanRunId: scanRun2 })

		expect(summary.updatedListings).toBe(1)
		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows).toHaveLength(1)
		expect(rows[0].price).toBe('399.00')
		expect(rows[0].lastObservationMissingPrice).toBe(false)
	})

	test('missing price preserves the previous valid price but flags the latest observation as missing it', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRun1 = await createScanRun(storeId)
		await synchronizeStoreListings([baseRecord()], { db, storeId, scanRunId: scanRun1 })

		const scanRun2 = await createScanRun(storeId)
		const noPrice = baseRecord({ price: { raw: null, amount: null, currency: null } })
		const summary = await synchronizeStoreListings([noPrice], { db, storeId, scanRunId: scanRun2 })

		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows).toHaveLength(1)
		// Price must never be silently zeroed or nulled out by a missing observation.
		expect(rows[0].price).toBe('349.00')
		expect(rows[0].currency).toBe('MDL')
		expect(rows[0].lastObservationMissingPrice).toBe(true)
		// The change-detection summary should not call this "updated": the stored price did not actually change.
		expect(summary.unchangedListings).toBe(1)
	})

	test('a changed title or brand updates the corresponding fields', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRun1 = await createScanRun(storeId)
		await synchronizeStoreListings([baseRecord()], { db, storeId, scanRunId: scanRun1 })

		const scanRun2 = await createScanRun(storeId)
		const renamed = baseRecord({
			title: { raw: 'Rose Eau de Parfum Intense', normalized: 'Rose Eau de Parfum Intense' },
			brand: { raw: 'Vizaje Premium', normalized: 'Vizaje Premium' }
		})
		const summary = await synchronizeStoreListings([renamed], { db, storeId, scanRunId: scanRun2 })

		expect(summary.updatedListings).toBe(1)
		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows[0].normalizedTitle).toBe('Rose Eau de Parfum Intense')
		expect(rows[0].brand).toBe('Vizaje Premium')
	})

	test('a malformed record is rejected without touching any valid listing', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRun1 = await createScanRun(storeId)
		await synchronizeStoreListings([baseRecord()], { db, storeId, scanRunId: scanRun1 })

		const scanRun2 = await createScanRun(storeId)
		const malformed = { sourceUrl: 'not-a-valid-url', title: { raw: 'x' } }
		const summary = await synchronizeStoreListings([malformed], { db, storeId, scanRunId: scanRun2 })

		expect(summary.failedRecords).toBe(1)
		expect(summary.errors).toHaveLength(1)

		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows).toHaveLength(1)
		expect(rows[0].normalizedTitle).toBe('Rose Eau de Parfum') // untouched
	})

	test('two stores can list the same product URL without collision', async () => {
		const db = requireDb()
		const storeA = await createStore('shop-a.example.test')
		const storeB = await createStore('shop-b.example.test')
		const scanRunA = await createScanRun(storeA)
		const scanRunB = await createScanRun(storeB)

		const record = baseRecord({ sourceUrl: 'https://shared-path.example.test/products/rose-50ml' })
		await synchronizeStoreListings([record], { db, storeId: storeA, scanRunId: scanRunA })
		await synchronizeStoreListings([record], { db, storeId: storeB, scanRunId: scanRunB })

		const rowsA = await db.select().from(storeListings).where(eq(storeListings.storeId, storeA))
		const rowsB = await db.select().from(storeListings).where(eq(storeListings.storeId, storeB))
		expect(rowsA).toHaveLength(1)
		expect(rowsB).toHaveLength(1)
		expect(rowsA[0].id).not.toBe(rowsB[0].id)
	})

	test('a partial scan (one URL missing from the batch) does not deactivate the missing listing', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRun1 = await createScanRun(storeId)
		const recordA = baseRecord({ sourceUrl: 'https://shop.example.test/products/a' })
		const recordB = baseRecord({ sourceUrl: 'https://shop.example.test/products/b' })
		await synchronizeStoreListings([recordA, recordB], { db, storeId, scanRunId: scanRun1 })

		// Second scan only re-observes "a" — "b" was not discovered/extracted this time.
		const scanRun2 = await createScanRun(storeId)
		await synchronizeStoreListings([recordA], { db, storeId, scanRunId: scanRun2 })

		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows).toHaveLength(2)
		// There is no "active"/"deleted" flag in this schema at all — absence from
		// a scan can never mark a listing inactive, by construction.
	})

	test('concurrent upserts of the same URL do not create duplicate listings', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRunId = await createScanRun(storeId)
		const record = baseRecord()

		await Promise.all(Array.from({ length: 8 }, () => synchronizeStoreListings([record], { db, storeId, scanRunId })))

		const rows = await db.select().from(storeListings).where(eq(storeListings.storeId, storeId))
		expect(rows).toHaveLength(1)
	})

	test('scan run counters and status stay consistent with a mixed batch', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRunId = await startScanRun(db, storeId, 3)

		const good = baseRecord()
		const malformed = { sourceUrl: 'not-a-valid-url' }
		const summary = await synchronizeStoreListings([good, malformed], { db, storeId, scanRunId })

		await finishScanRun(db, {
			scanRunId,
			status: summary.failedRecords > 0 ? 'partial' : 'completed',
			extractedProductCount: 2,
			newListingCount: summary.newListings,
			updatedListingCount: summary.updatedListings,
			failedExtractionCount: summary.failedRecords,
			errorSummary: summary.errors.map((e) => e.message).join('; ') || null
		})

		const [scanRun] = await db.select().from(catalogScanRuns).where(eq(catalogScanRuns.id, scanRunId))
		expect(scanRun.status).toBe('partial')
		expect(scanRun.newListingCount).toBe(1)
		expect(scanRun.failedExtractionCount).toBe(1)
		expect(scanRun.finishedAt).not.toBeNull()
	})

	test('a scan run left in progress is never reported as completed', async () => {
		const db = requireDb()
		const storeId = await createStore('shop-a.example.test')
		const scanRunId = await startScanRun(db, storeId, 1)
		// Simulate a crash: no finishScanRun call.

		const [scanRun] = await db.select().from(catalogScanRuns).where(eq(catalogScanRuns.id, scanRunId))
		expect(scanRun.status).toBe('running')
		expect(scanRun.finishedAt).toBeNull()
	})
})
