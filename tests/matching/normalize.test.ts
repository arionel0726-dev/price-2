import { describe, expect, test } from 'bun:test'
import {
	diceBigramSimilarity,
	jaccardTokenSimilarity,
	normalizeBrandForMatching,
	normalizeTitleForMatching,
	parseConcentration,
	parseFormat,
	parseVariantCode,
	parseVolume,
	titleSimilarity,
	tokenize,
	validateGtin
} from '../../src/lib/matching/normalize'

describe('normalizeBrandForMatching', () => {
	test('folds accents and case', () => {
		expect(normalizeBrandForMatching('Chânel')).toBe('chanel')
	})

	test('applies the curated Cyrillic transliteration dictionary', () => {
		expect(normalizeBrandForMatching('Шанель')).toBe('chanel')
		expect(normalizeBrandForMatching('Диор')).toBe('dior')
	})

	test('falls back to generic Cyrillic transliteration for unknown brands', () => {
		expect(normalizeBrandForMatching('Виzaже')).toBe('vizazhe')
	})

	test('returns null for missing input', () => {
		expect(normalizeBrandForMatching(null)).toBeNull()
	})
})

describe('normalizeTitleForMatching', () => {
	test('does not strip concentration abbreviations', () => {
		expect(normalizeTitleForMatching('Rose EDP 50ml')).toContain('edp')
		expect(normalizeTitleForMatching('Rose EDT 50ml')).toContain('edt')
	})

	test('folds punctuation to whitespace without losing tokens', () => {
		expect(normalizeTitleForMatching("L'Eau D'Issey")).toBe('l eau d issey')
	})
})

describe('parseVolume', () => {
	test('parses ml directly', () => {
		expect(parseVolume('rose edp 50ml')).toEqual({ value: 50, unit: 'ml', raw: '50ml' })
	})

	test('converts liters to ml', () => {
		expect(parseVolume('shower gel 0.5l')).toEqual({ value: 500, unit: 'ml', raw: '0.5l' })
	})

	test('converts kg to g', () => {
		expect(parseVolume('body scrub 1kg')).toEqual({ value: 1000, unit: 'g', raw: '1kg' })
	})

	test('returns null when no explicit volume is present', () => {
		expect(parseVolume('rose eau de parfum')).toBeNull()
	})
})

describe('parseConcentration', () => {
	test('recognizes edp/edt/edc variants and full names', () => {
		expect(parseConcentration('rose eau de parfum 50ml')).toBe('edp')
		expect(parseConcentration('rose eau de toilette 50ml')).toBe('edt')
		expect(parseConcentration('rose edc 100ml')).toBe('edc')
		expect(parseConcentration('rose parfum 50ml')).toBe('parfum')
	})

	test('returns null when no concentration marker is present', () => {
		expect(parseConcentration('rose body lotion 200ml')).toBeNull()
	})
})

describe('parseVariantCode', () => {
	test('extracts an explicit shade number', () => {
		expect(parseVariantCode('lipstick shade 01')).toBe('1')
		expect(parseVariantCode('lipstick № 02')).toBe('2')
	})

	test('returns null without an explicit code', () => {
		expect(parseVariantCode('lipstick red')).toBeNull()
	})
})

describe('parseFormat', () => {
	test('detects refill and set/kit markers', () => {
		expect(parseFormat('rose edp refill 50ml')).toBe('refill')
		expect(parseFormat('rose gift set')).toBe('set')
	})

	test('returns null for a standard bottle', () => {
		expect(parseFormat('rose edp 50ml')).toBeNull()
	})
})

describe('validateGtin', () => {
	test('accepts a valid EAN-13 checksum', () => {
		expect(validateGtin('5901234123457')).toBe('5901234123457')
	})

	test('rejects an invalid checksum', () => {
		expect(validateGtin('5901234123458')).toBeNull()
	})

	test('rejects non-numeric or wrong-length input', () => {
		expect(validateGtin('abc')).toBeNull()
		expect(validateGtin('12345')).toBeNull()
		expect(validateGtin(null)).toBeNull()
	})
})

describe('similarity helpers', () => {
	test('diceBigramSimilarity is tolerant of minor spelling differences', () => {
		const sim = diceBigramSimilarity('chanel no 5', 'chanel no5')
		expect(sim).toBeGreaterThan(0.8)
	})

	test('jaccardTokenSimilarity is tolerant of word reordering', () => {
		const sim = jaccardTokenSimilarity(tokenize('rose eau de parfum'), tokenize('eau de parfum rose'))
		expect(sim).toBe(1)
	})

	test('titleSimilarity returns 0 for completely different titles', () => {
		expect(titleSimilarity('rose eau de parfum', 'sandalwood soap bar')).toBeLessThan(0.3)
	})
})
