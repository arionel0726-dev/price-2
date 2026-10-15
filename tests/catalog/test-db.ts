import { sql } from 'drizzle-orm'
import { createDb, type DbHandle } from '../../src/db'

/**
 * Integration tests need a real PostgreSQL instance. We never point tests at
 * the development database (`DATABASE_URL` from `.env`/compose.yaml) — only
 * at a dedicated test database, so a test run can never destroy dev data.
 *
 * Connection string resolution order:
 * 1. `TEST_DATABASE_URL` env var, if set.
 * 2. A local default matching `compose.yaml`'s credentials but a distinct
 *    database name (`pricewatch_test`), for convenience in this repo.
 *
 * If no PostgreSQL is reachable at all, `openTestDb()` throws, and test
 * files are expected to catch that and report "integration tests skipped"
 * rather than silently passing or falsely claiming success.
 */
const DEFAULT_TEST_DATABASE_URL = 'postgres://pricewatch:pricewatch_dev@127.0.0.1:5432/pricewatch_test'

export function testDatabaseUrl(): string {
	return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
}

export async function openTestDb(): Promise<DbHandle> {
	const handle = createDb(testDatabaseUrl())
	// Fails fast with a clear error if PostgreSQL is unreachable, rather than
	// surfacing a confusing error from deep inside the first real test query.
	await handle.client`select 1`
	return handle
}

/** Wipes all rows between tests. Truncate (not drop) — migrations stay applied. */
export async function resetTestDb(handle: DbHandle): Promise<void> {
	await handle.db.execute(sql`truncate table product_matches, store_listings, catalog_scan_runs, stores restart identity cascade`)
}
