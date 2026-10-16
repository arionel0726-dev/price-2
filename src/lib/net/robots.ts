/**
 * Minimal robots.txt parser.
 *
 * This intentionally implements a subset of the de-facto robots.txt
 * semantics: `User-agent` groups and `Allow` / `Disallow` prefix rules for
 * a single user-agent token, matched case-sensitively by path prefix.
 *
 * Known limitations (documented rather than silently ignored):
 * - No wildcard (`*`, `$`) matching inside Disallow/Allow values.
 * - No `Sitemap` directive handling (sitemaps are discovered explicitly by
 *   the caller instead).
 * - `Crawl-delay` IS parsed (see `getCrawlDelaySeconds` below) — this was
 *   added for Task 7 (ovico.md's robots.txt specifies `Crawl-delay: 30`)
 *   after it was identified as an unsafe gap: the live-mode scheduler must
 *   never silently fall back to a shorter default delay than a site
 *   explicitly asked for.
 * - Group selection prefers the LONGEST matching non-wildcard `User-agent`
 *   token over the wildcard group (see `selectAgentGroup`) — this applies
 *   uniformly to Allow/Disallow matching and to `Crawl-delay` selection, so
 *   neither can be chosen from "whichever group happened to be declared
 *   first" when more than one group's token matches our configured
 *   User-Agent.
 *
 * Before live crawling a real site, these results should be spot-checked
 * against the site's actual published robots.txt by a human.
 */

export interface RobotsRule {
	type: 'allow' | 'disallow'
	path: string
}

export interface RobotsRules {
	groups: Map<string, RobotsRule[]>
	/** Parsed `Crawl-delay` (in seconds) per user-agent group, when present. */
	crawlDelaysSeconds: Map<string, number>
}

export function parseRobotsTxt(content: string): RobotsRules {
	const groups = new Map<string, RobotsRule[]>()
	const crawlDelaysSeconds = new Map<string, number>()
	let currentAgents: string[] = []

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.split('#')[0]?.trim()
		if (!line) continue

		const separatorIndex = line.indexOf(':')
		if (separatorIndex === -1) continue

		const field = line.slice(0, separatorIndex).trim().toLowerCase()
		const value = line.slice(separatorIndex + 1).trim()

		if (field === 'user-agent') {
			currentAgents = [value.toLowerCase()]
			for (const agent of currentAgents) {
				if (!groups.has(agent)) groups.set(agent, [])
			}
			continue
		}

		if (field === 'allow' || field === 'disallow') {
			if (currentAgents.length === 0) continue
			for (const agent of currentAgents) {
				groups.get(agent)?.push({ type: field, path: value })
			}
			continue
		}

		if (field === 'crawl-delay') {
			if (currentAgents.length === 0) continue
			const seconds = Number(value)
			if (!Number.isFinite(seconds) || seconds < 0) continue
			for (const agent of currentAgents) {
				crawlDelaysSeconds.set(agent, seconds)
			}
		}
	}

	return { groups, crawlDelaysSeconds }
}

/**
 * Selects the robots.txt group that applies to `userAgent`: the LONGEST
 * (most specific) declared non-wildcard agent token that is a substring of
 * `userAgent`, falling back to the wildcard group. Longest-match, not
 * declaration order, is what decides this — a robots.txt that declares a
 * narrow group after a broader one (or vice versa) must not change which
 * group our bot is governed by.
 */
function selectAgentGroup(rules: RobotsRules, userAgent: string): string {
	const normalizedAgent = userAgent.toLowerCase()
	let best: string | null = null
	for (const agent of rules.groups.keys()) {
		if (agent === '*') continue
		if (!normalizedAgent.includes(agent)) continue
		if (best === null || agent.length > best.length) best = agent
	}
	return best ?? '*'
}

function selectGroup(rules: RobotsRules, userAgent: string): RobotsRule[] {
	return rules.groups.get(selectAgentGroup(rules, userAgent)) ?? rules.groups.get('*') ?? []
}

/**
 * Returns the `Crawl-delay` (in seconds) that applies to `userAgent`, or
 * `null` when robots.txt did not specify one for this agent/the wildcard
 * group. Callers (see src/scripts/validate-live.ts) must use this to RAISE
 * their request pacing, never to lower it below their own conservative
 * default.
 */
export function getCrawlDelaySeconds(rules: RobotsRules, userAgent: string): number | null {
	const agent = selectAgentGroup(rules, userAgent)
	const delay = rules.crawlDelaysSeconds.get(agent) ?? rules.crawlDelaysSeconds.get('*')
	return delay ?? null
}

/**
 * Returns whether `path` is allowed for `userAgent` under the parsed rules.
 * Longest matching rule wins; ties prefer Allow over Disallow.
 */
export function isAllowedByRobots(rules: RobotsRules, path: string, userAgent: string): boolean {
	const group = selectGroup(rules, userAgent)
	if (group.length === 0) return true

	let bestMatch: RobotsRule | null = null
	for (const rule of group) {
		if (rule.path === '') {
			// An empty Disallow value means "allow everything" per convention.
			if (rule.type === 'disallow') continue
		}
		if (path.startsWith(rule.path)) {
			if (!bestMatch || rule.path.length > bestMatch.path.length) {
				bestMatch = rule
			}
		}
	}

	if (!bestMatch) return true
	return bestMatch.type === 'allow'
}
