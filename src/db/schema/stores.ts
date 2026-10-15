import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * A store is just an independently identifiable website. Its role within a
 * monitoring configuration (owned store vs. competitor) is deliberately not
 * modeled here — that is a per-configuration concern for a later task, not
 * a permanent attribute of the store itself.
 */
export const stores = pgTable('stores', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull(),
	domain: text('domain').notNull().unique(),
	createdAt: timestamp('created_at', {
		withTimezone: true
	})
		.defaultNow()
		.notNull()
})
