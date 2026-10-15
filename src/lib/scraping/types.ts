import { z } from 'zod'
import { AVAILABILITY_VALUES } from '../normalize/normalize'

/** Where an extracted field's value came from, in precedence order (see extract.ts). */
export const FIELD_SOURCE_VALUES = ['json_ld', 'html_attribute', 'title', 'missing'] as const
export type FieldSource = (typeof FIELD_SOURCE_VALUES)[number]

/** Fields whose provenance is tracked. Kept separate from TRACKED_FIELDS in validate-live-report-types.ts, which covers the same set but is CLI-diagnostics-owned. */
export const PROVENANCE_FIELDS = ['title', 'brand', 'sku', 'gtin', 'variant', 'price', 'currency', 'availability'] as const
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number]

/** A field where JSON-LD and an HTML fallback source disagreed. The JSON-LD value (when present) is always what gets kept — see extract.ts. */
export interface FieldConflict {
	field: 'variant' | 'gtin'
	jsonLdValue: string | null
	htmlValue: string | null
}

export const NormalizedProductRecordSchema = z.object({
	sourceUrl: z.url(),
	extractedAt: z.iso.datetime(),
	title: z.object({
		raw: z.string().nullable(),
		normalized: z.string().nullable()
	}),
	brand: z.object({
		raw: z.unknown().nullable(),
		normalized: z.string().nullable()
	}),
	sku: z.string().nullable(),
	gtin: z.string().nullable(),
	variant: z.object({
		normalized: z.string().nullable()
	}),
	price: z.object({
		raw: z.unknown().nullable(),
		amount: z.number().nullable(),
		currency: z.string().nullable()
	}),
	availability: z.object({
		raw: z.unknown().nullable(),
		normalized: z.enum(AVAILABILITY_VALUES).nullable()
	}),
	/** Preserves the untouched JSON-LD node this record was built from, for audit/debugging. */
	rawJsonLd: z.record(z.string(), z.unknown()),
	/**
	 * Optional and additive — omitted entirely by older callers/fixtures,
	 * which keeps this schema backward-compatible. Maps a subset of
	 * PROVENANCE_FIELDS to where that value came from.
	 */
	fieldProvenance: z.record(z.string(), z.enum(FIELD_SOURCE_VALUES)).optional(),
	/** Present only when an HTML fallback source disagreed with JSON-LD for a field. Empty/omitted otherwise. */
	conflicts: z
		.array(
			z.object({
				field: z.enum(['variant', 'gtin']),
				jsonLdValue: z.string().nullable(),
				htmlValue: z.string().nullable()
			})
		)
		.optional()
})

export type NormalizedProductRecord = z.infer<typeof NormalizedProductRecordSchema>

export interface ExtractionFailure {
	sourceUrl: string
	reason:
		| 'no_structured_data_found'
		| 'no_product_type_found'
		| 'malformed_json_ld'
		| 'schema_validation_failed'
	message: string
}

export interface ExtractionResult {
	products: NormalizedProductRecord[]
	failures: ExtractionFailure[]
}
