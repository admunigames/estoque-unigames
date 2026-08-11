CREATE TABLE "supply_missing_marks" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"week_start" text NOT NULL,
	"marked_by" text NOT NULL,
	"marked_by_name" text DEFAULT '' NOT NULL,
	"marked_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "supply_missing_marks_unique" ON "supply_missing_marks" USING btree ("product_id","company_id","week_start");--> statement-breakpoint
CREATE INDEX "supply_missing_marks_company_week_idx" ON "supply_missing_marks" USING btree ("company_id","week_start");