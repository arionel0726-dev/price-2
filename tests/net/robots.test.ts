import { describe, expect, test } from 'bun:test'
import { getCrawlDelaySeconds, isAllowedByRobots, parseRobotsTxt } from '../../src/lib/net/robots'

describe('parseRobotsTxt / getCrawlDelaySeconds — Crawl-delay support (Task 7 §9)', () => {
	test('parses a wildcard Crawl-delay, as seen on ovico.md robots.txt', () => {
		const rules = parseRobotsTxt('User-agent: *\nDisallow: /cart\nCrawl-delay: 30\nAllow: /\n')
		expect(getCrawlDelaySeconds(rules, 'any-bot/1.0')).toBe(30)
	})

	test('returns null when no Crawl-delay is specified, never fabricating a value', () => {
		const rules = parseRobotsTxt('User-agent: *\nAllow: /\n')
		expect(getCrawlDelaySeconds(rules, 'any-bot/1.0')).toBeNull()
	})

	test('prefers a more specific user-agent group over the wildcard', () => {
		const rules = parseRobotsTxt('User-agent: *\nCrawl-delay: 10\n\nUser-agent: price2-validation-bot\nCrawl-delay: 45\n')
		expect(getCrawlDelaySeconds(rules, 'price2-validation-bot/0.1')).toBe(45)
		expect(getCrawlDelaySeconds(rules, 'some-other-bot/1.0')).toBe(10)
	})

	test('when multiple non-wildcard groups match, the LONGEST (most specific) token wins, regardless of declaration order', () => {
		// "bot" matches first but is the less specific token; the correct
		// group is "price2-validation-bot", declared second.
		const declaredShortFirst = parseRobotsTxt('User-agent: bot\nCrawl-delay: 5\n\nUser-agent: price2-validation-bot\nCrawl-delay: 45\n')
		expect(getCrawlDelaySeconds(declaredShortFirst, 'price2-validation-bot/0.1')).toBe(45)

		// Same two groups, declared in the opposite order — the result must
		// not depend on which one came first in the file.
		const declaredLongFirst = parseRobotsTxt('User-agent: price2-validation-bot\nCrawl-delay: 45\n\nUser-agent: bot\nCrawl-delay: 5\n')
		expect(getCrawlDelaySeconds(declaredLongFirst, 'price2-validation-bot/0.1')).toBe(45)
	})

	test('ignores a non-numeric or negative Crawl-delay value rather than silently misparsing it', () => {
		const rules = parseRobotsTxt('User-agent: *\nCrawl-delay: not-a-number\n')
		expect(getCrawlDelaySeconds(rules, 'any-bot/1.0')).toBeNull()

		const negative = parseRobotsTxt('User-agent: *\nCrawl-delay: -5\n')
		expect(getCrawlDelaySeconds(negative, 'any-bot/1.0')).toBeNull()
	})

	test('Allow/Disallow group selection also uses the longest matching non-wildcard agent token, not declaration order', () => {
		const rules = parseRobotsTxt(
			'User-agent: bot\nDisallow: /secret\n\nUser-agent: price2-validation-bot\nAllow: /\n'
		)
		expect(isAllowedByRobots(rules, '/secret', 'price2-validation-bot/0.1')).toBe(true)
	})

	test('allow/disallow parsing and matching is unaffected by Crawl-delay support (regression)', () => {
		const rules = parseRobotsTxt('User-agent: *\nDisallow: /cart\nCrawl-delay: 30\nAllow: /\n')
		expect(isAllowedByRobots(rules, '/cart', 'any-bot/1.0')).toBe(false)
		expect(isAllowedByRobots(rules, '/product/1', 'any-bot/1.0')).toBe(true)
	})
})
