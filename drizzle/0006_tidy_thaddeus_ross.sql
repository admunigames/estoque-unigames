CREATE TABLE "supply_request_items" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"category_name" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"week_start" text NOT NULL,
	"responsible_name" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "supply_request_items_request_idx" ON "supply_request_items" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_requests_company_week_unique" ON "supply_requests" USING btree ("company_id","week_start");