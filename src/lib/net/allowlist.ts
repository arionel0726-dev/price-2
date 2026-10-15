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
const LIVE_VALIDATION_DOMAIN_ALLOWLIST = new Set<string>(['vizaje-nica.com', 'www.vizaje-nica.com'])

export function isDomainAllowlistedForLiveValidation(domain: string, allowlist: ReadonlySet<string> = LIVE_VALIDATION_DOMAIN_ALLOWLIST): boolean {
	return allowlist.has(domain.toLowerCase())
}

export { LIVE_VALIDATION_DOMAIN_ALLOWLIST }
