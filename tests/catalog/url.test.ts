import { describe, expect, test } from 'bun:test'
import { canonicalizeProductUrl, InvalidProductUrlError } from '../../src/lib/catalog/url'

describe('canonicalizeProductUrl', () => {
	test('lowercases the host and strips the default port', () => {
		expect(canonicalizeProductUrl('HTTPS://Shop.Example.TEST:443/products/rose')).toBe(
			'https://shop.example.test/products/rose'
		)
	})

	test('strips a trailing slash from the path, but keeps a bare root path', () => {
		expect(canonicalizeProductUrl('https://shop.example.test/products/rose/')).toBe(
			'https://shop.example.test/products/rose'
		)
		expect(canonicalizeProductUrl('https://shop.example.test/')).toBe('https://shop.example.test/')
	})

	test('removes known tracking parameters', () => {
		expect(
			canonicalizeProductUrl('https://shop.example.test/products/rose?utm_source=fb&utm_campaign=x&gclid=abc&fbclid=def')
		).toBe('https://shop.example.test/products/rose')
	})

	test('preserves query parameters that may identify a product variant', () => {
		expect(canonicalizeProductUrl('https://shop.example.test/products/rose?size=50ml')).toBe(
			'https://shop.example.test/products/rose?size=50ml'
		)
	})

	test('produces the same canonical URL regardless of query parameter order', () => {
		const a = canonicalizeProductUrl('https://shop.example.test/products/rose?color=red&size=50ml')
		const b = canonicalizeProductUrl('https://shop.example.test/products/rose?size=50ml&color=red')
		expect(a).toBe(b)
	})

	test('strips the URL fragment', () => {
		expect(canonicalizeProductUrl('https://shop.example.test/products/rose#reviews')).toBe(
			'https://shop.example.test/products/rose'
		)
	})

	test('throws InvalidProductUrlError for an unparsable URL', () => {
		expect(() => canonicalizeProductUrl('not a url')).toThrow(InvalidProductUrlError)
	})
})
