CREATE TABLE "commercial_monthly" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"sheet_seller_name" text DEFAULT '' NOT NULL,
	"sheet_store_name" text DEFAULT '' NOT NULL,
	"zone" text DEFAULT '' NOT NULL,
	"month" text NOT NULL,
	"target_revenue_cents" integer DEFAULT 0 NOT NULL,
	"target_items" integer DEFAULT 0 NOT NULL,
	"target_super_items" integer DEFAULT 0 NOT NULL,
	"target_warranty_cents" integer DEFAULT 0 NOT NULL,
	"target_realme" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"warranty_cents" integer DEFAULT 0 NOT NULL,
	"realme" integer DEFAULT 0 NOT NULL,
	"warranty_qty" integer DEFAULT 0 NOT NULL,
	"notebook_qty" integer DEFAULT 0 NOT NULL,
	"import_id" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_monthly_employee_month_idx" ON "commercial_monthly" USING btree ("employee_id","month");--> statement-breakpoint
CREATE INDEX "commercial_monthly_month_idx" ON "commercial_monthly" USING btree ("month");--> statement-breakpoint
ALTER TABLE "commercial_monthly" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_monthly" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE "commercial_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"sheet_name" text DEFAULT '' NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_ignored" integer DEFAULT 0 NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "commercial_imports_month_idx" ON "commercial_imports" USING btree ("month");--> statement-breakpoint
ALTER TABLE "commercial_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_imports" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE "commercial_aliases" (
	"alias_key" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commercial_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_aliases" FROM anon, authenticated;
