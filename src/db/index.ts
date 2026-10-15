import 'dotenv/config'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = PostgresJsDatabase<typeof schema>

export interface DbHandle {
	db: Database
	client: ReturnType<typeof postgres>
}

/**
 * Creates a fresh Drizzle connection for `connectionString`. Used directly
 * by tests (pointed at an isolated test database) and by `getDb()` below
 * for app code. Callers own the returned client and should call
 * `client.end()` when done (tests do this in `afterAll`).
 */
export function createDb(connectionString: string): DbHandle {
	const client = postgres(connectionString, { max: 10 })
	const db = drizzle(client, { schema })
	return { db, client }
}

let appInstance: DbHandle | null = null

/**
 * Lazily creates (once) and returns the app-wide database connection, backed
 * by `DATABASE_URL`. Reading `DATABASE_URL` is deferred to first use (rather
 * than at module import time) so that importing this module never requires
 * an environment variable that only the CLI/worker entry points need.
 */
export function getDb(): Database {
	if (!appInstance) {
		const connectionString = process.env.DATABASE_URL
		if (!connectionString) {
			throw new Error('DATABASE_URL is missing')
		}
		appInstance = createDb(connectionString)
	}
	return appInstance.db
}

/**
 * Closes the app-wide connection opened by `getDb()`, if any. CLI entry
 * points must call this before exiting — a postgres.js client keeps its
 * socket open, which otherwise leaves the process hanging after its work
 * is already done instead of exiting.
 */
export async function closeDb(): Promise<void> {
	if (appInstance) {
		await appInstance.client.end()
		appInstance = null
	}
}
