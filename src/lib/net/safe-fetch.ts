import * as http from 'node:http'
import * as https from 'node:https'
import { promises as dns } from 'node:dns'
import { isAllowedProtocol, isPrivateOrReservedIP } from './ssrf'
import { SafeFetchError, type SafeFetchOptions, type SafeFetchResponse } from './types'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5 MiB
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 300

interface ResolvedAddress {
	address: string
	family: 4 | 6
}

/**
 * Resolves `hostname` and validates every returned address against the SSRF
 * guard. Connecting to the exact address we validated here (rather than
 * resolving again at connect time) is what closes the DNS-rebinding gap:
 * there is no second lookup between validation and the TCP connection.
 */
async function resolveValidatedAddress(
	hostname: string,
	allowPrivateNetworks: boolean
): Promise<ResolvedAddress> {
	let records: { address: string; family: number }[]
	try {
		records = await dns.lookup(hostname, { all: true, verbatim: true })
	} catch (cause) {
		throw new SafeFetchError(`DNS resolution failed for "${hostname}"`, 'dns_resolution_failed', cause)
	}

	if (records.length === 0) {
		throw new SafeFetchError(`DNS resolution returned no addresses for "${hostname}"`, 'dns_resolution_failed')
	}

	if (!allowPrivateNetworks) {
		for (const record of records) {
			const family = record.family === 6 ? 6 : 4
			if (isPrivateOrReservedIP(record.address, family)) {
				throw new SafeFetchError(
					`Refusing to connect to "${hostname}": resolves to a private/reserved address (${record.address})`,
					'blocked_address'
				)
			}
		}
	}

	const first = records[0]
	return { address: first.address, family: first.family === 6 ? 6 : 4 }
}

function parseAndValidateUrl(rawUrl: string): URL {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch (cause) {
		throw new SafeFetchError(`Invalid URL: "${rawUrl}"`, 'unsupported_protocol', cause)
	}
	if (!isAllowedProtocol(url.protocol)) {
		throw new SafeFetchError(`Unsupported protocol "${url.protocol}" for "${rawUrl}"`, 'unsupported_protocol')
	}
	return url
}

function performSingleRequest(
	url: URL,
	resolved: ResolvedAddress,
	options: Required<
		Pick<SafeFetchOptions, 'method' | 'headers' | 'timeoutMs' | 'maxResponseBytes' | 'userAgent'>
	>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const isHttps = url.protocol === 'https:'
		const transport = isHttps ? https : http
		const defaultPort = isHttps ? 443 : 80

		const req = transport.request({
			host: resolved.address,
			port: url.port ? Number(url.port) : defaultPort,
			path: `${url.pathname}${url.search}`,
			method: options.method,
			// Connecting directly to the validated IP, but presenting the
			// original hostname via Host header (and SNI for TLS) so virtual
			// hosting and certificate validation behave normally.
			servername: isHttps ? url.hostname : undefined,
			headers: {
				Host: url.hostname,
				'User-Agent': options.userAgent,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				...options.headers
			},
			timeout: options.timeoutMs
		})

		let settled = false
		const fail = (err: Error) => {
			if (settled) return
			settled = true
			req.destroy()
			reject(err)
		}

		req.on('timeout', () => {
			fail(new SafeFetchError(`Request to "${url.href}" timed out after ${options.timeoutMs}ms`, 'timeout'))
		})

		req.on('error', (cause) => {
			fail(new SafeFetchError(`Connection to "${url.href}" failed: ${cause.message}`, 'connection_failed', cause))
		})

		req.on('response', (res) => {
			const chunks: Buffer[] = []
			let totalBytes = 0

			res.on('data', (chunk: Buffer) => {
				totalBytes += chunk.length
				if (totalBytes > options.maxResponseBytes) {
					fail(
						new SafeFetchError(
							`Response from "${url.href}" exceeded maximum size of ${options.maxResponseBytes} bytes`,
							'response_too_large'
						)
					)
					return
				}
				chunks.push(chunk)
			})

			res.on('end', () => {
				if (settled) return
				settled = true
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks).toString('utf-8')
				})
			})

			res.on('error', (cause) => {
				fail(new SafeFetchError(`Reading response from "${url.href}" failed: ${cause.message}`, 'connection_failed', cause))
			})
		})

		req.end()
	})
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetches `rawUrl` with SSRF protections, bounded response size, timeouts,
 * and limited retries with backoff. Redirects are followed manually (each
 * hop is re-resolved and re-validated) up to `maxRedirects`.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResponse> {
	const method = options.method ?? 'GET'
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
	const retries = options.retries ?? DEFAULT_RETRIES
	const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
	const allowPrivateNetworks = options.allowPrivateNetworks ?? false

	const redirectChain: string[] = []
	let currentUrl = parseAndValidateUrl(rawUrl)

	for (let redirectCount = 0; ; redirectCount++) {
		if (redirectCount > maxRedirects) {
			throw new SafeFetchError(`Exceeded maximum of ${maxRedirects} redirects starting from "${rawUrl}"`, 'too_many_redirects')
		}

		const resolved = await resolveValidatedAddress(currentUrl.hostname, allowPrivateNetworks)

		let lastError: unknown
		let attemptResult: { status: number; headers: http.IncomingHttpHeaders; body: string } | undefined

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				attemptResult = await performSingleRequest(currentUrl, resolved, {
					method,
					headers: options.headers ?? {},
					timeoutMs,
					maxResponseBytes,
					userAgent: options.userAgent
				})
				if (isRetryableStatus(attemptResult.status) && attempt < retries) {
					lastError = new SafeFetchError(
						`Received retryable status ${attemptResult.status} from "${currentUrl.href}"`,
						'connection_failed'
					)
					attemptResult = undefined
					await sleep(retryBaseDelayMs * 2 ** attempt)
					continue
				}
				break
			} catch (err) {
				lastError = err
				if (attempt < retries) {
					await sleep(retryBaseDelayMs * 2 ** attempt)
					continue
				}
			}
		}

		if (!attemptResult) {
			throw lastError instanceof Error
				? lastError
				: new SafeFetchError(`Request to "${currentUrl.href}" failed after ${retries + 1} attempts`, 'retries_exhausted')
		}

		const { status, headers, body } = attemptResult

		if (status >= 300 && status < 400 && headers.location) {
			redirectChain.push(currentUrl.href)
			let nextUrl: URL
			try {
				nextUrl = new URL(headers.location, currentUrl)
			} catch (cause) {
				throw new SafeFetchError(`Malformed redirect location "${headers.location}"`, 'invalid_redirect_target', cause)
			}
			if (!isAllowedProtocol(nextUrl.protocol)) {
				throw new SafeFetchError(
					`Refusing to follow redirect to unsupported protocol "${nextUrl.protocol}"`,
					'invalid_redirect_target'
				)
			}
			currentUrl = nextUrl
			continue
		}

		return {
			url: currentUrl.href,
			status,
			headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')])),
			body,
			redirectChain
		}
	}
}
