import { describe, expect, test } from 'bun:test'
import { DisallowedRedirectError, isDomainAllowlistedForLiveValidation } from '../../src/lib/net/allowlist'

describe('isDomainAllowlistedForLiveValidation', () => {
	test('allows both pilot domains', () => {
		expect(isDomainAllowlistedForLiveValidation('vizaje-nica.com')).toBe(true)
		expect(isDomainAllowlistedForLiveValidation('makeup.md')).toBe(true)
	})

	test('is case-insensitive', () => {
		expect(isDomainAllowlistedForLiveValidation('Vizaje-Nica.COM')).toBe(true)
		expect(isDomainAllowlistedForLiveValidation('Makeup.MD')).toBe(true)
	})

	test('rejects an arbitrary domain by default', () => {
		expect(isDomainAllowlistedForLiveValidation('example.com')).toBe(false)
		expect(isDomainAllowlistedForLiveValidation('evil.vizaje-nica.com.attacker.test')).toBe(false)
		expect(isDomainAllowlistedForLiveValidation('evil.makeup.md.attacker.test')).toBe(false)
	})

	test('rejects an arbitrary subdomain of an allowlisted domain (exact hostname match only)', () => {
		expect(isDomainAllowlistedForLiveValidation('shop.makeup.md')).toBe(false)
		expect(isDomainAllowlistedForLiveValidation('m.vizaje-nica.com')).toBe(false)
	})

	test('respects an explicit override allowlist (used only by tests, never by the CLI)', () => {
		expect(isDomainAllowlistedForLiveValidation('127.0.0.1:12345', new Set(['127.0.0.1:12345']))).toBe(true)
	})
})

describe('DisallowedRedirectError', () => {
	test('carries the offending hostname and a descriptive message', () => {
		const error = new DisallowedRedirectError('tracker.example.test')
		expect(error.hostname).toBe('tracker.example.test')
		expect(error.message).toContain('tracker.example.test')
		expect(error.name).toBe('DisallowedRedirectError')
	})
})
