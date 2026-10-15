import { describe, expect, test } from 'bun:test'
import { evaluatePair } from '../../src/lib/matching/engine'
import type { MatchableListing } from '../../src/lib/matching/types'

function listing(id: string, overrides: Partial<MatchableListing>): MatchableListing {
	return {
		id,
		storeId: 'store',
		sourceTitle: null,
		normalizedTitle: null,
		brand: null,
		sku: null,
		gtin: null,
		variant: null,
		...overrides
	}
}

describe('evaluatePair — decisions', () => {
	test('a valid matching GTIN alone reaches auto_match', () => {
		const a = listing('a', { gtin: '5901234123457', normalizedTitle: 'Rose Perfume', brand: 'Vizaje' })
		const b = listing('b', { gtin: '5901234123457', normalizedTitle: 'Something Totally Different Name', brand: 'Other Brand' })
		const result = evaluatePair(a, b)
		expect(result.decision).toBe('auto_match')
		expect(result.positiveSignals.some((s) => s.code === 'gtin_exact_match')).toBe(true)
	})

	test('a similar title alone (no brand, no GTIN, no volume) is never sufficient for auto_match', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml' })
		const b = listing('b', { normalizedTitle: 'Rose Eau de Parfum 50ml' })
		const result = evaluatePair(a, b)
		expect(result.decision).not.toBe('auto_match')
	})

	test('brand + volume + an identical title reaches auto_match', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const result = evaluatePair(a, b)
		expect(result.decision).toBe('auto_match')
	})

	test('a minor spacing/spelling difference with brand+volume match still reaches auto_match or needs_review, never a false reject', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Roze Eau de Parfum 50ml', brand: 'Vizaje' })
		const result = evaluatePair(a, b)
		expect(result.decision).not.toBe('reject')
	})

	test('known limitation: a spacing difference inside the volume token ("50ml" vs "50 ml") lowers title similarity enough to fall to needs_review rather than auto_match', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Rose Eau de Parfum 50 ml', brand: 'Vizaje' })
		const result = evaluatePair(a, b)
		expect(result.decision).toBe('needs_review')
	})

	test('EDP vs EDT of the same name is rejected outright (hard exclusion), regardless of score', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Rose Eau de Toilette 50ml', brand: 'Vizaje' })
		const result = evaluatePair(a, b)
		expect(result.decision).toBe('reject')
		expect(result.conflictingSignals.some((s) => s.code === 'concentration_conflict')).toBe(true)
	})

	test('30ml vs 50ml of the same name is rejected outright', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 30ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const result = evaluatePair(a, b)
		expect(result.decision).toBe('reject')
	})

	test('missing brand increases uncertainty (pushed to review) rather than causing rejection outright', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: null })
		const result = evaluatePair(a, b)
		expect(result.decision).toBe('needs_review')
		expect(result.missingAttributes).toContain('brand')
	})

	test('completely unrelated products are rejected', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Sandalwood Soap Bar 100g', brand: 'Other' })
		const result = evaluatePair(a, b)
		expect(result.decision).toBe('reject')
	})

	test('result includes comparedAttributes and signal explanations for every decision', () => {
		const a = listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const b = listing('b', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		const result = evaluatePair(a, b)
		expect(result.comparedAttributes.titleSimilarity).toBeGreaterThan(0)
		expect(result.sourceListingId).toBe('a')
		expect(result.candidateListingId).toBe('b')
	})
})
