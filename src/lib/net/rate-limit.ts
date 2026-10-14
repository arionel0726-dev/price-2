import pLimit from 'p-limit'

export interface DomainSchedulerOptions {
	/** Maximum concurrent in-flight requests across all domains. */
	globalConcurrency?: number
	/** Maximum concurrent in-flight requests per domain. */
	perDomainConcurrency?: number
	/** Minimum delay between the start of two requests to the same domain, in ms. */
	minDelayPerDomainMs?: number
}

/**
 * Schedules async work with bounded global concurrency, bounded per-domain
 * concurrency, and a minimum delay between requests to the same domain
 * ("politeness pacing"). Intended to wrap outbound HTTP calls so a single
 * discovery/scraping run cannot hammer one domain or open unbounded sockets.
 */
export class DomainScheduler {
	private readonly globalLimit: ReturnType<typeof pLimit>
	private readonly domainLimits = new Map<string, ReturnType<typeof pLimit>>()
	private readonly lastStartedAt = new Map<string, number>()
	private readonly perDomainConcurrency: number
	private readonly minDelayPerDomainMs: number

	constructor(options: DomainSchedulerOptions = {}) {
		this.globalLimit = pLimit(options.globalConcurrency ?? 8)
		this.perDomainConcurrency = options.perDomainConcurrency ?? 2
		this.minDelayPerDomainMs = options.minDelayPerDomainMs ?? 500
	}

	private getDomainLimit(domain: string): ReturnType<typeof pLimit> {
		let limit = this.domainLimits.get(domain)
		if (!limit) {
			limit = pLimit(this.perDomainConcurrency)
			this.domainLimits.set(domain, limit)
		}
		return limit
	}

	private async waitForPacing(domain: string): Promise<void> {
		const last = this.lastStartedAt.get(domain)
		if (last === undefined) return
		const elapsed = Date.now() - last
		const remaining = this.minDelayPerDomainMs - elapsed
		if (remaining > 0) {
			await new Promise((resolve) => setTimeout(resolve, remaining))
		}
	}

	schedule<T>(domain: string, task: () => Promise<T>): Promise<T> {
		const domainLimit = this.getDomainLimit(domain)
		return this.globalLimit(() =>
			domainLimit(async () => {
				await this.waitForPacing(domain)
				this.lastStartedAt.set(domain, Date.now())
				return task()
			})
		)
	}
}
