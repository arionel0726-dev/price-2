import { afterEach, describe, expect, test } from 'bun:test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
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
