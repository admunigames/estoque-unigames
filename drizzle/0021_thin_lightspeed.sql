CREATE TABLE "finance_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_items" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_store_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"item_id" text NOT NULL,
	"month" text NOT NULL,
	"entry_type" text NOT NULL,
	"amount_cents" integer,
	"percent_basis_points" integer,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "finance_store_entries_entry_type_check" CHECK ("entry_type" IN ('fixed', 'percentage'))
);
--> statement-breakpoint
CREATE TABLE "finance_store_revenue" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"month" text NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "finance_categories_parent_idx" ON "finance_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "finance_items_category_idx" ON "finance_items" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_store_entries_store_item_month_idx" ON "finance_store_entries" USING btree ("store_id","item_id","month");--> statement-breakpoint
CREATE INDEX "finance_store_entries_store_month_idx" ON "finance_store_entries" USING btree ("store_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_store_revenue_store_month_idx" ON "finance_store_revenue" USING btree ("store_id","month");--> statement-breakpoint
ALTER TABLE "finance_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "finance_categories" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "finance_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "finance_items" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "finance_store_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "finance_store_entries" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "finance_store_revenue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "finance_store_revenue" FROM anon, authenticated;