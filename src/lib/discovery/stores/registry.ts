import { makeupMdStoreProfile } from './makeup-md'
import { ovicoMdStoreProfile } from './ovico-md'
import type { StoreProfile } from './types'
import { vizajeNicaStoreProfile } from './vizaje-nica'

const STORE_PROFILES: Record<string, StoreProfile> = {
	[vizajeNicaStoreProfile.domain]: vizajeNicaStoreProfile,
	[makeupMdStoreProfile.domain]: makeupMdStoreProfile,
	[ovicoMdStoreProfile.domain]: ovicoMdStoreProfile
}

/** Looks up a store's discovery profile by exact hostname (case-insensitive). Returns null for any domain without a registered profile — callers must not guess a fallback. */
export function getStoreProfile(domain: string): StoreProfile | null {
	return STORE_PROFILES[domain.toLowerCase()] ?? null
}

export { makeupMdStoreProfile, ovicoMdStoreProfile, vizajeNicaStoreProfile }
export type { StoreProfile, StoreUrlMatch } from './types'
