import { describe, expect, test } from 'bun:test'
import { computeNormalizedAttributes } from '../../src/lib/matching/attributes'
import { generateCandidatePairs } from '../../src/lib/matching/candidates'
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

describe('generateCandidatePairs', () => {
	test('does not pair listings that share nothing (no brand, no GTIN, no title token overlap)', () => {
		const source = [computeNormalizedAttributes(listing('a', { normalizedTitle: 'Rose Perfume', brand: 'Vizaje' }))]
		const competitor = [computeNormalizedAttributes(listing('b', { normalizedTitle: 'Sandalwood Soap', brand: 'OtherBrand' }))]

		const result = generateCandidatePairs(source, competitor, 25)
		expect(result.get('a')).toEqual([])
	})

	test('pairs listings sharing a brand even with very different titles', () => {
		const source = [computeNormalizedAttributes(listing('a', { normalizedTitle: 'Rose Perfume', brand: 'Vizaje' }))]
		const competitor = [computeNormalizedAttributes(listing('b', { normalizedTitle: 'Completely Different Title', brand: 'Vizaje' }))]

		const result = generateCandidatePairs(source, competitor, 25)
		expect(result.get('a')).toHaveLength(1)
	})

	test('pairs listings sharing a GTIN', () => {
		const source = [computeNormalizedAttributes(listing('a', { gtin: '5901234123457' }))]
		const competitor = [computeNormalizedAttributes(listing('b', { gtin: '5901234123457' }))]

		const result = generateCandidatePairs(source, competitor, 25)
		expect(result.get('a')).toHaveLength(1)
	})

	test('pairs listings sharing a significant title token', () => {
		const source = [computeNormalizedAttributes(listing('a', { normalizedTitle: 'Rose Eau de Parfum 50ml' }))]
		const competitor = [computeNormalizedAttributes(listing('b', { normalizedTitle: 'Rose Body Lotion 200ml' }))]

		const result = generateCandidatePairs(source, competitor, 25)
		expect(result.get('a')).toHaveLength(1)
	})

	test('bounds candidates per source listing to maxCandidatesPerListing', () => {
		const source = [computeNormalizedAttributes(listing('a', { brand: 'Vizaje', normalizedTitle: 'Rose Perfume' }))]
		const competitor = Array.from({ length: 50 }, (_, i) =>
			computeNormalizedAttributes(listing(`b${i}`, { brand: 'Vizaje', normalizedTitle: `Product Number ${i}` }))
		)

		const result = generateCandidatePairs(source, competitor, 10)
		expect(result.get('a')!.length).toBeLessThanOrEqual(10)
	})

	test('does not produce a full Cartesian product for a larger, mixed catalog', () => {
		const source = Array.from({ length: 20 }, (_, i) => computeNormalizedAttributes(listing(`a${i}`, { brand: `Brand${i}`, normalizedTitle: `Product ${i}` })))
		const competitor = Array.from({ length: 20 }, (_, i) => computeNormalizedAttributes(listing(`b${i}`, { brand: `Brand${i}`, normalizedTitle: `Item ${i}` })))

		const result = generateCandidatePairs(source, competitor, 25)
		let total = 0
		for (const pairs of result.values()) total += pairs.length
		// Each source listing only shares its own distinct brand bucket — total candidates should be ~20, not 20*20=400.
		expect(total).toBeLessThan(40)
	})
})
