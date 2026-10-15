import { extractJsonLdBlocks, filterProductNodes } from './jsonld'
import { validateGtinChecksum } from './barcode'
import { extractHtmlFallbackFields, type HtmlFallbackResult } from './html-fallback'
import {
	NormalizedProductRecordSchema,
	type ExtractionFailure,
	type ExtractionResult,
	type FieldConflict,
	type FieldSource,
	type NormalizedProductRecord,
	type ProvenanceField
} from './types'
import { extractVolumeFromTitle } from './variant'
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

/**
 * Reads SKU and GTIN off a JSON-LD Product node. The `gtin*` properties
 * are schema.org's explicit way of labeling a value as a GTIN, so finding
 * one there satisfies "explicitly identified as a barcode/GTIN" — but the
 * value is still only accepted after it passes the GS1 checksum.
 * `sku` never feeds into `gtin`: a store-specific stock code is not a
 * GTIN even when it happens to be all-digits.
 */
function extractIdentifiers(node: Record<string, unknown>): { sku: string | null; gtin: string | null } {
	const sku = typeof node.sku === 'string' ? node.sku.trim() || null : null

	const gtinFields = ['gtin', 'gtin13', 'gtin12', 'gtin8', 'gtin14'] as const
	let gtin: string | null = null
	for (const field of gtinFields) {
		const value = node[field]
		if (typeof value === 'string' && value.trim()) {
			const validated = validateGtinChecksum(value.trim())
			if (validated) {
				gtin = validated
				break
			}
		}
	}

	return { sku, gtin }
}

/**
 * Resolves `variant` and `gtin` using the documented precedence:
 * 1. Explicit JSON-LD structured attributes (already computed by the
 *    caller — `jsonLdVariant`/`jsonLdGtin`).
 * 2. A reliable HTML attribute (`htmlFallback`).
 * 3. Conservative extraction from the product title (variant only —
 *    GTIN is never guessed from a title).
 *
 * When JSON-LD already has a value AND the HTML fallback independently
 * found a *different* one, the JSON-LD value is kept (never silently
 * overwritten) and the disagreement is recorded in `conflicts` so it is
 * visible rather than hidden.
 */
function resolveFieldsWithFallback(
	jsonLdVariant: string | null,
	jsonLdGtin: string | null,
	normalizedTitle: string | null,
	htmlFallback: HtmlFallbackResult
): {
	variant: string | null
	variantSource: FieldSource
	gtin: string | null
	gtinSource: FieldSource
	conflicts: FieldConflict[]
} {
	const conflicts: FieldConflict[] = []

	let variant = jsonLdVariant
	let variantSource: FieldSource = jsonLdVariant ? 'json_ld' : 'missing'
	if (htmlFallback.variant && jsonLdVariant && htmlFallback.variant.normalized !== jsonLdVariant) {
		conflicts.push({ field: 'variant', jsonLdValue: jsonLdVariant, htmlValue: htmlFallback.variant.normalized })
	} else if (!jsonLdVariant && htmlFallback.variant) {
		variant = htmlFallback.variant.normalized
		variantSource = 'html_attribute'
	} else if (!jsonLdVariant) {
		const fromTitle = extractVolumeFromTitle(normalizedTitle)
		if (fromTitle) {
			variant = fromTitle.normalized
			variantSource = 'title'
		}
	}

	let gtin = jsonLdGtin
	let gtinSource: FieldSource = jsonLdGtin ? 'json_ld' : 'missing'
	if (htmlFallback.gtin && jsonLdGtin && htmlFallback.gtin !== jsonLdGtin) {
		conflicts.push({ field: 'gtin', jsonLdValue: jsonLdGtin, htmlValue: htmlFallback.gtin })
	} else if (!jsonLdGtin && htmlFallback.gtin) {
		gtin = htmlFallback.gtin
		gtinSource = 'html_attribute'
	}

	return { variant, variantSource, gtin, gtinSource, conflicts }
}

function buildRecordFromProductNode(sourceUrl: string, node: Record<string, unknown>, htmlFallback: HtmlFallbackResult): NormalizedProductRecord | null {
	const { sku, gtin: jsonLdGtin } = extractIdentifiers(node)
	const offer = firstOffer(node.offers)

	// AggregateOffer has lowPrice/highPrice instead of a single price.
	const rawPrice = offer?.price ?? offer?.lowPrice ?? null
	const { amount, currency } = parsePrice(rawPrice, offer?.priceCurrency ?? null)

	const rawTitle = typeof node.name === 'string' ? node.name : null
	const rawBrand = node.brand ?? null
	const rawAvailability = offer?.availability ?? null

	const normalizedTitle = normalizeTitle(rawTitle)
	const normalizedBrand = normalizeBrand(rawBrand)
	const jsonLdVariant = normalizeVariant(node)
	const normalizedAvailability = normalizeAvailability(rawAvailability)

	const resolved = resolveFieldsWithFallback(jsonLdVariant, jsonLdGtin, normalizedTitle, htmlFallback)

	const fieldProvenance: Partial<Record<ProvenanceField, FieldSource>> = {
		title: normalizedTitle ? 'json_ld' : 'missing',
		brand: normalizedBrand ? 'json_ld' : 'missing',
		sku: sku ? 'json_ld' : 'missing',
		gtin: resolved.gtinSource,
		variant: resolved.variantSource,
		price: amount !== null ? 'json_ld' : 'missing',
		currency: currency !== null ? 'json_ld' : 'missing',
		availability: normalizedAvailability ? 'json_ld' : 'missing'
	}

	const candidate = {
		sourceUrl,
		extractedAt: new Date().toISOString(),
		title: {
			raw: rawTitle,
			normalized: normalizedTitle
		},
		brand: {
			raw: rawBrand,
			normalized: normalizedBrand
		},
		sku,
		gtin: resolved.gtin,
		variant: {
			normalized: resolved.variant
		},
		price: {
			raw: rawPrice,
			amount,
			currency
		},
		availability: {
			raw: rawAvailability,
			normalized: normalizedAvailability
		},
		rawJsonLd: node,
		fieldProvenance,
		conflicts: resolved.conflicts.length > 0 ? resolved.conflicts : undefined
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

	const htmlFallback = extractHtmlFallbackFields(html)

	const products: NormalizedProductRecord[] = []
	for (const node of productNodes) {
		const record = buildRecordFromProductNode(sourceUrl, node, htmlFallback)
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
