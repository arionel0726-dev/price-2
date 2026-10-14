export type Availability = 'in_stock' | 'out_of_stock' | 'preorder' | 'unknown'

/** Collapses internal whitespace/newlines and trims. Returns null for empty/non-string input. */
export function normalizeWhitespace(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.replace(/\s+/g, ' ').trim()
	return trimmed.length > 0 ? trimmed : null
}

/** Normalizes a product title: whitespace cleanup only. Does not invent or strip content. */
export function normalizeTitle(value: unknown): string | null {
	return normalizeWhitespace(value)
}

/** Normalizes a brand name. Accepts schema.org Brand/Organization objects (`{ name: "..." }`) or plain strings. */
export function normalizeBrand(value: unknown): string | null {
	if (value && typeof value === 'object' && 'name' in value) {
		return normalizeWhitespace((value as { name: unknown }).name)
	}
	return normalizeWhitespace(value)
}

export interface ParsedPrice {
	amount: number | null
	currency: string | null
}

/**
 * Parses a schema.org-style price value. Per spec, `price` should be a
 * plain decimal number (as a string or number), and `priceCurrency` an
 * ISO 4217 code. Unparsable amounts are returned as `null` rather than 0 —
 * a missing/invalid price must never be read as "free" or "unavailable".
 */
export function parsePrice(rawPrice: unknown, rawCurrency: unknown): ParsedPrice {
	let amount: number | null = null
	if (typeof rawPrice === 'number' && Number.isFinite(rawPrice)) {
		amount = rawPrice
	} else if (typeof rawPrice === 'string') {
		const cleaned = rawPrice.replace(/\s/g, '').replace(',', '.')
		const parsed = Number(cleaned)
		amount = Number.isFinite(parsed) ? parsed : null
	}

	const currency = normalizeWhitespace(rawCurrency)
	const upperCurrency = currency ? currency.toUpperCase() : null

	return { amount, currency: upperCurrency }
}

const AVAILABILITY_MAP: Record<string, Availability> = {
	instock: 'in_stock',
	'http://schema.org/instock': 'in_stock',
	'https://schema.org/instock': 'in_stock',
	outofstock: 'out_of_stock',
	'http://schema.org/outofstock': 'out_of_stock',
	'https://schema.org/outofstock': 'out_of_stock',
	soldout: 'out_of_stock',
	'http://schema.org/soldout': 'out_of_stock',
	'https://schema.org/soldout': 'out_of_stock',
	preorder: 'preorder',
	'http://schema.org/preorder': 'preorder',
	'https://schema.org/preorder': 'preorder',
	presale: 'preorder',
	'http://schema.org/presale': 'preorder',
	'https://schema.org/presale': 'preorder'
}

/**
 * Normalizes a schema.org availability value (a full or short IRI such as
 * `https://schema.org/InStock` or `InStock`). Returns `null` when no value
 * was present at all (field absent), and `'unknown'` when a value was
 * present but not recognized — these two cases must stay distinguishable,
 * since "absent" and "unrecognized" carry different diagnostic meaning.
 */
export function normalizeAvailability(value: unknown): Availability | null {
	if (value === undefined || value === null) return null
	const text = normalizeWhitespace(value)
	if (!text) return null
	const key = text.toLowerCase().replace(/^schema:/, '')
	return AVAILABILITY_MAP[key] ?? 'unknown'
}

/**
 * Best-effort extraction of a variant/size descriptor from non-standard
 * fields (`size`) or a schema.org `additionalProperty` list. Returns null
 * when nothing explicit is present — size/variant is never inferred from
 * free text such as the title.
 */
export function normalizeVariant(node: Record<string, unknown>): string | null {
	const directSize = normalizeWhitespace(node.size)
	if (directSize) return directSize

	const additionalProperties = Array.isArray(node.additionalProperty) ? node.additionalProperty : []
	for (const prop of additionalProperties) {
		if (!prop || typeof prop !== 'object') continue
		const name = normalizeWhitespace((prop as Record<string, unknown>).name)
		if (name && /size|volume|variant|capacity/i.test(name)) {
			const propValue = normalizeWhitespace((prop as Record<string, unknown>).value)
			if (propValue) return propValue
		}
	}

	return null
}
