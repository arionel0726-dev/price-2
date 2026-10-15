import { sql } from 'drizzle-orm'
import type { Database } from '../../db'
import { NormalizedProductRecordSchema, type NormalizedProductRecord } from '../scraping/types'
import { canonicalizeProductUrl } from './url'
import { emptySyncSummary, mergeSyncSummaries, type SyncSummary } from './types'

const MAX_RAW_ATTRIBUTES_BYTES = 8192

/**
 * Caps the stored JSON-LD snapshot so one unusually large page cannot bloat
 * the table. Oversized nodes are replaced with a small marker plus a short
 * preview, rather than silently truncated mid-JSON (which would produce
 * invalid JSON) or dropped entirely (which would lose the diagnostic value).
 */
function capRawAttributes(node: Record<string, unknown>): Record<string, unknown> {
	const json = JSON.stringify(node)
	const byteLength = Buffer.byteLength(json, 'utf-8')
	if (byteLength <= MAX_RAW_ATTRIBUTES_BYTES) return node
	return {
		truncated: true,
		originalSizeBytes: byteLength,
		preview: json.slice(0, 512)
	}
}

interface UpsertOutcome {
	inserted: boolean
	changed: boolean
}

/**
 * Upserts a single listing as one atomic SQL statement (INSERT ... ON
 * CONFLICT (store_id, canonical_url) DO UPDATE). This is what makes
 * concurrent synchronization of the same URL safe: Postgres serializes
 * conflicting writers on the unique index itself, so two concurrent calls
 * can never create two rows for the same (store, canonical URL).
 *
 * Price and availability use COALESCE against the previous row so that an
 * observation missing one of those fields never erases a previously valid
 * value; `last_observation_missing_price` / `..._availability` separately
 * record whether *this* observation had the field, so staleness is still
 * visible downstream.
 *
 * Known limitation: the `existing` CTE reads the pre-statement snapshot of
 * the row to compute the new-vs-updated distinction returned here. Under
 * true concurrent writes to the exact same (store, canonical URL) within
 * the same instant, the transaction that waits on the other's row lock may
 * report a stale "unchanged/new" classification once it proceeds — this
 * only affects the informational SyncSummary counters, never the stored
 * data, which is always correctly upserted by the ON CONFLICT clause.
 */
async function upsertOneListing(
	db: Database,
	storeId: string,
	scanRunId: string,
	record: NormalizedProductRecord,
	canonicalUrl: string
): Promise<UpsertOutcome> {
	const price = record.price.amount
	const currency = record.price.currency
	const availability = record.availability.normalized
	// postgres.js (via drizzle's raw `sql` executor) does not auto-serialize
	// JS Date objects passed as bind parameters, so we pass ISO strings and
	// let Postgres parse them — same effect as using Date objects through
	// the query builder, just explicit here since this is a raw statement.
	const observedAt = new Date(record.extractedAt).toISOString()
	const missingPrice = price === null
	const missingAvailability = availability === null
	const rawAttributesJson = JSON.stringify(capRawAttributes(record.rawJsonLd))

	const rows = await db.execute<{
		id: string
		inserted: boolean
		old_normalized_title: string | null
		old_brand: string | null
		old_sku: string | null
		old_gtin: string | null
		old_variant: string | null
		old_price: string | null
		old_currency: string | null
		old_availability: string | null
		normalized_title: string | null
		brand: string | null
		sku: string | null
		gtin: string | null
		variant: string | null
		price_out: string | null
		currency_out: string | null
		availability_out: string | null
	}>(sql`
		with existing as (
			select * from store_listings
			where store_id = ${storeId} and canonical_url = ${canonicalUrl}
		),
		upserted as (
			insert into store_listings (
				store_id, url, canonical_url, source_title, normalized_title, brand, sku, gtin, variant,
				price, currency, price_last_seen_at, last_observation_missing_price,
				availability, availability_last_seen_at, last_observation_missing_availability,
				raw_attributes, first_seen_at, last_observed_at, last_scan_run_id, created_at, updated_at
			) values (
				${storeId}, ${record.sourceUrl}, ${canonicalUrl}, ${record.title.raw}, ${record.title.normalized},
				${record.brand.normalized}, ${record.sku}, ${record.gtin}, ${record.variant.normalized},
				${price}, ${currency}, ${missingPrice ? null : observedAt}, ${missingPrice},
				${availability}, ${missingAvailability ? null : observedAt}, ${missingAvailability},
				${rawAttributesJson}::jsonb, ${observedAt}, ${observedAt}, ${scanRunId}, now(), now()
			)
			on conflict (store_id, canonical_url) do update set
				url = excluded.url,
				source_title = excluded.source_title,
				normalized_title = excluded.normalized_title,
				brand = excluded.brand,
				sku = excluded.sku,
				gtin = excluded.gtin,
				variant = excluded.variant,
				price = coalesce(excluded.price, store_listings.price),
				currency = coalesce(excluded.currency, store_listings.currency),
				price_last_seen_at = case when excluded.price is not null then excluded.price_last_seen_at else store_listings.price_last_seen_at end,
				last_observation_missing_price = excluded.last_observation_missing_price,
				availability = coalesce(excluded.availability, store_listings.availability),
				availability_last_seen_at = case when excluded.availability is not null then excluded.availability_last_seen_at else store_listings.availability_last_seen_at end,
				last_observation_missing_availability = excluded.last_observation_missing_availability,
				raw_attributes = excluded.raw_attributes,
				last_observed_at = excluded.last_observed_at,
				last_scan_run_id = excluded.last_scan_run_id,
				updated_at = now()
			returning *, (xmax = 0) as inserted
		)
		select
			upserted.id,
			upserted.inserted,
			upserted.normalized_title,
			upserted.brand,
			upserted.sku,
			upserted.gtin,
			upserted.variant,
			upserted.price as price_out,
			upserted.currency as currency_out,
			upserted.availability as availability_out,
			existing.normalized_title as old_normalized_title,
			existing.brand as old_brand,
			existing.sku as old_sku,
			existing.gtin as old_gtin,
			existing.variant as old_variant,
			existing.price as old_price,
			existing.currency as old_currency,
			existing.availability as old_availability
		from upserted left join existing on true
	`)

	const row = rows[0]
	if (!row) {
		throw new Error('Upsert returned no row')
	}

	if (row.inserted) {
		return { inserted: true, changed: true }
	}

	const changed =
		row.old_normalized_title !== row.normalized_title ||
		row.old_brand !== row.brand ||
		row.old_sku !== row.sku ||
		row.old_gtin !== row.gtin ||
		row.old_variant !== row.variant ||
		row.old_price !== row.price_out ||
		row.old_currency !== row.currency_out ||
		row.old_availability !== row.availability_out

	return { inserted: false, changed }
}

export interface SyncStoreListingsOptions {
	db: Database
	storeId: string
	scanRunId: string
}

/**
 * Synchronizes a batch of extracted product records into `store_listings`
 * for one store/scan run. Accepts `unknown[]` (not already-typed
 * `NormalizedProductRecord[]`) and validates each record itself — a
 * malformed record is reported in the summary and does not affect any
 * other record or abort the batch.
 */
export async function synchronizeStoreListings(
	rawRecords: unknown[],
	options: SyncStoreListingsOptions
): Promise<SyncSummary> {
	let summary = emptySyncSummary()

	for (const rawRecord of rawRecords) {
		const parsed = NormalizedProductRecordSchema.safeParse(rawRecord)
		if (!parsed.success) {
			const sourceUrl =
				rawRecord && typeof rawRecord === 'object' && 'sourceUrl' in rawRecord && typeof (rawRecord as { sourceUrl: unknown }).sourceUrl === 'string'
					? ((rawRecord as { sourceUrl: string }).sourceUrl)
					: null
			summary = mergeSyncSummaries(summary, {
				newListings: 0,
				updatedListings: 0,
				unchangedListings: 0,
				failedRecords: 1,
				errors: [{ sourceUrl, message: `Schema validation failed: ${parsed.error.message}` }]
			})
			continue
		}

		const record = parsed.data

		let canonicalUrl: string
		try {
			canonicalUrl = canonicalizeProductUrl(record.sourceUrl)
		} catch (cause) {
			summary = mergeSyncSummaries(summary, {
				newListings: 0,
				updatedListings: 0,
				unchangedListings: 0,
				failedRecords: 1,
				errors: [{ sourceUrl: record.sourceUrl, message: cause instanceof Error ? cause.message : String(cause) }]
			})
			continue
		}

		try {
			const outcome = await upsertOneListing(options.db, options.storeId, options.scanRunId, record, canonicalUrl)
			summary = mergeSyncSummaries(summary, {
				newListings: outcome.inserted ? 1 : 0,
				updatedListings: !outcome.inserted && outcome.changed ? 1 : 0,
				unchangedListings: !outcome.inserted && !outcome.changed ? 1 : 0,
				failedRecords: 0,
				errors: []
			})
		} catch (cause) {
			summary = mergeSyncSummaries(summary, {
				newListings: 0,
				updatedListings: 0,
				unchangedListings: 0,
				failedRecords: 1,
				errors: [{ sourceUrl: record.sourceUrl, message: cause instanceof Error ? cause.message : String(cause) }]
			})
		}
	}

	return summary
}
