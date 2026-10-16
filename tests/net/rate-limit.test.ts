import { describe, expect, test } from 'bun:test'
import { DomainScheduler } from '../../src/lib/net/rate-limit'

describe('DomainScheduler.raiseMinDelayForDomain — enforcing a site-specific Crawl-delay (Task 7 §9)', () => {
	test('raises the enforced delay above the default and is actually honored between two scheduled tasks', async () => {
		const scheduler = new DomainScheduler({ globalConcurrency: 1, perDomainConcurrency: 1, minDelayPerDomainMs: 10 })
		const domain = 'ovico.md'
		scheduler.raiseMinDelayForDomain(domain, 200)

		const timestamps: number[] = []
		await scheduler.schedule(domain, async () => {
			timestamps.push(Date.now())
		})
		await scheduler.schedule(domain, async () => {
			timestamps.push(Date.now())
		})

		expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(190) // allow a little scheduler jitter
	})

	test('never lowers the delay — a smaller raise request is a no-op', () => {
		const scheduler = new DomainScheduler({ minDelayPerDomainMs: 500 })
		const domain = 'ovico.md'
		scheduler.raiseMinDelayForDomain(domain, 100)
		expect(scheduler.getMinDelayForDomain(domain)).toBe(500)
	})

	test('a larger raise request takes effect, and a later smaller one still does not lower it', () => {
		const scheduler = new DomainScheduler({ minDelayPerDomainMs: 500 })
		const domain = 'ovico.md'
		scheduler.raiseMinDelayForDomain(domain, 30_000)
		expect(scheduler.getMinDelayForDomain(domain)).toBe(30_000)
		scheduler.raiseMinDelayForDomain(domain, 1000)
		expect(scheduler.getMinDelayForDomain(domain)).toBe(30_000)
	})

	test('the delay is enforced between request STARTS even when the previous request fails (Task 7 follow-up review §3)', async () => {
		const scheduler = new DomainScheduler({ globalConcurrency: 1, perDomainConcurrency: 1, minDelayPerDomainMs: 10 })
		const domain = 'ovico.md'
		scheduler.raiseMinDelayForDomain(domain, 200)

		const startTimestamps: number[] = []

		await expect(
			scheduler.schedule(domain, async () => {
				startTimestamps.push(Date.now())
				throw new Error('simulated request failure')
			})
		).rejects.toThrow('simulated request failure')

		await scheduler.schedule(domain, async () => {
			startTimestamps.push(Date.now())
		})

		expect(startTimestamps[1] - startTimestamps[0]).toBeGreaterThanOrEqual(190)
	})

	test('an unrelated domain keeps the default delay, unaffected by another domain\'s raise', () => {
		const scheduler = new DomainScheduler({ minDelayPerDomainMs: 500 })
		scheduler.raiseMinDelayForDomain('ovico.md', 30_000)
		expect(scheduler.getMinDelayForDomain('vizaje-nica.com')).toBe(500)
	})
})
