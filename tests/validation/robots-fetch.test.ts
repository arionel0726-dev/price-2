import { describe, expect, test } from 'bun:test'
import { fetchRobotsRules, isPathAllowed } from '../../src/lib/net/robots-fetch'

describe('fetchRobotsRules', () => {
	test('parses robots.txt on a successful fetch', async () => {
		const result = await fetchRobotsRules('https://example.test/robots.txt', async () => ({
			status: 200,
			body: 'User-agent: *\nDisallow: /cart\n'
		}))
		expect(result.ok).toBe(true)
	})

	test('fails closed on a transport error', async () => {
		const result = await fetchRobotsRules('https://example.test/robots.txt', async () => {
			throw new Error('ECONNREFUSED')
		})
		expect(result.ok).toBe(false)
	})

	test('fails closed on a non-2xx status (including 404) rather than assuming unrestricted access', async () => {
		const result = await fetchRobotsRules('https://example.test/robots.txt', async () => ({ status: 404, body: '' }))
		expect(result.ok).toBe(false)
	})

	test('fails closed on a 5xx status', async () => {
		const result = await fetchRobotsRules('https://example.test/robots.txt', async () => ({ status: 503, body: '' }))
		expect(result.ok).toBe(false)
	})
})

describe('isPathAllowed', () => {
	test('returns false (not true) when robots rules were never obtained', () => {
		expect(isPathAllowed({ ok: false, reason: 'unreachable' }, '/ro/catalog/foo/1', 'test-bot')).toBe(false)
	})

	test('respects an explicit Disallow prefix', async () => {
		const result = await fetchRobotsRules('https://example.test/robots.txt', async () => ({
			status: 200,
			body: 'User-agent: *\nDisallow: /ro/catalog/disallowed-category/\nAllow: /\n'
		}))
		expect(isPathAllowed(result, '/ro/catalog/disallowed-category/99999', 'test-bot')).toBe(false)
		expect(isPathAllowed(result, '/ro/catalog/parfumuri-dama/31050', 'test-bot')).toBe(true)
	})
})
