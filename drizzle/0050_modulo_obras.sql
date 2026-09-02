CREATE TABLE "obra_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"obra_id" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"entry_date" text DEFAULT '' NOT NULL,
	"payment_method" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obras" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'reforma' NOT NULL,
	"responsible" text DEFAULT '' NOT NULL,
	"supplier_id" text DEFAULT '' NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"start_date" text DEFAULT '' NOT NULL,
	"expected_end_date" text DEFAULT '' NOT NULL,
	"end_date" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'planejada' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "obra_entries_obra_idx" ON "obra_entries" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "obras_company_idx" ON "obras" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "obras_status_idx" ON "obras" USING btree ("status");--> statement-breakpoint
ALTER TABLE "obras" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "obras" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "obra_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "obra_entries" FROM anon, authenticated;