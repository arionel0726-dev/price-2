import { describe, expect, test } from 'bun:test'
import { extractLabeledBarcode, validateGtinChecksum } from '../../src/lib/scraping/barcode'

describe('validateGtinChecksum', () => {
	test('accepts a valid EAN-13', () => {
		expect(validateGtinChecksum('5901234123457')).toBe('5901234123457')
		expect(validateGtinChecksum('4006381333931')).toBe('4006381333931')
	})

	test('rejects an invalid checksum', () => {
		expect(validateGtinChecksum('5901234123458')).toBeNull()
	})

	test('rejects non-numeric or wrong-length input', () => {
		expect(validateGtinChecksum('abc')).toBeNull()
		expect(validateGtinChecksum('12345')).toBeNull()
	})
})

describe('extractLabeledBarcode', () => {
	test('extracts a GTIN explicitly labeled in Romanian ("Cod de bare")', () => {
		expect(extractLabeledBarcode('Produs. Cod de bare: 5901234123457. Livrare rapida.')).toBe('5901234123457')
	})

	test('extracts a GTIN explicitly labeled as "EAN"', () => {
		expect(extractLabeledBarcode('EAN: 4006381333931')).toBe('4006381333931')
	})

	test('extracts a GTIN explicitly labeled as "barcode"', () => {
		expect(extractLabeledBarcode('Barcode 5901234123457')).toBe('5901234123457')
	})

	test('never extracts a digit string that is not explicitly labeled as a barcode/GTIN/EAN', () => {
		expect(extractLabeledBarcode('SKU: 5901234123457')).toBeNull()
		expect(extractLabeledBarcode('Pret: 5901234123457 MDL')).toBeNull()
		expect(extractLabeledBarcode('5901234123457')).toBeNull()
	})

	test('never extracts a labeled value that fails the checksum', () => {
		expect(extractLabeledBarcode('Cod de bare: 5901234123458')).toBeNull()
	})

	test('returns null when there is nothing resembling a barcode', () => {
		expect(extractLabeledBarcode('Produs de calitate superioara.')).toBeNull()
	})
})
