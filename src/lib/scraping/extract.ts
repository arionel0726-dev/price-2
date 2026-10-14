import { extractJsonLdBlocks, filterProductNodes } from './jsonld'
import { NormalizedProductRecordSchema, type ExtractionFailure, type ExtractionResult, type NormalizedProductRecord } from './types'
import { normalizeAvailability, normalizeBrand, normalizeTitle, normalizeVariant, parsePrice } from '../normalize/normalize'

interface OfferLike {
	price?: unknown
	priceCurrency?: unknown
	availability?: unknown
	lowPrice?: unknown
}

function firstOffer(offersValue: unknown): OfferLike | null {
	if (!offersValue) return null
	const offerOrOffers = Array.isArray(offersValue) ? offersValue[0] : offersValue
	if (!offerOrOffers || typeof offerOrOffers !== 'object') return null
	return offerOrOffers as OfferLike
}

function extractIdentifiers(node: Record<string, unknown>): { sku: string | null; gtin: string | null } {
	const sku = typeof node.sku === 'string' ? node.sku.trim() || null : null

	const gtinFields = ['gtin', 'gtin13', 'gtin12', 'gtin8', 'gtin14'] as const
	let gtin: string | null = null
	for (const field of gtinFields) {
		const value = node[field]
		if (typeof value === 'string' && value.trim()) {
			gtin = value.trim()
			break
		}
	}

	return { sku, gtin }
}

function buildRecordFromProductNode(sourceUrl: string, node: Record<string, unknown>): NormalizedProductRecord | null {
	const { sku, gtin } = extractIdentifiers(node)
	const offer = firstOffer(node.offers)

	// AggregateOffer has lowPrice/highPrice instead of a single price.
	const rawPrice = offer?.price ?? offer?.lowPrice ?? null
	const { amount, currency } = parsePrice(rawPrice, offer?.priceCurrency ?? null)

	const rawTitle = typeof node.name === 'string' ? node.name : null
	const rawBrand = node.brand ?? null
	const rawAvailability = offer?.availability ?? null

	const candidate = {
		sourceUrl,
		extractedAt: new Date().toISOString(),
		title: {
			raw: rawTitle,
			normalized: normalizeTitle(rawTitle)
		},
		brand: {
			raw: rawBrand,
			normalized: normalizeBrand(rawBrand)
		},
		sku,
		gtin,
		variant: {
			normalized: normalizeVariant(node)
		},
		price: {
			raw: rawPrice,
			amount,
			currency
		},
		availability: {
			raw: rawAvailability,
			normalized: normalizeAvailability(rawAvailability)
		},
		rawJsonLd: node
	}

	const parsed = NormalizedProductRecordSchema.safeParse(candidate)
	return parsed.success ? parsed.data : null
}

/**
 * Extracts product records from a single HTML page.
 *
 * Priority order: JSON-LD `Product` nodes (including nodes nested inside
 * `@graph`). A page may legitimately contain multiple Product nodes (e.g.
 * a product with JSON-LD for related/bundled items) — all are returned as
 * separate records rather than silently merged or only the first kept.
 *
 * Returns zero products with a diagnostic failure when no structured data,
 * no Product-typed node, or only malformed JSON-LD was found. Never
 * fabricates a record from partial data.
 */
export function extractProductsFromHtml(sourceUrl: string, html: string): ExtractionResult {
	const { nodes, failures: parseFailures } = extractJsonLdBlocks(html)

	const failures: ExtractionFailure[] = parseFailures.map((failure) => ({
		sourceUrl,
		reason: 'malformed_json_ld',
		message: `Failed to parse JSON-LD block (${failure.snippet}): ${failure.message}`
	}))

	if (nodes.length === 0 && failures.length === 0) {
		failures.push({
			sourceUrl,
			reason: 'no_structured_data_found',
			message: 'No <script type="application/ld+json"> blocks were found on the page'
		})
		return { products: [], failures }
	}

	const productNodes = filterProductNodes(nodes)
	if (productNodes.length === 0) {
		failures.push({
			sourceUrl,
			reason: 'no_product_type_found',
			message: `Found ${nodes.length} JSON-LD node(s), but none declared @type "Product"`
		})
		return { products: [], failures }
	}

	const products: NormalizedProductRecord[] = []
	for (const node of productNodes) {
		const record = buildRecordFromProductNode(sourceUrl, node)
		if (record) {
			products.push(record)
		} else {
			failures.push({
				sourceUrl,
				reason: 'schema_validation_failed',
				message: 'Extracted record failed schema validation after normalization'
			})
		}
	}

	return { products, failures }
}
