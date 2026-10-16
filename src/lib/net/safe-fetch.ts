import * as http from 'node:http'
import * as https from 'node:https'
import { createGunzip } from 'node:zlib'
import { promises as dns } from 'node:dns'
import { isAllowedProtocol, isPrivateOrReservedIP } from './ssrf'
import { SafeFetchError, type SafeFetchOptions, type SafeFetchResponse } from './types'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5 MiB
// Independent of maxResponseBytes (which bounds the wire/compressed size) —
// this bounds the decompressed size, so a small gzip payload cannot expand
// into unbounded memory use ("zip bomb" defense).
const DEFAULT_MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024 // 20 MiB
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 300

const GZIP_MAGIC_BYTES = [0x1f, 0x8b]

/**
 * True when `buffer` starts with the gzip magic number. Checked in addition
 * to the `Content-Encoding` header because some servers/CDNs gzip-compress
 * responses even when the client did not advertise support for it (we send
 * `Accept-Encoding: identity` below specifically to discourage this, but
 * cannot rely on every upstream honoring it) — sniffing the actual bytes is
 * what makes this defense-in-depth rather than merely header-trusting.
 *
 * Double-decompression safety (verified, not assumed): this module uses
 * Node's `http`/`https` API (not Bun's native `fetch`), and under Bun's
 * `node:http`/`node:https` compatibility layer that API does NOT
 * transparently decompress responses — the bytes handed to `res.on('data')`
 * are the exact wire bytes, `Content-Encoding` is passed through unchanged,
 * and gzip magic bytes are intact. This was confirmed directly against a
 * local gzip-compressed response before relying on it here. If a future
 * Bun/Node version ever changed this and pre-decompressed a response while
 * still reporting `Content-Encoding: gzip`, the code below does not
 * silently return corrupted/garbled text: feeding already-plain bytes into
 * `createGunzip` fails fast with a "Failed to decompress" error (see
 * `decompressGzipBounded`'s 'error' handler), so the request is rejected
 * loudly rather than succeeding with wrong content — see the regression
 * tests in tests/net/safe-fetch.test.ts.
 */
function looksLikeGzip(buffer: Buffer): boolean {
	return buffer.length >= 2 && buffer[0] === GZIP_MAGIC_BYTES[0] && buffer[1] === GZIP_MAGIC_BYTES[1]
}

/**
 * Streams `compressed` through gzip decompression, aborting as soon as the
 * decompressed size would exceed `maxBytes`. Streaming (rather than
 * decompressing in one shot and checking the result) is what bounds memory
 * use even against a true zip bomb: the oversized-output error fires on the
 * first chunk that crosses the limit, not after the whole payload has
 * already been materialized.
 */
function decompressGzipBounded(compressed: Buffer, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const gunzip = createGunzip()
		const outChunks: Buffer[] = []
		let total = 0
		let settled = false

		const fail = (err: Error) => {
			if (settled) return
			settled = true
			gunzip.destroy()
			reject(err)
		}

		gunzip.on('data', (chunk: Buffer) => {
			total += chunk.length
			if (total > maxBytes) {
				fail(new SafeFetchError(`Decompressed response exceeded maximum size of ${maxBytes} bytes`, 'response_too_large'))
				return
			}
			outChunks.push(chunk)
		})

		gunzip.on('error', (cause) => {
			fail(new SafeFetchError(`Failed to decompress gzip-encoded response: ${cause.message}`, 'connection_failed', cause))
		})

		gunzip.on('end', () => {
			if (settled) return
			settled = true
			resolve(Buffer.concat(outChunks))
		})

		gunzip.end(compressed)
	})
}

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
		Pick<SafeFetchOptions, 'method' | 'headers' | 'timeoutMs' | 'maxResponseBytes' | 'maxDecompressedBytes' | 'userAgent'>
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
				// Explicitly asks the server not to compress the response, so the
				// bytes we receive match what maxResponseBytes expects. Some
				// servers/CDNs ignore this and gzip anyway — see looksLikeGzip
				// below, which sniffs the actual bytes rather than trusting that
				// request header to have been honored.
				'Accept-Encoding': 'identity',
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

			let endHandled = false
			res.on('end', () => {
				if (endHandled || settled) return
				endHandled = true

				const rawBuffer = Buffer.concat(chunks)
				const contentEncoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
				const isGzip = contentEncoding.includes('gzip') || looksLikeGzip(rawBuffer)

				const finish = (bodyBuffer: Buffer) => {
					if (settled) return
					settled = true
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: bodyBuffer.toString('utf-8')
					})
				}

				if (!isGzip) {
					finish(rawBuffer)
					return
				}

				decompressGzipBounded(rawBuffer, options.maxDecompressedBytes)
					.then(finish)
					.catch((cause) => fail(cause instanceof Error ? cause : new SafeFetchError(String(cause), 'connection_failed')))
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
	const maxDecompressedBytes = options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES
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
					maxDecompressedBytes,
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
