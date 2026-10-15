CREATE TYPE "public"."availability_status" AS ENUM('in_stock', 'out_of_stock', 'preorder', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."scan_run_status" AS ENUM('running', 'completed', 'failed', 'partial');--> statement-breakpoint
CREATE TABLE "catalog_scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "scan_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"discovered_url_count" integer DEFAULT 0 NOT NULL,
	"extracted_product_count" integer DEFAULT 0 NOT NULL,
	"new_listing_count" integer DEFAULT 0 NOT NULL,
	"updated_listing_count" integer DEFAULT 0 NOT NULL,
	"failed_extraction_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"source_title" text,
	"normalized_title" text,
	"brand" text,
	"sku" text,
	"gtin" text,
	"variant" text,
	"price" numeric(12, 2),
	"currency" text,
	"price_last_seen_at" timestamp with time zone,
	"last_observation_missing_price" boolean DEFAULT false NOT NULL,
	"availability" "availability_status",
	"availability_last_seen_at" timestamp with time zone,
	"last_observation_missing_availability" boolean DEFAULT false NOT NULL,
	"raw_attributes" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_scan_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_scan_runs" ADD CONSTRAINT "catalog_scan_runs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_listings" ADD CONSTRAINT "store_listings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_listings" ADD CONSTRAINT "store_listings_last_scan_run_id_catalog_scan_runs_id_fk" FOREIGN KEY ("last_scan_run_id") REFERENCES "public"."catalog_scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_scan_runs_store_started_idx" ON "catalog_scan_runs" USING btree ("store_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_listings_store_canonical_url_unique" ON "store_listings" USING btree ("store_id","canonical_url");--> statement-breakpoint
CREATE INDEX "store_listings_store_sku_idx" ON "store_listings" USING btree ("store_id","sku");--> statement-breakpoint
CREATE INDEX "store_listings_store_gtin_idx" ON "store_listings" USING btree ("store_id","gtin");