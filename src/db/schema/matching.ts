import { check, index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { storeListings } from './catalog'

/**
 * `pending_review` is the automatic/manual-review queue. `confirmed` and
 * `rejected` are decisions — either made automatically by the engine
 * (`auto_match` / `reject`) or made by a human operator. `provenance`
 * records which; a `manual` row must never be overwritten by a later
 * automatic re-evaluation (see `src/lib/matching/service.ts`).
 */
export const matchStatusEnum = pgEnum('match_status', ['pending_review', 'confirmed', 'rejected'])
export const matchProvenanceEnum = pgEnum('match_provenance', ['automatic', 'manual'])

/**
 * A candidate (or confirmed/rejected) pairing between two store listings
 * from DIFFERENT stores. This is NOT a master product catalog — it only
 * links two existing `store_listings` rows; it never merges or deletes
 * either one.
 *
 * Identity: (listing_a_id, listing_b_id) with listing_a_id < listing_b_id
 * enforced by both the app (see `canonicalizePair` in service.ts) and the
 * CHECK constraint below, so the same unordered pair can never be stored
 * twice regardless of which side was "source" vs "candidate" in a given
 * run.
 */
export const productMatches = pgTable(
	'product_matches',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		listingAId: uuid('listing_a_id')
			.notNull()
			.references(() => storeListings.id, { onDelete: 'cascade' }),
		listingBId: uuid('listing_b_id')
			.notNull()
			.references(() => storeListings.id, { onDelete: 'cascade' }),

		status: matchStatusEnum('status').notNull(),
		provenance: matchProvenanceEnum('provenance').notNull(),

		/** Matching engine version that produced `score`/`decision`/`signals` (see MATCHING_ALGORITHM_VERSION). Preserved across manual confirm/reject so the original automatic proposal stays auditable. */
		algorithmVersion: text('algorithm_version').notNull(),
		/** Last computed score (0..1). Null is not expected but not enforced, in case a future provenance has no numeric score. */
		score: numeric('score', { precision: 5, scale: 4 }),
		/** The engine's own decision ('auto_match' | 'needs_review' | 'reject'), distinct from `status` which also reflects manual actions. */
		decision: text('decision').notNull(),
		/** { positiveSignals, conflictingSignals, missingAttributes, comparedAttributes } — see src/lib/matching/types.ts MatchResult, minus the ids. Kept as JSON so operators can inspect exactly why a match was proposed. */
		signals: jsonb('signals').notNull(),

		reviewedBy: text('reviewed_by'),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		uniqueIndex('product_matches_pair_unique').on(table.listingAId, table.listingBId),
		check('product_matches_pair_order_chk', sql`${table.listingAId} < ${table.listingBId}`),
		index('product_matches_listing_a_idx').on(table.listingAId),
		index('product_matches_listing_b_idx').on(table.listingBId),
		index('product_matches_status_idx').on(table.status)
	]
)
