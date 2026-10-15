import { describe, expect, test } from 'bun:test'
import { matchCatalogs } from '../../src/lib/matching/engine'
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

describe('matchCatalogs — ambiguity handling', () => {
	test('two equally strong candidates for the same source listing are both downgraded to needs_review', () => {
		const source = [listing('own-1', { gtin: null, normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })]
		// Two competitor listings, both brand+volume+title matches — genuinely ambiguous.
		const competitor = [
			listing('comp-1', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' }),
			listing('comp-2', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })
		]

		const results = matchCatalogs(source, competitor)
		const forOwn1 = results.filter((r) => r.sourceListingId === 'own-1')
		expect(forOwn1).toHaveLength(2)
		for (const r of forOwn1) {
			expect(r.decision).toBe('needs_review')
			expect(r.ambiguous).toBe(true)
		}
	})

	test('a clearly best candidate (GTIN match) is not downgraded by a much weaker second candidate', () => {
		const source = [listing('own-1', { gtin: '5901234123457', normalizedTitle: 'Rose Perfume', brand: 'Vizaje' })]
		const competitor = [
			listing('comp-1', { gtin: '5901234123457', normalizedTitle: 'Rose Perfume', brand: 'Vizaje' }),
			listing('comp-2', { normalizedTitle: 'Rose Body Lotion 200ml', brand: 'Vizaje' }) // shares brand+token only, much weaker
		]

		const results = matchCatalogs(source, competitor)
		const best = results.find((r) => r.candidateListingId === 'comp-1')
		const weaker = results.find((r) => r.candidateListingId === 'comp-2')
		expect(best?.decision).toBe('auto_match')
		expect(weaker?.decision).not.toBe('auto_match')
	})

	test('matching is deterministic across repeated runs on the same input', () => {
		const source = [listing('own-1', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })]
		const competitor = [listing('comp-1', { normalizedTitle: 'Rose Eau de Parfum 50ml', brand: 'Vizaje' })]

		const first = matchCatalogs(source, competitor)
		const second = matchCatalogs(source, competitor)
		expect(first).toEqual(second)
	})
})
