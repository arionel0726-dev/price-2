/**
 * Minimal robots.txt parser.
 *
 * This intentionally implements a subset of the de-facto robots.txt
 * semantics: `User-agent` groups and `Allow` / `Disallow` prefix rules for
 * a single user-agent token, matched case-sensitively by path prefix.
 *
 * Known limitations (documented rather than silently ignored):
 * - No wildcard (`*`, `$`) matching inside Disallow/Allow values.
 * - No `Crawl-delay` or `Sitemap` directive handling (sitemaps are
 *   discovered explicitly by the caller instead).
 * - Group selection uses the first matching `User-agent` section, not the
 *   most specific one as some crawlers do.
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
}

export function parseRobotsTxt(content: string): RobotsRules {
	const groups = new Map<string, RobotsRule[]>()
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
		}
	}

	return { groups }
}

function selectGroup(rules: RobotsRules, userAgent: string): RobotsRule[] {
	const normalizedAgent = userAgent.toLowerCase()
	for (const [agent, group] of rules.groups) {
		if (agent !== '*' && normalizedAgent.includes(agent)) return group
	}
	return rules.groups.get('*') ?? []
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
