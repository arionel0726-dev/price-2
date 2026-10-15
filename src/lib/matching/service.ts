import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { Database } from '../../db'
import { storeListings, productMatches } from '../../db/schema'
import { matchCatalogs } from './engine'
import { DEFAULT_MATCHING_OPTIONS, MATCHING_ALGORITHM_VERSION, type MatchableListing, type MatchDecision, type MatchingOptions, type MatchResult } from './types'

/** Sorts a pair of listing ids so the same unordered pair always maps to the same (listingAId, listingBId) row, regardless of which was "source" in a given run. */
export function canonicalizePair(idX: string, idY: string): [string, string] {
	return idX < idY ? [idX, idY] : [idY, idX]
}

function decisionToStatus(decision: MatchDecision): 'confirmed' | 'pending_review' | 'rejected' {
	if (decision === 'auto_match') return 'confirmed'
	if (decision === 'needs_review') return 'pending_review'
	return 'rejected'
}

async function fetchListingsForStore(db: Database, storeId: string): Promise<MatchableListing[]> {
	const rows = await db
		.select({
			id: storeListings.id,
			storeId: storeListings.storeId,
			sourceTitle: storeListings.sourceTitle,
			normalizedTitle: storeListings.normalizedTitle,
			brand: storeListings.brand,
			sku: storeListings.sku,
			gtin: storeListings.gtin,
			variant: storeListings.variant
		})
		.from(storeListings)
		.where(eq(storeListings.storeId, storeId))

	return rows
}

export interface EvaluateStorePairSummary {
	candidatesConsidered: number
	autoConfirmed: number
	pendingReview: number
	autoRejected: number
	protectedSkipped: number
}

/**
 * Runs the matching engine for every listing in `ownStoreId` against every
 * listing in `competitorStoreId`, then persists each candidate pair found.
 *
 * Idempotent and safe to call repeatedly ("re-evaluation"): a pair whose
 * existing row has `provenance = 'manual'` is left completely untouched
 * (counted in `protectedSkipped`) — this is enforced by the upsert's own
 * `WHERE` clause, atomically, so a concurrent manual confirm/reject can
 * never be silently clobbered by a concurrent re-evaluation.
 */
export async function evaluateStorePair(
	db: Database,
	ownStoreId: string,
	competitorStoreId: string,
	options: MatchingOptions = DEFAULT_MATCHING_OPTIONS
): Promise<EvaluateStorePairSummary> {
	const [ownListings, competitorListings] = await Promise.all([
		fetchListingsForStore(db, ownStoreId),
		fetchListingsForStore(db, competitorStoreId)
	])

	const results = matchCatalogs(ownListings, competitorListings, options)

	const summary: EvaluateStorePairSummary = {
		candidatesConsidered: results.length,
		autoConfirmed: 0,
		pendingReview: 0,
		autoRejected: 0,
		protectedSkipped: 0
	}

	for (const result of results) {
		const wasApplied = await upsertAutomaticMatch(db, result)
		if (!wasApplied) {
			summary.protectedSkipped++
			continue
		}
		if (result.decision === 'auto_match') summary.autoConfirmed++
		else if (result.decision === 'needs_review') summary.pendingReview++
		else summary.autoRejected++
	}

	return summary
}

/**
 * Upserts one automatic match result. Returns false (and changes nothing)
 * when the existing row for this pair is a `manual` decision — the
 * conditional `WHERE product_matches.provenance = 'automatic'` on the
 * conflict action is what makes this check atomic under concurrency: two
 * concurrent evaluations, or an evaluation racing a manual confirm, can
 * never both "win".
 */
async function upsertAutomaticMatch(db: Database, result: MatchResult): Promise<boolean> {
	const [listingAId, listingBId] = canonicalizePair(result.sourceListingId, result.candidateListingId)
	const status = decisionToStatus(result.decision)
	const signals = JSON.stringify({
		positiveSignals: result.positiveSignals,
		conflictingSignals: result.conflictingSignals,
		missingAttributes: result.missingAttributes,
		comparedAttributes: result.comparedAttributes,
		ambiguous: result.ambiguous ?? false
	})

	const rows = await db.execute<{ id: string }>(sql`
		insert into product_matches (
			listing_a_id, listing_b_id, status, provenance, algorithm_version, score, decision, signals, created_at, updated_at
		) values (
			${listingAId}, ${listingBId}, ${status}, 'automatic', ${MATCHING_ALGORITHM_VERSION}, ${result.score}, ${result.decision}, ${signals}::jsonb, now(), now()
		)
		on conflict (listing_a_id, listing_b_id) do update set
			status = excluded.status,
			algorithm_version = excluded.algorithm_version,
			score = excluded.score,
			decision = excluded.decision,
			signals = excluded.signals,
			updated_at = now()
		where product_matches.provenance = 'automatic'
		returning id
	`)

	return rows.length > 0
}

export interface PendingReviewEntry {
	matchId: string
	listingAId: string
	listingBId: string
	score: string | null
	decision: string
	algorithmVersion: string
	signals: unknown
	createdAt: Date
	updatedAt: Date
}

/** Lists rows currently awaiting human review, optionally scoped to listings from a given store pair. */
export async function listPendingReview(db: Database, filters?: { storeId?: string }): Promise<PendingReviewEntry[]> {
	const conditions = [eq(productMatches.status, 'pending_review')]

	if (filters?.storeId) {
		const listingIds = await db.select({ id: storeListings.id }).from(storeListings).where(eq(storeListings.storeId, filters.storeId))
		const ids = listingIds.map((r) => r.id)
		if (ids.length === 0) return []
		conditions.push(or(inArray(productMatches.listingAId, ids), inArray(productMatches.listingBId, ids))!)
	}

	const rows = await db
		.select({
			matchId: productMatches.id,
			listingAId: productMatches.listingAId,
			listingBId: productMatches.listingBId,
			score: productMatches.score,
			decision: productMatches.decision,
			algorithmVersion: productMatches.algorithmVersion,
			signals: productMatches.signals,
			createdAt: productMatches.createdAt,
			updatedAt: productMatches.updatedAt
		})
		.from(productMatches)
		.where(and(...conditions))

	return rows
}

/** Confirms a match as a manual decision. Always allowed — a human can act regardless of the row's prior status/provenance; it is only AUTOMATIC re-evaluation that must never override a manual decision. */
export async function confirmMatch(db: Database, matchId: string, reviewedBy?: string): Promise<void> {
	await db
		.update(productMatches)
		.set({ status: 'confirmed', provenance: 'manual', reviewedBy: reviewedBy ?? null, reviewedAt: new Date(), updatedAt: new Date() })
		.where(eq(productMatches.id, matchId))
}

/** Rejects a match as a manual decision. See `confirmMatch` for why this is always allowed. */
export async function rejectMatch(db: Database, matchId: string, reviewedBy?: string): Promise<void> {
	await db
		.update(productMatches)
		.set({ status: 'rejected', provenance: 'manual', reviewedBy: reviewedBy ?? null, reviewedAt: new Date(), updatedAt: new Date() })
		.where(eq(productMatches.id, matchId))
}

/**
 * Re-runs matching for a store pair. This is the same operation as
 * `evaluateStorePair` — matching is idempotent and always respects manual
 * protection — exposed under its own name for the "re-evaluate automatic
 * candidates" workflow (e.g. after a matching algorithm version bump).
 */
export const reEvaluateStorePair = evaluateStorePair
