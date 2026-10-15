import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { AVAILABILITY_VALUES } from '../../lib/normalize/normalize'
import { stores } from './stores'

export const availabilityStatusEnum = pgEnum('availability_status', AVAILABILITY_VALUES)

/**
 * Explicit scan run states. `running` means the scan has not finished and
 * must never be read as a complete catalog snapshot. `partial` is used when
 * the scan finished but some URLs failed extraction or discovery was
 * truncated — its listing updates are still applied (per-record), but the
 * run itself is not a clean snapshot either.
 */
export const scanRunStatusEnum = pgEnum('scan_run_status', ['running', 'completed', 'failed', 'partial'])

export const catalogScanRuns = pgTable(
	'catalog_scan_runs',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		storeId: uuid('store_id')
			.notNull()
			.references(() => stores.id, { onDelete: 'cascade' }),
		status: scanRunStatusEnum('status').notNull().default('running'),
		startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		discoveredUrlCount: integer('discovered_url_count').notNull().default(0),
		extractedProductCount: integer('extracted_product_count').notNull().default(0),
		newListingCount: integer('new_listing_count').notNull().default(0),
		updatedListingCount: integer('updated_listing_count').notNull().default(0),
		failedExtractionCount: integer('failed_extraction_count').notNull().default(0),
		/** Short human-readable summary of what went wrong, when status is 'failed' or 'partial'. Not a full log. */
		errorSummary: text('error_summary'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [index('catalog_scan_runs_store_started_idx').on(table.storeId, table.startedAt)]
)

/**
 * A product as published by a particular store. This is NOT yet a
 * cross-store product identity — two stores can list what is "the same"
 * product under entirely unrelated rows here. That resolution is explicitly
 * out of scope for this stage (see Task 2 scope notes).
 *
 * Identity for upsert purposes is (storeId, canonicalUrl): see
 * `src/lib/catalog/url.ts` for how canonicalUrl is derived. SKU/GTIN are
 * intentionally NOT used as identity — they are not guaranteed unique
 * within or across stores.
 */
export const storeListings = pgTable(
	'store_listings',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		storeId: uuid('store_id')
			.notNull()
			.references(() => stores.id, { onDelete: 'cascade' }),

		/** The exact URL most recently observed (may include params stripped from canonicalUrl). */
		url: text('url').notNull(),
		/** Conservatively normalized URL used as the dedupe key within a store. See lib/catalog/url.ts. */
		canonicalUrl: text('canonical_url').notNull(),

		sourceTitle: text('source_title'),
		normalizedTitle: text('normalized_title'),
		brand: text('brand'),
		sku: text('sku'),
		gtin: text('gtin'),
		variant: text('variant'),

		/**
		 * Last known VALID price/currency. When a scan observes no price, these
		 * columns are left untouched (never zeroed) — see
		 * `lastObservationMissingPrice` for whether the latest scan actually
		 * saw a price.
		 */
		price: numeric('price', { precision: 12, scale: 2 }),
		currency: text('currency'),
		priceLastSeenAt: timestamp('price_last_seen_at', { withTimezone: true }),
		lastObservationMissingPrice: boolean('last_observation_missing_price').notNull().default(false),

		/** Same pattern as price: last known valid availability, preserved across observations that lack it. */
		availability: availabilityStatusEnum('availability'),
		availabilityLastSeenAt: timestamp('availability_last_seen_at', { withTimezone: true }),
		lastObservationMissingAvailability: boolean('last_observation_missing_availability').notNull().default(false),

		/** Bounded JSON snapshot of the raw JSON-LD node (see lib/catalog/sync.ts for the size cap). */
		rawAttributes: jsonb('raw_attributes'),

		firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
		/** Updated on every scan that successfully extracted this URL, whether or not any field changed. */
		lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).defaultNow().notNull(),
		lastScanRunId: uuid('last_scan_run_id').references(() => catalogScanRuns.id, { onDelete: 'set null' }),

		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		uniqueIndex('store_listings_store_canonical_url_unique').on(table.storeId, table.canonicalUrl),
		index('store_listings_store_sku_idx').on(table.storeId, table.sku),
		index('store_listings_store_gtin_idx').on(table.storeId, table.gtin)
	]
)
