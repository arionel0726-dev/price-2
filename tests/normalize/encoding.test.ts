import { describe, expect, test } from 'bun:test'
import { repairMojibake, tryRepairUtf8MisreadAsWindows1251 } from '../../src/lib/normalize/encoding'

/** Simulates the real corruption: encode correct text as UTF-8, then decode those bytes as Windows-1251 — this is what the pilot site's stored data apparently already did. */
function corruptAsIfMisreadAsWindows1251(correctText: string): string {
	const utf8Bytes = new TextEncoder().encode(correctText)
	return new TextDecoder('windows-1251').decode(utf8Bytes)
}

describe('repairMojibake — the exact real-world example from Task 4/5', () => {
	test('repairs "ApДѓ de parfum" back to "Apă de parfum"', () => {
		expect(repairMojibake('MORESQUE Jasminisha 75 ml ApДѓ de parfum')).toBe('MORESQUE Jasminisha 75 ml Apă de parfum')
	})
})

describe('repairMojibake — round-trip against representative Romanian text', () => {
	const romanianSamples = [
		'Apă de parfum',
		'Ținută îndelungată și catifelată',
		'Crăpat și Întărit',
		'Ștergere ușoară',
		'Îngrijire Corp'
	]

	for (const correct of romanianSamples) {
		test(`repairs a corrupted version of "${correct}"`, () => {
			const corrupted = corruptAsIfMisreadAsWindows1251(correct)
			expect(repairMojibake(corrupted)).toBe(correct)
		})
	}
})

describe('repairMojibake — never touches text that is not actually corrupted', () => {
	test('leaves plain ASCII untouched', () => {
		expect(repairMojibake('Crema Antirid Aurelia 50ml')).toBe('Crema Antirid Aurelia 50ml')
	})

	test('leaves correct, uncorrupted Romanian diacritics untouched', () => {
		const text = 'MORESQUE Jasminisha 75 ml Apă de parfum'
		expect(tryRepairUtf8MisreadAsWindows1251(text)).toBeNull()
		expect(repairMojibake(text)).toBe(text)
	})

	test('leaves correct, uncorrupted Cyrillic (e.g. Russian-language listings) untouched', () => {
		const samples = ['Сандаловое мыло 100г', 'Тушь для ресниц чёрная объёмная', 'Крема Антирид Aurelia']
		for (const text of samples) {
			expect(tryRepairUtf8MisreadAsWindows1251(text)).toBeNull()
			expect(repairMojibake(text)).toBe(text)
		}
	})

	test('leaves SKUs, GTINs, and other plain identifiers untouched', () => {
		expect(repairMojibake('VZ-ANTIRID-50')).toBe('VZ-ANTIRID-50')
		expect(repairMojibake('5901234123457')).toBe('5901234123457')
	})

	test('returns null (not a guess) for text containing characters outside the Windows-1251 repertoire', () => {
		expect(tryRepairUtf8MisreadAsWindows1251('日本語のテキスト')).toBeNull()
		expect(tryRepairUtf8MisreadAsWindows1251('emoji 🎉 text')).toBeNull()
	})
})
