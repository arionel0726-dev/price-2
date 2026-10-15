/**
 * Conservative barcode/GTIN extraction from free HTML text.
 *
 * This only ever returns a value when the surrounding text EXPLICITLY
 * labels it as a barcode/GTIN/EAN (never a bare number, and never a SKU —
 * a store-specific stock code is not a GTIN even when it happens to be
 * all-digits) and the digits pass the standard GS1 checksum. If neither
 * condition holds, the result is `null` — missing, not guessed.
 */

const GTIN_VALID_LENGTHS = [8, 12, 13, 14]

/** Validates a GTIN/EAN/UPC via its GS1 mod-10 check digit. Mirrors the algorithm in src/lib/matching/normalize.ts, kept as an independent copy per the two modules' separation of concerns (see AGENTS.md). */
export function validateGtinChecksum(code: string): string | null {
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

// Matches an explicit barcode/GTIN/EAN label (English and Romanian) followed by a digit run.
const BARCODE_LABEL_PATTERN = /\b(?:cod\s*(?:de\s*)?bare|barcode|gtin|ean)\b\s*[:#-]?\s*([0-9][0-9\s-]{6,15}[0-9])/i

/**
 * Extracts a GTIN from free text, but only when it is explicitly labeled
 * as a barcode/GTIN/EAN in the surrounding text and the digits pass the
 * GS1 checksum. Returns null otherwise — in particular, this never
 * extracts a SKU or any other unlabeled digit string.
 */
export function extractLabeledBarcode(text: string): string | null {
	const match = text.match(BARCODE_LABEL_PATTERN)
	if (!match) return null
	const digitsOnly = match[1].replace(/[\s-]/g, '')
	return validateGtinChecksum(digitsOnly)
}
