export type ScanRunStatus = 'running' | 'completed' | 'failed' | 'partial'

export interface SyncRecordError {
	sourceUrl: string | null
	message: string
}

export interface SyncSummary {
	newListings: number
	updatedListings: number
	unchangedListings: number
	failedRecords: number
	errors: SyncRecordError[]
}

export function emptySyncSummary(): SyncSummary {
	return { newListings: 0, updatedListings: 0, unchangedListings: 0, failedRecords: 0, errors: [] }
}

export function mergeSyncSummaries(a: SyncSummary, b: SyncSummary): SyncSummary {
	return {
		newListings: a.newListings + b.newListings,
		updatedListings: a.updatedListings + b.updatedListings,
		unchangedListings: a.unchangedListings + b.unchangedListings,
		failedRecords: a.failedRecords + b.failedRecords,
		errors: [...a.errors, ...b.errors]
	}
}
