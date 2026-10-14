import { describe, expect, test } from 'bun:test'
import {
	normalizeAvailability,
	normalizeBrand,
	normalizeTitle,
	normalizeVariant,
	normalizeWhitespace,
	parsePrice
} from '../../src/lib/normalize/normalize'

describe('normalizeWhitespace', () => {
	test('trims and collapses internal whitespace', () => {
		expect(normalizeWhitespace('  Rose   Eau de Parfum  ')).toBe('Rose Eau de Parfum')
	})

	test('returns null for empty or non-string input', () => {
		expect(normalizeWhitespace('   ')).toBeNull()
		expect(normalizeWhitespace(undefined)).toBeNull()
		expect(normalizeWhitespace(42)).toBeNull()
	})
})

describe('normalizeTitle / normalizeBrand', () => {
	test('normalizes a plain string brand', () => {
		expect(normalizeBrand('Vizaje')).toBe('Vizaje')
	})

	test('normalizes a schema.org Brand object', () => {
		expect(normalizeBrand({ '@type': 'Brand', name: ' Vizaje ' })).toBe('Vizaje')
	})

	test('returns null when title is absent', () => {
		expect(normalizeTitle(undefined)).toBeNull()
	})
})

describe('parsePrice', () => {
	test('parses a numeric price', () => {
		expect(parsePrice(189.5, 'MDL')).toEqual({ amount: 189.5, currency: 'MDL' })
	})

	test('parses a string price with a comma decimal separator', () => {
		expect(parsePrice('349,00', 'mdl')).toEqual({ amount: 349, currency: 'MDL' })
	})

	test('does not treat a missing price as zero', () => {
		expect(parsePrice(null, 'MDL')).toEqual({ amount: null, currency: 'MDL' })
		expect(parsePrice(undefined, undefined)).toEqual({ amount: null, currency: null })
	})

	test('returns null amount for an unparsable price rather than 0 or NaN', () => {
		const result = parsePrice('call for price', 'MDL')
		expect(result.amount).toBeNull()
	})
})

describe('normalizeAvailability', () => {
	test('maps schema.org IRIs to normalized states', () => {
		expect(normalizeAvailability('https://schema.org/InStock')).toBe('in_stock')
		expect(normalizeAvailability('http://schema.org/OutOfStock')).toBe('out_of_stock')
		expect(normalizeAvailability('https://schema.org/PreOrder')).toBe('preorder')
	})

	test('distinguishes "absent" (null) from "present but unrecognized" (unknown)', () => {
		expect(normalizeAvailability(undefined)).toBeNull()
		expect(normalizeAvailability(null)).toBeNull()
		expect(normalizeAvailability('https://schema.org/LimitedAvailability')).toBe('unknown')
	})
})

describe('normalizeVariant', () => {
	test('reads an explicit size field', () => {
		expect(normalizeVariant({ size: '100ml' })).toBe('100ml')
	})

	test('reads a matching additionalProperty entry', () => {
		expect(
			normalizeVariant({
				additionalProperty: [{ name: 'Volume', value: '200ml' }]
			})
		).toBe('200ml')
	})

	test('returns null when no explicit variant/size information exists', () => {
		expect(normalizeVariant({ name: 'Ocean Breeze Eau de Toilette' })).toBeNull()
	})
})
