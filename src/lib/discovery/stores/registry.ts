import { makeupMdStoreProfile } from './makeup-md'
import type { StoreProfile } from './types'
import { vizajeNicaStoreProfile } from './vizaje-nica'

const STORE_PROFILES: Record<string, StoreProfile> = {
	[vizajeNicaStoreProfile.domain]: vizajeNicaStoreProfile,
	[makeupMdStoreProfile.domain]: makeupMdStoreProfile
}

/** Looks up a store's discovery profile by exact hostname (case-insensitive). Returns null for any domain without a registered profile — callers must not guess a fallback. */
export function getStoreProfile(domain: string): StoreProfile | null {
	return STORE_PROFILES[domain.toLowerCase()] ?? null
}

export { makeupMdStoreProfile, vizajeNicaStoreProfile }
export type { StoreProfile, StoreUrlMatch } from './types'
