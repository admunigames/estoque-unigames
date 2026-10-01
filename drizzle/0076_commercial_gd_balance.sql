CREATE TABLE "commercial_gd_balance_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"store_name" text DEFAULT '' NOT NULL,
	"adjustment_date" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"canceled" integer DEFAULT 0 NOT NULL,
	"canceled_by" text DEFAULT '' NOT NULL,
	"canceled_by_name" text DEFAULT '' NOT NULL,
	"canceled_at" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "commercial_gd_adjustments_store_date_idx" ON "commercial_gd_balance_adjustments" USING btree ("store_id","adjustment_date");--> statement-breakpoint
CREATE INDEX "commercial_gd_adjustments_date_idx" ON "commercial_gd_balance_adjustments" USING btree ("adjustment_date");--> statement-breakpoint
ALTER TABLE "commercial_gd_balance_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_gd_balance_adjustments" FROM anon, authenticated;
