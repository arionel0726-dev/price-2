/**
 * Repairs a specific, narrowly-detectable text corruption pattern seen on
 * the pilot store: a UTF-8 byte sequence that was, somewhere upstream of
 * us (most likely baked into the site's own stored data — see the module
 * doc below), re-read using the Windows-1251 (Cyrillic) single-byte
 * codepage. The telltale symptom is a Romanian diacritic turning into one
 * or two unrelated Cyrillic characters, e.g.:
 *
 *   "Apă de parfum"  -- correct UTF-8 bytes for "ă" (0xC4 0x83) --
 *   "ApДѓ de parfum" -- those same two bytes read as Windows-1251 ("Д", "ѓ")
 *
 * This is NOT a general transliteration or "fix weird characters" tool.
 * `repairMojibake` only ever changes `text` when BOTH of these hold:
 *
 *   1. Every character of `text` has a defined Windows-1251 byte value
 *      (so a string containing e.g. Chinese or emoji is left untouched).
 *   2. Re-encoding those bytes and decoding them as STRICT UTF-8 (via
 *      `TextDecoder({ fatal: true })`, which throws on any invalid byte
 *      sequence) succeeds.
 *
 * Both conditions together make this a very safe, self-gating check in
 * practice: legitimate Cyrillic or already-correct Romanian text, when
 * run through the same round-trip, overwhelmingly fails strict UTF-8
 * validation (Windows-1251 letters often map to byte values — e.g. 0xC0,
 * 0xC1 — that UTF-8 forbids as lead bytes) and is therefore left alone.
 * This has been verified empirically against representative real
 * Romanian and Cyrillic product-title samples (see
 * tests/scraping/encoding.test.ts) before being wired into extraction.
 *
 * Root cause note: our own HTTP response decoding already uses UTF-8 (see
 * `src/lib/net/safe-fetch.ts`), and does so correctly for well-formed
 * UTF-8 bytes. The corruption this repairs reproduces exactly from
 * encoding clean text to UTF-8 and reading those bytes back as
 * Windows-1251 — i.e. the site's own stored/served text already contains
 * this corruption, most likely from a historical encoding-migration bug
 * on their end. We cannot fix their data; we can only detect and reverse
 * this one specific, reversible pattern when we see it.
 */

const WINDOWS_1251_DECODER = new TextDecoder('windows-1251')
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

let charToWindows1251Byte: Map<string, number> | null = null

/**
 * Builds the char→byte reverse lookup once, by decoding every possible
 * byte 0x00-0xFF through the platform's own Windows-1251 decoder — this
 * guarantees the table matches whatever codepage data the runtime
 * actually implements, instead of a hand-transcribed table that could
 * silently drift from the real standard.
 */
function getCharToWindows1251Byte(): Map<string, number> {
	if (charToWindows1251Byte) return charToWindows1251Byte

	const table = new Map<string, number>()
	for (let byte = 0; byte < 256; byte++) {
		const char = WINDOWS_1251_DECODER.decode(Uint8Array.of(byte))
		if (!table.has(char)) table.set(char, byte)
	}
	charToWindows1251Byte = table
	return table
}

/**
 * Attempts the UTF-8-misread-as-Windows-1251 repair described above.
 * Returns the repaired string, or `null` when the pattern doesn't apply
 * (so callers can tell "not applicable" apart from "applicable but
 * happened to produce the same text").
 */
export function tryRepairUtf8MisreadAsWindows1251(text: string): string | null {
	const table = getCharToWindows1251Byte()
	const bytes = new Uint8Array(text.length)

	for (let i = 0; i < text.length; i++) {
		const byte = table.get(text[i])
		if (byte === undefined) return null
		bytes[i] = byte
	}

	try {
		return STRICT_UTF8_DECODER.decode(bytes)
	} catch {
		return null
	}
}

/**
 * Convenience wrapper for call sites that just want "the best text to
 * use": returns the repaired string when the corruption pattern is
 * confidently detected, otherwise returns `text` completely unchanged.
 */
export function repairMojibake(text: string): string {
	const repaired = tryRepairUtf8MisreadAsWindows1251(text)
	return repaired ?? text
}
