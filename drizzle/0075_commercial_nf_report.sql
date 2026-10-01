CREATE TABLE "commercial_nf_report_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"report_date" text NOT NULL,
	"store_id" text NOT NULL,
	"store_name" text DEFAULT '' NOT NULL,
	"sales_count" integer DEFAULT 0 NOT NULL,
	"invoices_issued_count" integer DEFAULT 0 NOT NULL,
	"sales_amount_cents" integer DEFAULT 0 NOT NULL,
	"invoices_issued_amount_cents" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_nf_report_entries_date_store_idx" ON "commercial_nf_report_entries" USING btree ("report_date","store_id");--> statement-breakpoint
CREATE INDEX "commercial_nf_report_entries_date_idx" ON "commercial_nf_report_entries" USING btree ("report_date");--> statement-breakpoint
ALTER TABLE "commercial_nf_report_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_nf_report_entries" FROM anon, authenticated;
