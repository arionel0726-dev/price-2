import * as cheerio from 'cheerio'

export interface JsonLdParseFailure {
	snippet: string
	message: string
}

export interface JsonLdExtractionResult {
	/** Flattened list of JSON-LD nodes (objects), with @graph arrays expanded one level. */
	nodes: Record<string, unknown>[]
	failures: JsonLdParseFailure[]
}

function truncateForDiagnostics(text: string, maxLength = 200): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function flattenNode(value: unknown, out: Record<string, unknown>[]): void {
	if (Array.isArray(value)) {
		for (const item of value) flattenNode(item, out)
		return
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>
		if (Array.isArray(obj['@graph'])) {
			for (const item of obj['@graph'] as unknown[]) flattenNode(item, out)
			return
		}
		out.push(obj)
	}
}

/**
 * Extracts and parses every `<script type="application/ld+json">` block in
 * `html`. Blocks that fail to parse as JSON are reported as failures (with a
 * truncated snippet for diagnostics) rather than aborting extraction for the
 * whole page — a single malformed block must not hide valid data elsewhere
 * on the page.
 */
export function extractJsonLdBlocks(html: string): JsonLdExtractionResult {
	const $ = cheerio.load(html)
	const nodes: Record<string, unknown>[] = []
	const failures: JsonLdParseFailure[] = []

	$('script[type="application/ld+json"]').each((_, element) => {
		const raw = $(element).text()
		if (!raw || !raw.trim()) return

		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch (cause) {
			failures.push({
				snippet: truncateForDiagnostics(raw.trim()),
				message: cause instanceof Error ? cause.message : String(cause)
			})
			return
		}

		flattenNode(parsed, nodes)
	})

	return { nodes, failures }
}

function hasType(node: Record<string, unknown>, typeName: string): boolean {
	const type = node['@type']
	if (typeof type === 'string') return type === typeName
	if (Array.isArray(type)) return type.includes(typeName)
	return false
}

/** Filters flattened JSON-LD nodes down to those declaring `@type: "Product"`. */
export function filterProductNodes(nodes: Record<string, unknown>[]): Record<string, unknown>[] {
	return nodes.filter((node) => hasType(node, 'Product'))
}
