import * as cheerio from 'cheerio'
import { extractLabeledBarcode, validateGtinChecksum } from './barcode'

export interface HtmlFallbackVariant {
	raw: string
	normalized: string
}

export interface HtmlFallbackResult {
	variant: HtmlFallbackVariant | null
	gtin: string | null
}

/**
 * Narrowly-scoped HTML fallback for fields JSON-LD did not provide. This
 * is NOT a general-purpose scraping framework — it only recognizes a
 * small set of conventional markers (schema.org microdata `itemprop`
 * attributes, a few common `data-*` attributes, and a few widely-used
 * class names) and returns null for anything it isn't confident about.
 * It must only be called for fields that are already confirmed missing
 * from JSON-LD (see `extract.ts`); it never overrides a JSON-LD value.
 *
 * Provisional selectors: we have not yet inspected real saved HTML from
 * vizaje-nica.com — live access requires separate, explicit approval
 * (see AGENTS.md / Task 4 and 5 scope notes). These selectors are a
 * best-effort starting point based on common e-commerce markup
 * conventions, not a confirmed match to the pilot site's actual
 * templates, and should be reviewed against real markup after the next
 * approved live run.
 */
export function extractHtmlFallbackFields(html: string): HtmlFallbackResult {
	const $ = cheerio.load(html)

	const variantSelectors = ['[itemprop="size"]', '[data-variant]', '[data-volume]', '.product-size', '.product-volume', '.product-weight']
	let variant: HtmlFallbackVariant | null = null
	for (const selector of variantSelectors) {
		const el = $(selector).first()
		if (el.length === 0) continue
		const text = (el.attr('content') ?? el.attr('data-variant') ?? el.attr('data-volume') ?? el.text() ?? '').trim()
		if (text) {
			variant = { raw: text, normalized: text }
			break
		}
	}

	const gtinAttrSelectors = [
		'[itemprop="gtin13"]',
		'[itemprop="gtin12"]',
		'[itemprop="gtin8"]',
		'[itemprop="gtin14"]',
		'[itemprop="gtin"]',
		'[data-gtin]',
		'[data-ean]'
	]
	let gtin: string | null = null
	for (const selector of gtinAttrSelectors) {
		const el = $(selector).first()
		if (el.length === 0) continue
		const raw = (el.attr('content') ?? el.attr('data-gtin') ?? el.attr('data-ean') ?? el.text() ?? '').trim()
		if (!raw) continue
		const validated = validateGtinChecksum(raw)
		if (validated) {
			gtin = validated
			break
		}
	}
	if (!gtin) {
		gtin = extractLabeledBarcode($('body').text())
	}

	return { variant, gtin }
}
