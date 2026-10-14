import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
