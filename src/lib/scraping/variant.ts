/**
 * Conservative, title-only volume/size extraction — the third and last
 * precedence tier for the `variant` field (see `extract.ts`): used only
 * when neither JSON-LD's explicit `size`/`additionalProperty` fields nor
 * a reliable HTML attribute (see `html-fallback.ts`) provided one.
 *
 * The unit suffix is mandatory and must immediately follow the number
 * (with at most one space) and be followed by a word boundary. This is
 * what keeps the extraction conservative: a shade code ("Shade 010"), a
 * model number, or an internal SKU embedded in a title (e.g.
 * "VZ-ROSE-50") never matches, because none of them are followed by a
 * recognized unit token (ml/l/g/kg). A bare number is never treated as a
 * size — if the title doesn't spell out a unit, nothing is extracted.
 */

export interface ExtractedVolume {
	/** The exact matched substring from the title, e.g. "75 ml". */
	raw: string
	/** Canonical form: normalized number + lowercase unit, space-separated. */
	normalized: string
}

const VOLUME_PATTERN = /(\d+(?:[.,]\d+)?)\s?(ml|kg|l|g)\b/i

export function extractVolumeFromTitle(title: string | null): ExtractedVolume | null {
	if (!title) return null
	const match = title.match(VOLUME_PATTERN)
	if (!match) return null

	const value = match[1].replace(',', '.')
	const unit = match[2].toLowerCase()
	return { raw: match[0], normalized: `${value} ${unit}` }
}
