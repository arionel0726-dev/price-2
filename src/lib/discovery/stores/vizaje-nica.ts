/**
 * Adapts the existing, empirically-verified vizaje-nica.com classifier
 * (`../pilot-patterns.ts`, unchanged — see that module's own tests) to the
 * generic `StoreProfile` shape. This wrapper exists so the multi-store
 * validation pipeline can treat every store uniformly; it intentionally
 * does not change any matching/dedup behavior for vizaje-nica.com.
 */
import { dedupeLanguageVariants, matchVizajeNicaProductUrl } from '../pilot-patterns'
import type { StoreProfile, StoreUrlMatch } from './types'

function classifyProductUrl(url: string): StoreUrlMatch | null {
	const match = matchVizajeNicaProductUrl(url)
	if (!match) return null
	return {
		dedupeKey: `${match.category}/${match.numericId}`,
		language: match.language,
		reason: `Matched verified pilot pattern /${match.language}/catalog/${match.category}/${match.numericId} (confirmed against a real live sample — see Task 4/5 delivery notes)`
	}
}

export const vizajeNicaStoreProfile: StoreProfile = {
	domain: 'vizaje-nica.com',
	defaultSitemapUrl: 'https://vizaje-nica.com/sitemap.xml',
	patternConfidence: 'verified', // confirmed against a real 10-page live sample — see Task 4/5 delivery notes
	classifyProductUrl,
	dedupeProductUrls: dedupeLanguageVariants,
	sortCandidates: (urls) =>
		[...urls].sort((a, b) => {
			const langA = matchVizajeNicaProductUrl(a)?.language ?? 'zz'
			const langB = matchVizajeNicaProductUrl(b)?.language ?? 'zz'
			return langA === langB ? 0 : langA === 'ro' ? -1 : langB === 'ro' ? 1 : 0
		})
}
