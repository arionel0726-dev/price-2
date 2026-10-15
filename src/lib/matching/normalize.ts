import type { ParsedVolume } from './types'

/**
 * Matching-specific normalization. This is deliberately separate from
 * `src/lib/normalize/normalize.ts` (Task 1/2's extraction-time
 * normalization, which only does whitespace cleanup and preserves original
 * casing/content). Matching needs a more aggressive, lossy comparison form
 * — fold case/accents, bridge common transliteration, strip punctuation —
 * while the *original* values stay available in `MatchableListing` for
 * display. None of this feeds back into stored listing data.
 */

/** A small, curated Cyrillic→Latin transliteration table for brand names common in the Moldovan cosmetics market. Not a general transliteration engine — documented limitation. */
const KNOWN_BRAND_TRANSLITERATIONS: Record<string, string> = {
	шанель: 'chanel',
	диор: 'dior',
	ланком: 'lancome',
	'ив сен лоран': 'yves saint laurent',
	'ив сен-лоран': 'yves saint laurent',
	гуччи: 'gucci',
	армани: 'armani',
	версаче: 'versace',
	'живанши': 'givenchy',
	'клиник': 'clinique',
	'мэйбелин': 'maybelline',
	мейбелин: 'maybelline'
}

/** Generic Cyrillic→Latin phonetic fallback (simplified, not a linguistic transliteration standard). Applied only when the input contains Cyrillic characters. */
const CYRILLIC_TO_LATIN: Record<string, string> = {
	а: 'a',
	б: 'b',
	в: 'v',
	г: 'g',
	д: 'd',
	е: 'e',
	ё: 'e',
	ж: 'zh',
	з: 'z',
	и: 'i',
	й: 'i',
	к: 'k',
	л: 'l',
	м: 'm',
	н: 'n',
	о: 'o',
	п: 'p',
	р: 'r',
	с: 's',
	т: 't',
	у: 'u',
	ф: 'f',
	х: 'h',
	ц: 'ts',
	ч: 'ch',
	ш: 'sh',
	щ: 'sch',
	ъ: '',
	ы: 'y',
	ь: '',
	э: 'e',
	ю: 'yu',
	я: 'ya'
}

const HAS_CYRILLIC = /[Ѐ-ӿ]/

function transliterateCyrillic(text: string): string {
	if (!HAS_CYRILLIC.test(text)) return text
	return text
		.split('')
		.map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
		.join('')
}

/** NFKD unicode fold + strip diacritics/accents + lowercase. */
export function foldUnicode(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
}

/**
 * Strips punctuation to spaces and collapses whitespace. Does not remove
 * any alphanumeric token, and deliberately preserves a `.`/`,` that sits
 * between two digits (a decimal separator, e.g. "0.1l") — stripping it
 * would silently turn "0.1l" into "0 1l" and corrupt volume parsing.
 */
export function stripPunctuation(text: string): string {
	return text
		.replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
		.replace(/[;:!?'"()[\]{}/\\|_+=~`^*#@&<>]/g, ' ')
		.replace(/-/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Normalizes a brand name for cross-store matching: unicode fold, known
 * transliteration lookup, generic Cyrillic fallback, punctuation/whitespace
 * cleanup. Returns null for empty/absent input — never invents a brand.
 */
export function normalizeBrandForMatching(brand: string | null): string | null {
	if (!brand) return null
	const folded = foldUnicode(brand.trim())
	if (!folded) return null
	const known = KNOWN_BRAND_TRANSLITERATIONS[folded]
	if (known) return known
	return stripPunctuation(transliterateCyrillic(folded))
}

/**
 * Normalizes a title for comparison. Folds case/accents and transliterates,
 * but deliberately does NOT strip concentration abbreviations (edp/edt/...),
 * volume tokens, or variant codes — those are extracted separately and must
 * stay distinguishable; removing them here would make e.g. an EDP and an
 * EDT of the same perfume compare as identical titles.
 */
export function normalizeTitleForMatching(title: string | null): string | null {
	if (!title) return null
	const folded = foldUnicode(title.trim())
	if (!folded) return null
	return stripPunctuation(transliterateCyrillic(folded))
}

/** Splits a normalized title into non-empty tokens. */
export function tokenize(normalizedText: string): string[] {
	return normalizedText.split(' ').filter((t) => t.length > 0)
}

const CONCENTRATION_PATTERNS: [RegExp, string][] = [
	[/\beau de parfum\b/, 'edp'],
	[/\beau de toilette\b/, 'edt'],
	[/\beau de cologne\b/, 'edc'],
	[/\bparfum\b/, 'parfum'],
	[/\bedp\b/, 'edp'],
	[/\bedt\b/, 'edt'],
	[/\bedc\b/, 'edc']
]

/**
 * Extracts a canonical perfume concentration code (edp/edt/edc/parfum) from
 * normalized text. Returns null when no explicit concentration marker is
 * present — concentration must never be guessed.
 */
export function parseConcentration(normalizedText: string | null): string | null {
	if (!normalizedText) return null
	for (const [pattern, code] of CONCENTRATION_PATTERNS) {
		if (pattern.test(normalizedText)) return code
	}
	return null
}

const VOLUME_PATTERN = /(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|oz)\b/i

/**
 * Extracts an explicit volume/weight with its unit, converted to a common
 * magnitude per dimension (ml for liquids, g for solids) so "0.1l" and
 * "100ml" compare equal. Volume (ml) and weight (g) are never compared
 * against each other. Returns null when no explicit value is present in
 * the text — volume is never inferred.
 */
export function parseVolume(normalizedText: string | null): ParsedVolume | null {
	if (!normalizedText) return null
	const match = normalizedText.match(VOLUME_PATTERN)
	if (!match) return null

	const rawValue = Number(match[1].replace(',', '.'))
	if (!Number.isFinite(rawValue)) return null
	const rawUnit = match[2].toLowerCase()

	if (rawUnit === 'ml') return { value: rawValue, unit: 'ml', raw: match[0] }
	if (rawUnit === 'l') return { value: rawValue * 1000, unit: 'ml', raw: match[0] }
	if (rawUnit === 'g') return { value: rawValue, unit: 'g', raw: match[0] }
	if (rawUnit === 'kg') return { value: rawValue * 1000, unit: 'g', raw: match[0] }
	// 'oz' is ambiguous between fluid ounces and weight ounces without more
	// context than we have here — deliberately not parsed rather than guessed.
	return null
}

const VARIANT_CODE_PATTERN = /(?:shade|tone|teinte|nuanta|nr\.?|no\.?|№)\s*0*(\d{1,3})\b/i

/** Extracts an explicit shade/variant number (e.g. "shade 01", "№ 2"). Returns null when absent. */
export function parseVariantCode(normalizedText: string | null): string | null {
	if (!normalizedText) return null
	const match = normalizedText.match(VARIANT_CODE_PATTERN)
	return match ? match[1] : null
}

const REFILL_PATTERN = /\b(refill|recharge|rezerva|rezervă|navulire)\b/
const SET_PATTERN = /\b(gift set|set|kit|coffret|набор|набiр)\b/

/**
 * Extracts a coarse product-format tag when explicitly indicated:
 * 'refill' (vs. standard bottle) or 'set' (a bundle, vs. a single product).
 * Returns null when neither is explicitly indicated — most listings are
 * standard single bottles, and that must never be assumed where sets or
 * refills coexist in a catalog.
 */
export function parseFormat(normalizedText: string | null): 'refill' | 'set' | null {
	if (!normalizedText) return null
	if (REFILL_PATTERN.test(normalizedText)) return 'refill'
	if (SET_PATTERN.test(normalizedText)) return 'set'
	return null
}

/** Dice coefficient over character bigrams — robust to small spelling/typo differences. */
export function diceBigramSimilarity(a: string, b: string): number {
	if (a === b) return 1
	if (a.length < 2 || b.length < 2) return a === b ? 1 : 0

	const bigrams = (s: string): Map<string, number> => {
		const map = new Map<string, number>()
		for (let i = 0; i < s.length - 1; i++) {
			const bg = s.slice(i, i + 2)
			map.set(bg, (map.get(bg) ?? 0) + 1)
		}
		return map
	}

	const bigramsA = bigrams(a)
	const bigramsB = bigrams(b)
	let intersection = 0
	for (const [bg, countA] of bigramsA) {
		const countB = bigramsB.get(bg)
		if (countB) intersection += Math.min(countA, countB)
	}

	const totalA = [...bigramsA.values()].reduce((s, n) => s + n, 0)
	const totalB = [...bigramsB.values()].reduce((s, n) => s + n, 0)
	if (totalA + totalB === 0) return 0
	return (2 * intersection) / (totalA + totalB)
}

/** Jaccard similarity over token sets — robust to word reordering. */
export function jaccardTokenSimilarity(tokensA: string[], tokensB: string[]): number {
	if (tokensA.length === 0 || tokensB.length === 0) return 0
	const setA = new Set(tokensA)
	const setB = new Set(tokensB)
	let intersection = 0
	for (const t of setA) if (setB.has(t)) intersection++
	const union = setA.size + setB.size - intersection
	return union === 0 ? 0 : intersection / union
}

/** Combined title similarity: weighted blend of bigram (typo-robust) and token (reorder-robust) similarity. */
export function titleSimilarity(normalizedA: string | null, normalizedB: string | null): number {
	if (!normalizedA || !normalizedB) return 0
	const dice = diceBigramSimilarity(normalizedA, normalizedB)
	const jaccard = jaccardTokenSimilarity(tokenize(normalizedA), tokenize(normalizedB))
	return 0.6 * dice + 0.4 * jaccard
}

const GTIN_VALID_LENGTHS = [8, 12, 13, 14]

/**
 * Validates a GTIN/EAN/UPC via its GS1 mod-10 check digit. Returns the
 * cleaned digit string when valid, or null when the value is missing,
 * non-numeric, the wrong length, or fails the checksum — an unvalidated
 * code must never be treated as a reliable identity signal.
 */
export function validateGtin(code: string | null): string | null {
	if (!code) return null
	const digits = code.replace(/[\s-]/g, '')
	if (!/^\d+$/.test(digits)) return null
	if (!GTIN_VALID_LENGTHS.includes(digits.length)) return null

	const checkDigit = Number(digits[digits.length - 1])
	const body = digits.slice(0, -1).split('').reverse()

	let sum = 0
	for (let i = 0; i < body.length; i++) {
		const digit = Number(body[i])
		sum += i % 2 === 0 ? digit * 3 : digit
	}
	const computedCheckDigit = (10 - (sum % 10)) % 10

	return computedCheckDigit === checkDigit ? digits : null
}
