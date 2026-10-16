import { describe, expect, test } from 'bun:test'
import { parseArgs, runAnalyzeMode } from '../../src/scripts/snapshot-product-html'

describe('snapshot-product-html CLI — argument parsing (opt-in safety gates, Task 6.1 §3/§6)', () => {
	test('requires --live to fetch (refuses network access by default)', () => {
		expect(() => parseArgs(['--url', 'https://makeup.md/product/x'])).toThrow(/--live/)
	})

	test('requires at least one --url when not in --analyze mode', () => {
		expect(() => parseArgs(['--live'])).toThrow(/--url is required/)
	})

	test('refuses more than 3 explicitly-selected URLs — this is a targeted diagnostic, not a crawler', () => {
		expect(() =>
			parseArgs(['--live', '--url', 'https://makeup.md/a', '--url', 'https://makeup.md/b', '--url', 'https://makeup.md/c', '--url', 'https://makeup.md/d'])
		).toThrow(/At most 3 URLs/)
	})

	test('accepts exactly 3 URLs with --live', () => {
		const args = parseArgs(['--live', '--url', 'https://makeup.md/a', '--url', 'https://makeup.md/b', '--url', 'https://makeup.md/c'])
		expect(args.urls).toHaveLength(3)
		expect(args.live).toBe(true)
	})

	test('--analyze mode needs neither --live nor --url (fully offline)', () => {
		const args = parseArgs(['--analyze', 'some/local/file.html'])
		expect(args.analyzePath).toBe('some/local/file.html')
		expect(args.live).toBe(false)
	})

	test('defaults the output directory to the gitignored .local/snapshots', () => {
		const args = parseArgs(['--live', '--url', 'https://makeup.md/a'])
		expect(args.outDir).toBe('.local/snapshots')
	})
})

describe('snapshot-product-html CLI — --analyze mode runs fully offline against a saved file', () => {
	test('classifies an already-saved HTML file with no network access', async () => {
		const logs: string[] = []
		const originalLog = console.log
		console.log = (...args: unknown[]) => logs.push(args.join(' '))
		try {
			await runAnalyzeMode('tests/fixtures/html-snapshots/real-product-page.html')
		} finally {
			console.log = originalLog
		}
		expect(logs.some((l) => l.includes('hasProductJsonLd=true'))).toBe(true)
	})
})
