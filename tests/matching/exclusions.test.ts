import { describe, expect, test } from 'bun:test'
import { computeNormalizedAttributes } from '../../src/lib/matching/attributes'
import { checkHardExclusions } from '../../src/lib/matching/exclusions'
import type { MatchableListing } from '../../src/lib/matching/types'

function listing(overrides: Partial<MatchableListing>): MatchableListing {
	return {
		id: 'id',
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

describe('checkHardExclusions', () => {
	test('excludes different explicit volumes', () => {
		const a = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose EDP 30ml', brand: 'Vizaje' }))
		const b = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose EDP 50ml', brand: 'Vizaje' }))
		const result = checkHardExclusions(a, b)
		expect(result.excluded).toBe(true)
		expect(result.reason?.code).toBe('volume_conflict')
	})

	test('does not exclude volumes within rounding tolerance', () => {
		const a = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose EDP 100ml' }))
		const b = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose EDP 0.1l' }))
		expect(checkHardExclusions(a, b).excluded).toBe(false)
	})

	test('excludes different perfume concentrations', () => {
		const a = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose Eau de Parfum 50ml' }))
		const b = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose Eau de Toilette 50ml' }))
		const result = checkHardExclusions(a, b)
		expect(result.excluded).toBe(true)
		expect(result.reason?.code).toBe('concentration_conflict')
	})

	test('excludes different explicit shade codes', () => {
		const a = computeNormalizedAttributes(listing({ normalizedTitle: 'Lipstick shade 01' }))
		const b = computeNormalizedAttributes(listing({ normalizedTitle: 'Lipstick shade 02' }))
		const result = checkHardExclusions(a, b)
		expect(result.excluded).toBe(true)
		expect(result.reason?.code).toBe('variant_conflict')
	})

	test('excludes refill vs. standard bottle format', () => {
		const a = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose EDP Refill 50ml' }))
		const b = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose EDP Gift Set 50ml' }))
		const result = checkHardExclusions(a, b)
		expect(result.excluded).toBe(true)
		expect(result.reason?.code).toBe('format_conflict')
	})

	test('excludes clearly different brands', () => {
		const a = computeNormalizedAttributes(listing({ brand: 'Chanel' }))
		const b = computeNormalizedAttributes(listing({ brand: 'Dior' }))
		const result = checkHardExclusions(a, b)
		expect(result.excluded).toBe(true)
		expect(result.reason?.code).toBe('brand_conflict')
	})

	test('does not exclude on brand alone when similarity is high (likely transliteration noise)', () => {
		const a = computeNormalizedAttributes(listing({ brand: 'Vizaje' }))
		const b = computeNormalizedAttributes(listing({ brand: 'Vizazhe' }))
		expect(checkHardExclusions(a, b).excluded).toBe(false)
	})

	test('excludes conflicting valid GTINs', () => {
		const a = computeNormalizedAttributes(listing({ gtin: '5901234123457' }))
		const b = computeNormalizedAttributes(listing({ gtin: '4006381333931' }))
		const result = checkHardExclusions(a, b)
		expect(result.excluded).toBe(true)
		expect(result.reason?.code).toBe('gtin_conflict')
	})

	test('does not exclude conflicting GTINs when one side is an explicit gift set (bundle exception)', () => {
		const a = computeNormalizedAttributes(listing({ gtin: '5901234123457', normalizedTitle: 'Rose EDP 50ml' }))
		const b = computeNormalizedAttributes(listing({ gtin: '4006381333931', normalizedTitle: 'Rose Gift Set' }))
		expect(checkHardExclusions(a, b).excluded).toBe(false)
	})

	test('never excludes on a missing attribute alone', () => {
		const a = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose EDP 50ml', brand: 'Vizaje' }))
		const b = computeNormalizedAttributes(listing({ normalizedTitle: 'Rose 50ml' })) // no brand, no concentration
		expect(checkHardExclusions(a, b).excluded).toBe(false)
	})
})
