import { describe, expect, test } from 'bun:test'
import { isAllowedProtocol, isPrivateOrReservedIPv4, isPrivateOrReservedIPv6 } from '../../src/lib/net/ssrf'

describe('isAllowedProtocol', () => {
	test('allows http and https', () => {
		expect(isAllowedProtocol('http:')).toBe(true)
		expect(isAllowedProtocol('https:')).toBe(true)
	})

	test('rejects other schemes', () => {
		expect(isAllowedProtocol('file:')).toBe(false)
		expect(isAllowedProtocol('ftp:')).toBe(false)
		expect(isAllowedProtocol('gopher:')).toBe(false)
		expect(isAllowedProtocol('data:')).toBe(false)
	})
})

describe('isPrivateOrReservedIPv4', () => {
	test('blocks loopback', () => {
		expect(isPrivateOrReservedIPv4('127.0.0.1')).toBe(true)
	})

	test('blocks RFC1918 private ranges', () => {
		expect(isPrivateOrReservedIPv4('10.0.0.1')).toBe(true)
		expect(isPrivateOrReservedIPv4('172.16.0.1')).toBe(true)
		expect(isPrivateOrReservedIPv4('172.31.255.255')).toBe(true)
		expect(isPrivateOrReservedIPv4('192.168.1.1')).toBe(true)
	})

	test('blocks link-local / cloud metadata address', () => {
		expect(isPrivateOrReservedIPv4('169.254.169.254')).toBe(true)
	})

	test('blocks CGNAT shared address space', () => {
		expect(isPrivateOrReservedIPv4('100.64.0.1')).toBe(true)
	})

	test('blocks multicast and reserved ranges', () => {
		expect(isPrivateOrReservedIPv4('224.0.0.1')).toBe(true)
		expect(isPrivateOrReservedIPv4('255.255.255.255')).toBe(true)
	})

	test('allows ordinary public addresses', () => {
		expect(isPrivateOrReservedIPv4('93.184.216.34')).toBe(false)
		expect(isPrivateOrReservedIPv4('8.8.8.8')).toBe(false)
	})

	test('fails closed on unparsable input', () => {
		expect(isPrivateOrReservedIPv4('not-an-ip')).toBe(true)
	})
})

describe('isPrivateOrReservedIPv6', () => {
	test('blocks loopback and unspecified', () => {
		expect(isPrivateOrReservedIPv6('::1')).toBe(true)
		expect(isPrivateOrReservedIPv6('::')).toBe(true)
	})

	test('blocks unique local addresses', () => {
		expect(isPrivateOrReservedIPv6('fd00::1')).toBe(true)
	})

	test('blocks link-local addresses', () => {
		expect(isPrivateOrReservedIPv6('fe80::1')).toBe(true)
	})

	test('blocks IPv4-mapped private addresses', () => {
		expect(isPrivateOrReservedIPv6('::ffff:127.0.0.1')).toBe(true)
		expect(isPrivateOrReservedIPv6('::ffff:10.0.0.1')).toBe(true)
	})

	test('allows IPv4-mapped public addresses', () => {
		expect(isPrivateOrReservedIPv6('::ffff:93.184.216.34')).toBe(false)
	})

	test('allows an ordinary public IPv6 address', () => {
		expect(isPrivateOrReservedIPv6('2606:4700:4700::1111')).toBe(false)
	})
})
