import { describe, expect, test } from 'bun:test'
import { isDomainAllowlistedForLiveValidation } from '../../src/lib/net/allowlist'

describe('isDomainAllowlistedForLiveValidation', () => {
	test('allows the pilot domain', () => {
		expect(isDomainAllowlistedForLiveValidation('vizaje-nica.com')).toBe(true)
	})

	test('is case-insensitive', () => {
		expect(isDomainAllowlistedForLiveValidation('Vizaje-Nica.COM')).toBe(true)
	})

	test('rejects an arbitrary domain by default', () => {
		expect(isDomainAllowlistedForLiveValidation('example.com')).toBe(false)
		expect(isDomainAllowlistedForLiveValidation('evil.vizaje-nica.com.attacker.test')).toBe(false)
	})

	test('respects an explicit override allowlist (used only by tests, never by the CLI)', () => {
		expect(isDomainAllowlistedForLiveValidation('127.0.0.1:12345', new Set(['127.0.0.1:12345']))).toBe(true)
	})
})
