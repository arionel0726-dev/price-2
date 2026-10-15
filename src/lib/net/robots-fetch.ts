import { isAllowedByRobots, parseRobotsTxt, type RobotsRules } from './robots'

export type RobotsFetchResult = { ok: true; rules: RobotsRules } | { ok: false; reason: string }

export interface RobotsPageFetch {
	status: number
	body: string
}

/**
 * Fetches and parses `robotsUrl`, failing closed (returning `{ ok: false }`)
 * whenever the rules cannot be confidently obtained: a transport error, or
 * any non-2xx HTTP status. A missing/unreachable robots.txt is NOT treated
 * as "no restrictions" here — that is the standard crawler convention, but
 * this tool is deliberately more conservative: if we cannot read the
 * site's actual rules, we do not guess that everything is allowed.
 */
export async function fetchRobotsRules(
	robotsUrl: string,
	fetchPage: (url: string) => Promise<RobotsPageFetch>
): Promise<RobotsFetchResult> {
	let response: RobotsPageFetch
	try {
		response = await fetchPage(robotsUrl)
	} catch (cause) {
		return { ok: false, reason: `Failed to fetch ${robotsUrl}: ${cause instanceof Error ? cause.message : String(cause)}` }
	}

	if (response.status < 200 || response.status >= 300) {
		return { ok: false, reason: `robots.txt fetch returned HTTP ${response.status}; refusing to assume unrestricted access` }
	}

	return { ok: true, rules: parseRobotsTxt(response.body) }
}

/** Convenience wrapper: true only when robots rules were obtained AND explicitly allow `path`. Never defaults to "allowed" on failure. */
export function isPathAllowed(result: RobotsFetchResult, path: string, userAgent: string): boolean {
	if (!result.ok) return false
	return isAllowedByRobots(result.rules, path, userAgent)
}
