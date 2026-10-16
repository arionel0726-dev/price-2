/**
 * Explicit allowlist of domains the live validation CLI (`validate-live`) is
 * permitted to contact. This is intentionally a short, hand-maintained list
 * — adding a domain here is a deliberate, reviewable act, not something any
 * CLI argument can expand on its own.
 *
 * This is separate from (and in addition to) the SSRF guard in
 * `src/lib/net/ssrf.ts`: the SSRF guard stops requests from reaching
 * private/internal infrastructure for ANY target; this allowlist stops the
 * live validation tool from being pointed at an arbitrary *public* site
 * without that site having been explicitly approved for pilot validation.
 */
const LIVE_VALIDATION_DOMAIN_ALLOWLIST = new Set<string>([
	'vizaje-nica.com',
	'www.vizaje-nica.com',
	'makeup.md',
	'www.makeup.md',
	'ovico.md',
	'www.ovico.md'
])

/**
 * Exact-hostname membership check only — no wildcard, suffix, or subdomain
 * matching. `evil.vizaje-nica.com.attacker.test` or an unlisted subdomain
 * like `shop.makeup.md` are NOT allowlisted just because they contain or
 * end with an allowlisted label; only an exact match (post-lowercasing)
 * passes.
 */
export function isDomainAllowlistedForLiveValidation(domain: string, allowlist: ReadonlySet<string> = LIVE_VALIDATION_DOMAIN_ALLOWLIST): boolean {
	return allowlist.has(domain.toLowerCase())
}

/**
 * Thrown when a live request's final URL or any hop in its redirect chain
 * resolves to a hostname outside the live-validation allowlist. Closes the
 * gap where the allowlist is otherwise only checked once, against
 * `--domain`, before the first request — without this, a same-origin
 * request that redirects to an unrelated (but still publicly routable,
 * i.e. not SSRF-blocked) host would be followed silently.
 */
export class DisallowedRedirectError extends Error {
	constructor(public readonly hostname: string) {
		super(`Refusing to use a response that touched disallowed host "${hostname}" (not on the live-validation allowlist)`)
		this.name = 'DisallowedRedirectError'
	}
}

export { LIVE_VALIDATION_DOMAIN_ALLOWLIST }
