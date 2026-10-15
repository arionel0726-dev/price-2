import { describe, expect, test } from 'bun:test'
import { getStoreProfile, makeupMdStoreProfile, vizajeNicaStoreProfile } from '../../../src/lib/discovery/stores/registry'

describe('getStoreProfile', () => {
	test('returns the vizaje-nica.com profile', () => {
		expect(getStoreProfile('vizaje-nica.com')).toBe(vizajeNicaStoreProfile)
	})

	test('returns the makeup.md profile', () => {
		expect(getStoreProfile('makeup.md')).toBe(makeupMdStoreProfile)
	})

	test('is case-insensitive', () => {
		expect(getStoreProfile('Makeup.MD')).toBe(makeupMdStoreProfile)
	})

	test('returns null for an unregistered domain rather than guessing a profile', () => {
		expect(getStoreProfile('example.com')).toBeNull()
		expect(getStoreProfile('shop.makeup.md')).toBeNull()
	})
})
