import { eq } from 'drizzle-orm'
import type { Database } from '../../db'
import { catalogScanRuns } from '../../db/schema'
import type { ScanRunStatus } from './types'

/** Starts a scan run row in the 'running' state. Must be followed by `finishScanRun`. */
export async function startScanRun(db: Database, storeId: string, discoveredUrlCount: number): Promise<string> {
	const [row] = await db
		.insert(catalogScanRuns)
		.values({ storeId, status: 'running', discoveredUrlCount })
		.returning({ id: catalogScanRuns.id })

	return row.id
}

export interface FinishScanRunInput {
	scanRunId: string
	status: ScanRunStatus
	extractedProductCount: number
	newListingCount: number
	updatedListingCount: number
	failedExtractionCount: number
	errorSummary?: string | null
}

/**
 * Marks a scan run as finished with its final counters and status. A
 * 'running' status must never be left in place after this call — callers
 * are expected to always reach this (e.g. via try/finally) so a crashed
 * process leaves the row at 'running' rather than falsely 'completed'.
 */
export async function finishScanRun(db: Database, input: FinishScanRunInput): Promise<void> {
	await db
		.update(catalogScanRuns)
		.set({
			status: input.status,
			finishedAt: new Date(),
			extractedProductCount: input.extractedProductCount,
			newListingCount: input.newListingCount,
			updatedListingCount: input.updatedListingCount,
			failedExtractionCount: input.failedExtractionCount,
			errorSummary: input.errorSummary ?? null
		})
		.where(eq(catalogScanRuns.id, input.scanRunId))
}
