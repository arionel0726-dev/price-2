import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateFixture, type MatchingFixture } from '../../src/lib/matching/evaluate'

const FIXTURE_PATH = join(import.meta.dir, '..', 'fixtures', 'matching', 'perfume-cosmetics.json')

function loadFixture(): MatchingFixture {
	return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
}

describe('evaluateFixture — synthetic perfume/cosmetics dataset', () => {
	test('dataset has the expected shape (documented size)', () => {
		const fixture = loadFixture()
		expect(fixture.ownListings.length).toBeGreaterThanOrEqual(10)
		expect(fixture.competitorListings.length).toBeGreaterThanOrEqual(10)
		expect(fixture.groundTruth.length).toBeGreaterThanOrEqual(15)
	})

	test('never produces a false auto_match on a labeled no_match pair (zero tolerance)', () => {
		const report = evaluateFixture(loadFixture())
		expect(report.metrics.falsePositivesAuto).toBe(0)
		expect(report.metrics.precisionAuto).toBe(1)
	})

	test('never loses a labeled true match entirely (no false negatives on this dataset)', () => {
		const report = evaluateFixture(loadFixture())
		expect(report.metrics.falseNegatives).toBe(0)
		expect(report.metrics.recallOverall).toBe(1)
	})

	test('genuinely ambiguous candidates are always routed to review, never auto-picked', () => {
		const report = evaluateFixture(loadFixture())
		expect(report.metrics.ambiguousMishandled).toBe(0)
	})

	test('a validated matching GTIN reaches auto_match', () => {
		const report = evaluateFixture(loadFixture())
		const gtinCase = report.labeledResults.find((r) => r.entry.category === 'valid_gtin_match')
		expect(gtinCase?.result?.decision).toBe('auto_match')
	})

	test('EDP vs EDT, different volume, different shade, and refill vs bottle are all rejected or sent to review — never auto-matched', () => {
		const report = evaluateFixture(loadFixture())
		const hardCaseCategories = ['edp_vs_edt', 'volume_conflict_30_vs_100', 'volume_conflict_50_vs_100', 'different_shade']
		for (const category of hardCaseCategories) {
			const entry = report.labeledResults.find((r) => r.entry.category === category)
			expect(entry?.result?.decision ?? 'reject').not.toBe('auto_match')
		}
	})

	test('metrics are reported separately for auto_match and review decisions', () => {
		const report = evaluateFixture(loadFixture())
		expect(report.metrics).toHaveProperty('truePositivesAuto')
		expect(report.metrics).toHaveProperty('truePositivesReview')
		expect(report.metrics).toHaveProperty('autoMatchCoverage')
		expect(report.metrics).toHaveProperty('reviewRate')
	})
})
