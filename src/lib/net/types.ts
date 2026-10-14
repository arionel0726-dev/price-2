export class SafeFetchError extends Error {
	constructor(
		message: string,
		public readonly code: SafeFetchErrorCode,
		public readonly cause?: unknown
	) {
		super(message)
		this.name = 'SafeFetchError'
	}
}

export type SafeFetchErrorCode =
	| 'unsupported_protocol'
	| 'dns_resolution_failed'
	| 'blocked_address'
	| 'too_many_redirects'
	| 'invalid_redirect_target'
	| 'timeout'
	| 'response_too_large'
	| 'connection_failed'
	| 'retries_exhausted'

export interface SafeFetchOptions {
	method?: 'GET' | 'HEAD'
	headers?: Record<string, string>
	/** Overall timeout for a single attempt (connect + headers + body), in ms. */
	timeoutMs?: number
	/** Maximum number of redirect hops to follow. */
	maxRedirects?: number
	/** Maximum response body size, in bytes. Responses larger than this are aborted. */
	maxResponseBytes?: number
	/** Sent as the User-Agent header. Required so operators can be identified and rate-limited politely. */
	userAgent: string
	/** Number of retry attempts after the first failed attempt (network errors / 5xx only). */
	retries?: number
	/** Base delay for exponential backoff between retries, in ms. */
	retryBaseDelayMs?: number
	signal?: AbortSignal
	/**
	 * Test-only escape hatch: allows connecting to private/loopback addresses.
	 * Must never be enabled for live crawling; it exists so fixtures/tests can
	 * run a local HTTP server and exercise the full client without relying on
	 * real internet hosts. Defaults to false.
	 */
	allowPrivateNetworks?: boolean
}

export interface SafeFetchResponse {
	url: string
	status: number
	headers: Record<string, string>
	body: string
	redirectChain: string[]
}
