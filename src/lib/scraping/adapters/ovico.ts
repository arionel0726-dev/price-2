/**
 * ovico.md-specific HTML extraction adapter (Task 7.1).
 *
 * Why this exists: ovico.md's confirmed real product HTML (an authorized
 * diagnostic snapshot of https://ovico.md/ru/avignon-edt-50ml-vapo)
 * carries NO Product JSON-LD at all. The shared pipeline
 * (`src/lib/scraping/extract.ts`) requires at least one JSON-LD Product
 * node before it will build a record — its own "HTML fallback"
 * (`html-fallback.ts`) only ever *supplements* an existing JSON-LD node,
 * it never creates one from nothing. Without this adapter, every ovico.md
 * page would be reported as `missing_json_ld`/`non_product_page` even for
 * a genuine, available product.
 *
 * This module is invoked ONLY for ovico.md (see
 * `src/lib/discovery/stores/ovico-md.ts`'s `htmlOnlyExtract`), and ONLY
 * when the generic JSON-LD pipeline already found zero Product nodes — it
 * never overrides or competes with JSON-LD.
 *
 * Confirmed selectors used (Task 7.1 evidence), and nothing else:
 *   - `.product-page`                              — product-page container
 *   - `.product-page__details-name`                — title
 *   - `.product-page__details-code.sku`             — SKU (prefers the
 *     `data-product-sku` attribute, falling back to element text)
 *   - `.radio-volume`                               — volume/variant
 *   - `.product-page__details-not-available`        — unavailable marker
 *
 * Brand, GTIN, and price have NO confirmed selector evidence and are
 * deliberately left `null` — this adapter must never guess them (Task 7.1
 * §6). A Magento product grid (`.products-grid` / `.product-item`) without
 * the product-page container is treated as a category page, distinguished
 * by structure rather than URL shape alone (Task 7.1 §7).
 */
import * as cheerio from 'cheerio'
import { normalizeTitle } from '../../normalize/normalize'
import { NormalizedProductRecordSchema, type FieldSource, type NormalizedProductRecord } from '../types'

const PRODUCT_CONTAINER_SELECTOR = '.product-page'
const TITLE_SELECTOR = '.product-page__details-name'
const SKU_SELECTOR = '.product-page__details-code.sku'
const VOLUME_OPTION_SELECTOR = '.radio-volume'
const NOT_AVAILABLE_SELECTOR = '.product-page__details-not-available'
// Generic Magento category/listing grid markers — used only as a secondary
// signal when the product-page container is absent.
const CATEGORY_GRID_SELECTOR = '.products-grid, .product-items, .product-item'

export type OvicoHtmlClassification = { kind: 'product'; record: NormalizedProductRecord | null } | { kind: 'non_product' } | null

function trimmedTextOrNull(text: string | undefined): string | null {
	const trimmed = (text ?? '').replace(/\s+/g, ' ').trim()
	return trimmed.length > 0 ? trimmed : null
}

function extractSku($: cheerio.CheerioAPI): string | null {
	const el = $(SKU_SELECTOR).first()
	if (el.length === 0) return null
	const attr = el.attr('data-product-sku')
	if (attr && attr.trim()) return attr.trim()
	return trimmedTextOrNull(el.text())
}

/**
 * Reads the product's volume/variant from `.radio-volume` option(s). Only
 * ever trusts an UNAMBIGUOUS value: exactly one option on the page, or
 * exactly one explicitly marked selected/active/checked. With several
 * options and no clear selection marker, returns null rather than
 * guessing which one is "current" — the exact selection sub-structure
 * (e.g. which attribute marks the active swatch) was not part of the
 * confirmed evidence.
 */
function extractVolume($: cheerio.CheerioAPI): string | null {
	const options = $(VOLUME_OPTION_SELECTOR).toArray()
	if (options.length === 0) return null
	if (options.length === 1) return trimmedTextOrNull($(options[0]).text())

	const selected = options.filter((el) => {
		const $opt = $(el)
		return $opt.is('.selected, .active, [aria-checked="true"]') || $opt.attr('aria-checked') === 'true' || $opt.find('input:checked').length > 0
	})
	if (selected.length === 1) return trimmedTextOrNull($(selected[0]).text())
	return null
}

/**
 * Classifies and, when the page is confirmed to be a product page,
 * extracts it — using ONLY the confirmed Magento selectors above. Returns
 * `null` when neither a product-page container nor a category grid is
 * present (i.e. the HTML doesn't match any confirmed Ovico structural
 * marker at all), so the caller falls back to the generic outcome mapping
 * rather than this adapter guessing.
 */
export function classifyAndExtractOvicoHtml(sourceUrl: string, html: string): OvicoHtmlClassification {
	const $ = cheerio.load(html)

	const isProductPage = $(PRODUCT_CONTAINER_SELECTOR).length > 0
	if (!isProductPage) {
		if ($(CATEGORY_GRID_SELECTOR).length > 0) return { kind: 'non_product' }
		return null
	}

	const rawTitle = trimmedTextOrNull($(TITLE_SELECTOR).first().text())
	const normalizedTitle = normalizeTitle(rawTitle)
	const sku = extractSku($)
	const volume = extractVolume($)
	const available = $(NOT_AVAILABLE_SELECTOR).length === 0
	const availabilityValue = available ? ('in_stock' as const) : ('out_of_stock' as const)

	const fieldProvenance: Partial<Record<string, FieldSource>> = {
		title: normalizedTitle ? 'html_attribute' : 'missing',
		brand: 'missing',
		sku: sku ? 'html_attribute' : 'missing',
		gtin: 'missing',
		variant: volume ? 'html_attribute' : 'missing',
		price: 'missing',
		currency: 'missing',
		availability: 'html_attribute'
	}

	const candidate = {
		sourceUrl,
		extractedAt: new Date().toISOString(),
		title: { raw: rawTitle, normalized: normalizedTitle },
		brand: { raw: null, normalized: null },
		sku,
		gtin: null,
		variant: { normalized: volume },
		price: { raw: null, amount: null, currency: null },
		availability: { raw: availabilityValue, normalized: availabilityValue },
		rawJsonLd: {},
		fieldProvenance
	}

	const parsed = NormalizedProductRecordSchema.safeParse(candidate)
	return { kind: 'product', record: parsed.success ? parsed.data : null }
}
