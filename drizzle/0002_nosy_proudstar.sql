CREATE TYPE "public"."match_provenance" AS ENUM('automatic', 'manual');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('pending_review', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "product_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_a_id" uuid NOT NULL,
	"listing_b_id" uuid NOT NULL,
	"status" "match_status" NOT NULL,
	"provenance" "match_provenance" NOT NULL,
	"algorithm_version" text NOT NULL,
	"score" numeric(5, 4),
	"decision" text NOT NULL,
	"signals" jsonb NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_matches_pair_order_chk" CHECK ("product_matches"."listing_a_id" < "product_matches"."listing_b_id")
);
--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_listing_a_id_store_listings_id_fk" FOREIGN KEY ("listing_a_id") REFERENCES "public"."store_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_listing_b_id_store_listings_id_fk" FOREIGN KEY ("listing_b_id") REFERENCES "public"."store_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_matches_pair_unique" ON "product_matches" USING btree ("listing_a_id","listing_b_id");--> statement-breakpoint
CREATE INDEX "product_matches_listing_a_idx" ON "product_matches" USING btree ("listing_a_id");--> statement-breakpoint
CREATE INDEX "product_matches_listing_b_idx" ON "product_matches" USING btree ("listing_b_id");--> statement-breakpoint
CREATE INDEX "product_matches_status_idx" ON "product_matches" USING btree ("status");