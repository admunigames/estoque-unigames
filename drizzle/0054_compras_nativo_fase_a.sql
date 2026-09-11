CREATE TABLE "purchase_draft_items" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"target_stores" text DEFAULT '[]' NOT NULL,
	"candidate_supplier_ids" text DEFAULT '[]' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"stock_snapshot_json" text DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'aberto' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"origin" text DEFAULT 'native' NOT NULL,
	"notion_purchase_id" text DEFAULT '' NOT NULL,
	"notion_purchase_url" text DEFAULT '' NOT NULL,
	"supplier_id" text DEFAULT '' NOT NULL,
	"supplier_name_raw" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"order_date" text DEFAULT '' NOT NULL,
	"expected_date" text DEFAULT '' NOT NULL,
	"received_date" text DEFAULT '' NOT NULL,
	"division" text DEFAULT '' NOT NULL,
	"division_status" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"no_items_detailed" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "purchase_draft_items_draft_idx" ON "purchase_draft_items" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "purchase_drafts_status_idx" ON "purchase_drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchase_orders_notion_purchase_idx" ON "purchase_orders" USING btree ("notion_purchase_id");--> statement-breakpoint
ALTER TABLE "purchase_draft_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "purchase_draft_items" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "purchase_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "purchase_drafts" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "purchase_orders" FROM anon, authenticated;
