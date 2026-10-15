import { z } from 'zod'
import { AVAILABILITY_VALUES } from '../normalize/normalize'

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
	rawJsonLd: z.record(z.string(), z.unknown())
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
