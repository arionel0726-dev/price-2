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
	private readonly defaultMinDelayMs: number
	/** Per-domain overrides of the minimum delay — see `raiseMinDelayForDomain`. */
	private readonly minDelayOverrides = new Map<string, number>()

	constructor(options: DomainSchedulerOptions = {}) {
		this.globalLimit = pLimit(options.globalConcurrency ?? 8)
		this.perDomainConcurrency = options.perDomainConcurrency ?? 2
		this.defaultMinDelayMs = options.minDelayPerDomainMs ?? 500
	}

	/**
	 * Raises (never lowers) the minimum delay enforced between requests to
	 * `domain`. Intended for applying a site's robots.txt `Crawl-delay` once
	 * it becomes known (robots.txt must itself be fetched before its own
	 * delay can be read, so this is called after that first fetch, before
	 * any further request to the domain is scheduled — see
	 * src/scripts/validate-live.ts and src/lib/net/robots.ts's
	 * `getCrawlDelaySeconds`). Never silently falls back to a shorter
	 * default: calling this with a smaller value than the current effective
	 * delay is a no-op.
	 */
	raiseMinDelayForDomain(domain: string, ms: number): void {
		const current = this.getMinDelayForDomain(domain)
		if (ms > current) this.minDelayOverrides.set(domain, ms)
	}

	getMinDelayForDomain(domain: string): number {
		return this.minDelayOverrides.get(domain) ?? this.defaultMinDelayMs
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
		const remaining = this.getMinDelayForDomain(domain) - elapsed
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
