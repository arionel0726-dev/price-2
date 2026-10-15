import { describe, expect, test } from 'bun:test'
import { dedupeLanguageVariants, matchVizajeNicaProductUrl } from '../../../src/lib/discovery/pilot-patterns'
import { vizajeNicaStoreProfile } from '../../../src/lib/discovery/stores/vizaje-nica'

/**
 * This wrapper must behave identically to the original, empirically
 * verified pilot-patterns.ts functions — see tests/validation/pilot-patterns.test.ts
 * for the exhaustive behavioral tests of the underlying logic. These tests
 * only confirm the StoreProfile adapter delegates correctly.
 */
describe('vizajeNicaStoreProfile', () => {
	test('is marked verified (confirmed against a real live sample)', () => {
		expect(vizajeNicaStoreProfile.patternConfidence).toBe('verified')
	})

	test('classifyProductUrl matches exactly what matchVizajeNicaProductUrl matches', () => {
		const url = 'https://vizaje-nica.com/ro/catalog/parfumuri-dama/31050'
		const original = matchVizajeNicaProductUrl(url)
		const wrapped = vizajeNicaStoreProfile.classifyProductUrl(url)

		expect(wrapped).not.toBeNull()
		expect(wrapped?.dedupeKey).toBe(`${original?.category}/${original?.numericId}`)
		expect(wrapped?.language).toBe(original?.language)
	})

	test('classifyProductUrl returns null for the same non-product URLs the original rejects', () => {
		expect(vizajeNicaStoreProfile.classifyProductUrl('https://vizaje-nica.com/ro/catalog/search/')).toBeNull()
	})

	test('dedupeProductUrls is the original dedupeLanguageVariants function', () => {
		expect(vizajeNicaStoreProfile.dedupeProductUrls).toBe(dedupeLanguageVariants)
	})

	test('sortCandidates orders Romanian URLs before Russian ones, as the original CLI logic did', () => {
		const urls = ['https://vizaje-nica.com/ru/catalog/a/1', 'https://vizaje-nica.com/ro/catalog/b/2']
		const sorted = vizajeNicaStoreProfile.sortCandidates!(urls)
		expect(sorted[0]).toContain('/ro/')
	})
})
