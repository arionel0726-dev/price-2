import { matchCatalogs } from './engine'
import { DEFAULT_MATCHING_OPTIONS, type MatchableListing, type MatchingOptions, type MatchResult } from './types'

export type GroundTruthLabel = 'match' | 'no_match' | 'ambiguous'

export interface GroundTruthEntry {
	ownId: string
	competitorId: string
	label: GroundTruthLabel
	category: string
}

export interface RawFixtureListing {
	id: string
	sourceTitle: string | null
	normalizedTitle: string | null
	brand: string | null
	sku: string | null
	gtin: string | null
	variant: string | null
}

export interface MatchingFixture {
	description: string
	ownListings: RawFixtureListing[]
	competitorListings: RawFixtureListing[]
	groundTruth: GroundTruthEntry[]
}

function toMatchableListing(raw: RawFixtureListing, storeId: string): MatchableListing {
	return { ...raw, storeId }
}

export interface LabeledResult {
	entry: GroundTruthEntry
	result: MatchResult | null
	candidateGenerated: boolean
}

export interface EvaluationMetrics {
	totalLabeledPairs: number
	matchLabeledCount: number
	noMatchLabeledCount: number
	ambiguousLabeledCount: number

	truePositivesAuto: number
	truePositivesReview: number
	falseNegatives: number
	trueNegatives: number
	falsePositivesAuto: number
	falsePositivesReview: number

	ambiguousHandledCorrectly: number
	ambiguousMishandled: number

	/** TP_auto / (TP_auto + FP_auto) — precision of the auto_match decision specifically. */
	precisionAuto: number
	/** (TP_auto + TP_review) / matchLabeledCount — fraction of true matches not lost to reject. */
	recallOverall: number
	/** TP_auto / matchLabeledCount — fraction of true matches resolved without any human review. */
	autoMatchCoverage: number
	/** needs_review decisions / totalLabeledPairs. */
	reviewRate: number
}

export interface EvaluationReport {
	metrics: EvaluationMetrics
	labeledResults: LabeledResult[]
	allResults: MatchResult[]
}

/**
 * Runs the matching engine over a labeled fixture and computes precision/
 * recall-style metrics against the ground truth. Metrics are computed only
 * over the pairs explicitly labeled in `groundTruth` — other candidate
 * pairs the engine happens to generate are included in `allResults` for
 * the CLI's "examples" output but do not affect the metrics, since there
 * is no ground truth to judge them against.
 */
export function evaluateFixture(fixture: MatchingFixture, options: MatchingOptions = DEFAULT_MATCHING_OPTIONS): EvaluationReport {
	const ownListings = fixture.ownListings.map((l) => toMatchableListing(l, 'own-store'))
	const competitorListings = fixture.competitorListings.map((l) => toMatchableListing(l, 'competitor-store'))

	const allResults = matchCatalogs(ownListings, competitorListings, options)
	const byPair = new Map<string, MatchResult>()
	for (const r of allResults) byPair.set(`${r.sourceListingId}|${r.candidateListingId}`, r)

	const labeledResults: LabeledResult[] = fixture.groundTruth.map((entry) => {
		const result = byPair.get(`${entry.ownId}|${entry.competitorId}`) ?? null
		return { entry, result, candidateGenerated: result !== null }
	})

	const metrics = computeMetrics(labeledResults)

	return { metrics, labeledResults, allResults }
}

function computeMetrics(labeledResults: LabeledResult[]): EvaluationMetrics {
	let truePositivesAuto = 0
	let truePositivesReview = 0
	let falseNegatives = 0
	let trueNegatives = 0
	let falsePositivesAuto = 0
	let falsePositivesReview = 0
	let ambiguousHandledCorrectly = 0
	let ambiguousMishandled = 0
	let matchLabeledCount = 0
	let noMatchLabeledCount = 0
	let ambiguousLabeledCount = 0
	let reviewCount = 0

	for (const { entry, result } of labeledResults) {
		// A candidate that was never generated at all behaves like 'reject' for every metric below.
		const decision = result?.decision ?? 'reject'
		if (decision === 'needs_review') reviewCount++

		if (entry.label === 'match') {
			matchLabeledCount++
			if (decision === 'auto_match') truePositivesAuto++
			else if (decision === 'needs_review') truePositivesReview++
			else falseNegatives++
		} else if (entry.label === 'no_match') {
			noMatchLabeledCount++
			if (decision === 'auto_match') falsePositivesAuto++
			else if (decision === 'needs_review') falsePositivesReview++
			else trueNegatives++
		} else {
			// 'ambiguous': the only correct engine behavior is needs_review.
			// auto_match here means the engine picked one candidate without
			// sufficient evidence to do so safely — the worst outcome.
			ambiguousLabeledCount++
			if (decision === 'needs_review') ambiguousHandledCorrectly++
			else ambiguousMishandled++
		}
	}

	const totalLabeledPairs = labeledResults.length
	const precisionAuto = truePositivesAuto + falsePositivesAuto === 0 ? 1 : truePositivesAuto / (truePositivesAuto + falsePositivesAuto)
	const recallOverall = matchLabeledCount === 0 ? 1 : (truePositivesAuto + truePositivesReview) / matchLabeledCount
	const autoMatchCoverage = matchLabeledCount === 0 ? 0 : truePositivesAuto / matchLabeledCount
	const reviewRate = totalLabeledPairs === 0 ? 0 : reviewCount / totalLabeledPairs

	return {
		totalLabeledPairs,
		matchLabeledCount,
		noMatchLabeledCount,
		ambiguousLabeledCount,
		truePositivesAuto,
		truePositivesReview,
		falseNegatives,
		trueNegatives,
		falsePositivesAuto,
		falsePositivesReview,
		ambiguousHandledCorrectly,
		ambiguousMishandled,
		precisionAuto: Number(precisionAuto.toFixed(4)),
		recallOverall: Number(recallOverall.toFixed(4)),
		autoMatchCoverage: Number(autoMatchCoverage.toFixed(4)),
		reviewRate: Number(reviewRate.toFixed(4))
	}
}
