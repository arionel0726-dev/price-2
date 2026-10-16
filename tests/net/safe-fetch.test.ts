import { afterEach, describe, expect, test } from 'bun:test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { safeFetch } from '../../src/lib/net/safe-fetch'
import { SafeFetchError } from '../../src/lib/net/types'

const TEST_USER_AGENT = 'price-2-test/1.0'

let activeServer: http.Server | null = null

function startServer(handler: http.RequestListener): Promise<{ baseUrl: string; server: http.Server }> {
	return new Promise((resolve) => {
		const server = http.createServer(handler)
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo
			activeServer = server
			resolve({ baseUrl: `http://127.0.0.1:${port}`, server })
		})
	})
}

afterEach(async () => {
	if (activeServer) {
		await new Promise<void>((resolve) => activeServer!.close(() => resolve()))
		activeServer = null
	}
})

describe('safeFetch — SSRF protections', () => {
	test('rejects loopback targets by default, even when a real server is listening', async () => {
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end('should never be reached')
		})

		await expect(safeFetch(baseUrl, { userAgent: TEST_USER_AGENT })).rejects.toThrow(SafeFetchError)
		await expect(safeFetch(baseUrl, { userAgent: TEST_USER_AGENT })).rejects.toMatchObject({ code: 'blocked_address' })
	})

	test('rejects unsupported protocols before attempting any network access', async () => {
		await expect(safeFetch('ftp://127.0.0.1/file', { userAgent: TEST_USER_AGENT })).rejects.toMatchObject({
			code: 'unsupported_protocol'
		})
		await expect(safeFetch('file:///etc/passwd', { userAgent: TEST_USER_AGENT })).rejects.toMatchObject({
			code: 'unsupported_protocol'
		})
	})

	test('allows loopback only via the explicit test-only override', async () => {
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end('ok')
		})

		const response = await safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true })
		expect(response.status).toBe(200)
		expect(response.body).toBe('ok')
	})

	test('refuses to follow a redirect to an unsupported protocol', async () => {
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(302, { location: 'ftp://127.0.0.1/evil' })
			res.end()
		})

		await expect(
			safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true })
		).rejects.toMatchObject({ code: 'invalid_redirect_target' })
	})

	test('follows a same-origin redirect and records the chain when allowed', async () => {
		const { baseUrl } = await startServer((req, res) => {
			if (req.url === '/start') {
				res.writeHead(302, { location: '/final' })
				res.end()
				return
			}
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end('final destination')
		})

		const response = await safeFetch(`${baseUrl}/start`, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true })
		expect(response.body).toBe('final destination')
		expect(response.redirectChain).toEqual([`${baseUrl}/start`])
	})

	test('stops after maxRedirects and reports it', async () => {
		const { baseUrl } = await startServer((req, res) => {
			const current = Number(req.url?.replace('/', '') || '0')
			res.writeHead(302, { location: `/${current + 1}` })
			res.end()
		})

		await expect(
			safeFetch(`${baseUrl}/0`, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true, maxRedirects: 2 })
		).rejects.toMatchObject({ code: 'too_many_redirects' })
	})
})

describe('safeFetch — response limits, timeouts, retries', () => {
	test('aborts a response exceeding maxResponseBytes', async () => {
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end('x'.repeat(1000))
		})

		await expect(
			safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true, maxResponseBytes: 10 })
		).rejects.toMatchObject({ code: 'response_too_large' })
	})

	test('times out a slow response', async () => {
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' })
			setTimeout(() => res.end('too slow'), 500)
		})

		await expect(
			safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true, timeoutMs: 50, retries: 0 })
		).rejects.toMatchObject({ code: 'timeout' })
	})

	test('retries on 5xx and eventually succeeds', async () => {
		let attempts = 0
		const { baseUrl } = await startServer((_req, res) => {
			attempts += 1
			if (attempts < 3) {
				res.writeHead(503)
				res.end()
				return
			}
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end('recovered')
		})

		const response = await safeFetch(baseUrl, {
			userAgent: TEST_USER_AGENT,
			allowPrivateNetworks: true,
			retries: 3,
			retryBaseDelayMs: 1
		})
		expect(response.body).toBe('recovered')
		expect(attempts).toBe(3)
	})

	test('transparently decompresses a gzip-encoded response even though the client asked for identity', async () => {
		const original = '<urlset>' + '<url><loc>https://example.test/product/1</loc></url>'.repeat(50) + '</urlset>'
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip' })
			res.end(gzipSync(Buffer.from(original)))
		})

		const response = await safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true })
		expect(response.body).toBe(original)
	})

	test('detects gzip by magic bytes even without a Content-Encoding header (defense in depth)', async () => {
		const original = 'a'.repeat(5000)
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/xml' })
			res.end(gzipSync(Buffer.from(original)))
		})

		const response = await safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true })
		expect(response.body).toBe(original)
	})

	test('aborts decompression once the decompressed size exceeds maxDecompressedBytes, without materializing the full payload (zip-bomb defense)', async () => {
		const original = 'x'.repeat(2_000_000) // highly compressible, gzips down to well under maxResponseBytes
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip' })
			res.end(gzipSync(Buffer.from(original)))
		})

		await expect(
			safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true, maxDecompressedBytes: 1000 })
		).rejects.toMatchObject({ code: 'response_too_large' })
	})

	test('maxResponseBytes still bounds the compressed wire size independently of maxDecompressedBytes', async () => {
		const original = 'y'.repeat(2_000_000)
		const compressed = gzipSync(Buffer.from(original))
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip' })
			res.end(compressed)
		})

		await expect(
			safeFetch(baseUrl, {
				userAgent: TEST_USER_AGENT,
				allowPrivateNetworks: true,
				maxResponseBytes: Math.floor(compressed.length / 2),
				maxDecompressedBytes: 50_000_000
			})
		).rejects.toMatchObject({ code: 'response_too_large' })
	})

	test('decompresses correctly for varied, non-trivially-compressible content (guards against a degenerate-input false pass)', async () => {
		// Highly repetitive text (like 'x'.repeat(n)) compresses so well that a
		// buggy double-decompression could coincidentally still "work" on tiny
		// inputs. Using varied, less-compressible content makes a correctness
		// bug far more likely to surface as garbled output or a thrown error.
		const original = Array.from({ length: 3000 }, (_, i) => `line-${i}-${(i * 2654435761) % 97}`).join('\n')
		const { baseUrl } = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
			res.end(gzipSync(Buffer.from(original)))
		})

		const response = await safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true })
		expect(response.body).toBe(original)
		expect(response.body.length).toBe(original.length)
	})

	test('never silently returns corrupted content if a response is already-plain bytes despite a Content-Encoding: gzip header (fails loudly instead of double-decompressing or garbling) — see the double-decompression safety note in safe-fetch.ts', async () => {
		const plainText = 'this body is NOT actually gzip-compressed'
		const { baseUrl } = await startServer((_req, res) => {
			// Simulates a misconfigured upstream (or, hypothetically, a future
			// runtime that pre-decompressed the body but left the header as-is):
			// the header claims gzip, but the bytes are plain text.
			res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
			res.end(plainText)
		})

		// Must reject (loud, safe failure) rather than resolve with garbled or
		// incorrect text — this is the behavior that rules out silent
		// double-decompression corruption as a failure mode.
		await expect(safeFetch(baseUrl, { userAgent: TEST_USER_AGENT, allowPrivateNetworks: true })).rejects.toThrow(SafeFetchError)
	})

	test('gives up after exhausting retries on connection failure', async () => {
		// Nothing is listening on this port.
		await expect(
			safeFetch('http://127.0.0.1:1', {
				userAgent: TEST_USER_AGENT,
				allowPrivateNetworks: true,
				retries: 1,
				retryBaseDelayMs: 1,
				timeoutMs: 200
			})
		).rejects.toThrow(SafeFetchError)
	})
})
