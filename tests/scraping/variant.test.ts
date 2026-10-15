import { describe, expect, test } from 'bun:test'
import { extractVolumeFromTitle } from '../../src/lib/scraping/variant'

describe('extractVolumeFromTitle — supported sizes', () => {
	const cases: [string, string][] = [
		['Apă de Parfum 30ml', '30 ml'],
		['Apă de Parfum 50ml', '50 ml'],
		['MORESQUE Jasminisha 75 ml Apă de parfum', '75 ml'],
		['Apă de Toaletă 100 ml', '100 ml'],
		['Săpun Natural 200g', '200 g'],
		['Loțiune de corp 0.5l', '0.5 l'],
		['Cremă 1kg', '1 kg']
	]

	for (const [title, expected] of cases) {
		test(`extracts "${expected}" from "${title}"`, () => {
			expect(extractVolumeFromTitle(title)?.normalized).toBe(expected)
		})
	}
})

describe('extractVolumeFromTitle — never infers a missing size', () => {
	test('returns null when the title has no unit at all', () => {
		expect(extractVolumeFromTitle('Ruj Mat Catrice')).toBeNull()
	})

	test('returns null for an empty or null title', () => {
		expect(extractVolumeFromTitle('')).toBeNull()
		expect(extractVolumeFromTitle(null)).toBeNull()
	})
})

describe('extractVolumeFromTitle — does not confuse shade codes, model numbers, or SKUs with volume', () => {
	test('a shade code with no unit is not treated as a size', () => {
		expect(extractVolumeFromTitle('Ruj Mat Catrice Shade 010')).toBeNull()
	})

	test('an internal SKU embedded in a title is not treated as a size', () => {
		expect(extractVolumeFromTitle('Parfum VZ-ROSE-50 Editie Limitata')).toBeNull()
	})

	test('a storage-style unit that is not one of our supported units is not matched', () => {
		expect(extractVolumeFromTitle('Dispozitiv 50GB')).toBeNull()
	})

	test('a bare number followed by an unrelated word is not matched', () => {
		expect(extractVolumeFromTitle('Set cadou 5 produse')).toBeNull()
	})
})
