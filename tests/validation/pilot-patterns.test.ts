import { describe, expect, test } from 'bun:test'
import { dedupeLanguageVariants, matchVizajeNicaProductUrl } from '../../src/lib/discovery/pilot-patterns'

describe('matchVizajeNicaProductUrl', () => {
	test('matches a Romanian product URL', () => {
		const result = matchVizajeNicaProductUrl('https://vizaje-nica.com/ro/catalog/antivozsrastnyie-sredstva-dlya-litsa/22006')
		expect(result).toEqual({ language: 'ro', category: 'antivozsrastnyie-sredstva-dlya-litsa', numericId: '22006' })
	})

	test('matches a Russian product URL', () => {
		const result = matchVizajeNicaProductUrl('https://vizaje-nica.com/ru/catalog/parfumuri-dama/31050')
		expect(result?.language).toBe('ru')
	})

	test('does not match a category page without a numeric id', () => {
		expect(matchVizajeNicaProductUrl('https://vizaje-nica.com/ro/catalog/parfumuri-dama/')).toBeNull()
		expect(matchVizajeNicaProductUrl('https://vizaje-nica.com/ro/catalog/parfumuri-dama')).toBeNull()
	})

	test('does not match unrelated paths', () => {
		expect(matchVizajeNicaProductUrl('https://vizaje-nica.com/ro/catalog/search/')).toBeNull()
		expect(matchVizajeNicaProductUrl('https://vizaje-nica.com/assets/logo.png')).toBeNull()
		expect(matchVizajeNicaProductUrl('https://vizaje-nica.com/ro/blog/22006')).toBeNull()
	})

	test('does not match a third language or unknown prefix', () => {
		expect(matchVizajeNicaProductUrl('https://vizaje-nica.com/en/catalog/foo/123')).toBeNull()
	})

	test('returns null for an unparsable URL', () => {
		expect(matchVizajeNicaProductUrl('not a url')).toBeNull()
	})
})

describe('dedupeLanguageVariants', () => {
	test('keeps the Romanian URL when both language variants are present', () => {
		const urls = [
			'https://vizaje-nica.com/ru/catalog/parfumuri-dama/31050',
			'https://vizaje-nica.com/ro/catalog/parfumuri-dama/31050'
		]
		const result = dedupeLanguageVariants(urls)
		expect(result).toEqual(['https://vizaje-nica.com/ro/catalog/parfumuri-dama/31050'])
	})

	test('keeps the Russian URL when no Romanian variant exists', () => {
		const result = dedupeLanguageVariants(['https://vizaje-nica.com/ru/catalog/only-ru/60001'])
		expect(result).toEqual(['https://vizaje-nica.com/ru/catalog/only-ru/60001'])
	})

	test('keeps distinct products separate', () => {
		const result = dedupeLanguageVariants([
			'https://vizaje-nica.com/ro/catalog/rujuri/40120',
			'https://vizaje-nica.com/ro/catalog/rujuri/40121'
		])
		expect(result).toHaveLength(2)
	})

	test('ignores non-matching URLs entirely', () => {
		const result = dedupeLanguageVariants(['https://vizaje-nica.com/ro/catalog/search/', 'https://vizaje-nica.com/assets/logo.png'])
		expect(result).toEqual([])
	})
})
