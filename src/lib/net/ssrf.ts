/**
 * SSRF (server-side request forgery) guard helpers.
 *
 * These helpers classify resolved IP addresses as private/reserved/loopback
 * so that the safe HTTP client (see `safe-fetch.ts`) can refuse to connect
 * to internal infrastructure, even when the target hostname's DNS record
 * changes between validation and connection ("DNS rebinding").
 *
 * Limitation: this module only validates IP address ranges. It does not
 * attempt to detect application-level SSRF (e.g. a target server that
 * itself proxies requests onward).
 */

export const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export function isAllowedProtocol(protocol: string): boolean {
	return ALLOWED_PROTOCOLS.has(protocol)
}

/** Parses an IPv4 string into four octets, or returns null if invalid. */
function parseIPv4(address: string): [number, number, number, number] | null {
	const parts = address.split('.')
	if (parts.length !== 4) return null
	const octets: number[] = []
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const n = Number(part)
		if (n < 0 || n > 255) return null
		octets.push(n)
	}
	return octets as [number, number, number, number]
}

/** Returns true if the IPv4 address is private, reserved, loopback, or otherwise unsafe to connect to. */
export function isPrivateOrReservedIPv4(address: string): boolean {
	const octets = parseIPv4(address)
	if (!octets) return true // fail closed on unparsable input
	const [a, b] = octets

	if (a === 0) return true // "this network"
	if (a === 10) return true // RFC1918
	if (a === 127) return true // loopback
	if (a === 169 && b === 254) return true // link-local / cloud metadata (169.254.169.254)
	if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
	if (a === 192 && b === 0) return true // IETF protocol assignments / 192.0.0.0/24 (includes some reserved)
	if (a === 192 && b === 168) return true // RFC1918
	if (a === 100 && b >= 64 && b <= 127) return true // CGNAT shared address space
	if (a >= 224) return true // multicast (224-239) and reserved (240-255)
	if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
	if (a === 198 && b === 51 && octets[2] === 100) return true // TEST-NET-2 documentation
	if (a === 203 && b === 0 && octets[2] === 113) return true // TEST-NET-3 documentation

	return false
}

/** Returns true if the IPv6 address is private, reserved, loopback, or otherwise unsafe to connect to. */
export function isPrivateOrReservedIPv6(address: string): boolean {
	const normalized = address.toLowerCase()

	if (normalized === '::1') return true // loopback
	if (normalized === '::' ) return true // unspecified

	// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) must be checked against IPv4 rules.
	const v4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
	if (v4MappedMatch) {
		return isPrivateOrReservedIPv4(v4MappedMatch[1])
	}

	// Unique local addresses (ULA) fc00::/7
	if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

	// Link-local fe80::/10
	if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true

	// Multicast ff00::/8
	if (normalized.startsWith('ff')) return true

	// IPv4-compatible / 6to4 / Teredo and other transition mechanisms are
	// deliberately rejected: validating them correctly requires decoding the
	// embedded IPv4 address, and treating the unknown case as unsafe is safer.
	if (normalized.startsWith('2002:')) return true // 6to4
	if (normalized.startsWith('2001:0:') || normalized.startsWith('2001::')) return true // Teredo

	return false
}

/** Returns true if the given resolved IP address (v4 or v6) must not be connected to. */
export function isPrivateOrReservedIP(address: string, family: 4 | 6): boolean {
	return family === 4 ? isPrivateOrReservedIPv4(address) : isPrivateOrReservedIPv6(address)
}
