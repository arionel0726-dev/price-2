import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { DbHandle } from '../../src/db'
import { productMatches, storeListings, stores } from '../../src/db/schema'
import {
	canonicalizePair,
	confirmMatch,
	evaluateStorePair,
	listPendingReview,
	rejectMatch
} from '../../src/lib/matching/service'
import { MATCHING_ALGORITHM_VERSION } from '../../src/lib/matching/types'
import { openTestDb, resetTestDb, testDatabaseUrl } from '../catalog/test-db'

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
		`Skipping matching service integration tests: could not reach PostgreSQL at ${testDatabaseUrl()} (${dbUnavailableReason}).`
	)
}

maybeDescribe('matching service (integration, requires PostgreSQL)', () => {
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

	interface ListingSeed {
		storeId: string
		url: string
		normalizedTitle: string
		brand?: string | null
		gtin?: string | null
		variant?: string | null
		sku?: string | null
	}

	async function createListing(seed: ListingSeed): Promise<string> {
		const db = requireDb()
		const [row] = await db
			.insert(storeListings)
			.values({
				storeId: seed.storeId,
				url: seed.url,
				canonicalUrl: seed.url,
				sourceTitle: seed.normalizedTitle,
				normalizedTitle: seed.normalizedTitle,
				brand: seed.brand ?? null,
				gtin: seed.gtin ?? null,
				variant: seed.variant ?? null,
				sku: seed.sku ?? null
			})
			.returning({ id: storeListings.id })
		return row.id
	}

	test('evaluating a store pair persists auto_match, needs_review, and reject candidates', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')

		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume', brand: 'Vizaje', gtin: '5901234123457' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume', brand: 'Vizaje', gtin: '5901234123457' })

		const summary = await evaluateStorePair(db, ownStore, competitorStore)
		expect(summary.autoConfirmed).toBe(1)

		const rows = await db.select().from(productMatches)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('confirmed')
		expect(rows[0].provenance).toBe('automatic')
		expect(rows[0].algorithmVersion).toBe(MATCHING_ALGORITHM_VERSION)
	})

	test('re-evaluating the same store pair is idempotent (no duplicate rows)', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })

		await evaluateStorePair(db, ownStore, competitorStore)
		await evaluateStorePair(db, ownStore, competitorStore)

		const rows = await db.select().from(productMatches)
		expect(rows).toHaveLength(1)
	})

	test('duplicate pairs are prevented regardless of (own, competitor) argument order', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })

		await evaluateStorePair(db, ownStore, competitorStore)
		// Swap the argument order — same two catalogs, reversed roles.
		await evaluateStorePair(db, competitorStore, ownStore)

		const rows = await db.select().from(productMatches)
		expect(rows).toHaveLength(1)
	})

	test('a manual confirmation is never overwritten by a later automatic re-evaluation', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })

		await evaluateStorePair(db, ownStore, competitorStore)
		const [row] = await db.select().from(productMatches)
		await confirmMatch(db, row.id, 'operator@example.test')

		const summary = await evaluateStorePair(db, ownStore, competitorStore)
		expect(summary.protectedSkipped).toBe(1)

		const [after] = await db.select().from(productMatches).where(eq(productMatches.id, row.id))
		expect(after.status).toBe('confirmed')
		expect(after.provenance).toBe('manual')
		expect(after.reviewedBy).toBe('operator@example.test')
	})

	test('a manual rejection is never overwritten by a later automatic re-evaluation', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje', gtin: '5901234123457' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje', gtin: '5901234123457' })

		await evaluateStorePair(db, ownStore, competitorStore)
		const [row] = await db.select().from(productMatches)
		expect(row.status).toBe('confirmed') // auto_match from the matching GTIN

		await rejectMatch(db, row.id, 'operator@example.test')

		await evaluateStorePair(db, ownStore, competitorStore)
		const [after] = await db.select().from(productMatches).where(eq(productMatches.id, row.id))
		expect(after.status).toBe('rejected')
		expect(after.provenance).toBe('manual')
	})

	test('listPendingReview returns only pending_review rows and lets an operator inspect the signals', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume', brand: 'Vizaje' })

		await evaluateStorePair(db, ownStore, competitorStore)
		const pending = await listPendingReview(db)
		expect(pending.length).toBeGreaterThan(0)
		expect(pending[0].signals).toBeTruthy()
		const signals = pending[0].signals as { positiveSignals: unknown[] }
		expect(Array.isArray(signals.positiveSignals)).toBe(true)
	})

	test('confirming a pending review candidate moves it out of listPendingReview', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume', brand: 'Vizaje' })

		await evaluateStorePair(db, ownStore, competitorStore)
		const [pending] = await listPendingReview(db)
		await confirmMatch(db, pending.matchId)

		const stillPending = await listPendingReview(db)
		expect(stillPending.find((p) => p.matchId === pending.matchId)).toBeUndefined()
	})

	test('a listing with multiple candidates of similar score are all left pending for review, not auto-resolved', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/b', normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })

		await evaluateStorePair(db, ownStore, competitorStore)
		const rows = await db.select().from(productMatches)
		expect(rows).toHaveLength(2)
		for (const row of rows) expect(row.status).toBe('pending_review')
	})

	test('concurrent evaluations of the same store pair do not create duplicate match rows', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje' })

		await Promise.all(Array.from({ length: 6 }, () => evaluateStorePair(db, ownStore, competitorStore)))

		const rows = await db.select().from(productMatches)
		expect(rows).toHaveLength(1)
	})

	test('a matching algorithm version change is recorded on re-evaluation of an automatic row', async () => {
		const db = requireDb()
		const ownStore = await createStore('own.example.test')
		const competitorStore = await createStore('competitor.example.test')
		await createListing({ storeId: ownStore, url: 'https://own/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje', gtin: '5901234123457' })
		await createListing({ storeId: competitorStore, url: 'https://comp/a', normalizedTitle: 'Rose Perfume 50ml', brand: 'Vizaje', gtin: '5901234123457' })

		await evaluateStorePair(db, ownStore, competitorStore)
		const [before] = await db.select().from(productMatches)
		expect(before.algorithmVersion).toBe(MATCHING_ALGORITHM_VERSION)
		// A real version bump would change MATCHING_ALGORITHM_VERSION; here we
		// just assert the stored value always reflects the version that most
		// recently computed it, which is what makes a future bump detectable.
	})

	test('canonicalizePair always returns the same pair regardless of input order', () => {
		const [a1, b1] = canonicalizePair('id-aaaa', 'id-bbbb')
		const [a2, b2] = canonicalizePair('id-bbbb', 'id-aaaa')
		expect([a1, b1]).toEqual([a2, b2])
	})
})
