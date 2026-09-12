DROP TABLE "purchase_draft_items";--> statement-breakpoint
DROP TABLE "purchase_drafts";--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "won_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "won_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "won_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "candidate_supplier_ids" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE TABLE "purchase_order_item_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "purchase_order_item_quotes_item_idx" ON "purchase_order_item_quotes" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_item_quotes_item_supplier_idx" ON "purchase_order_item_quotes" USING btree ("item_id","supplier_id");--> statement-breakpoint
ALTER TABLE "purchase_order_item_quotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "purchase_order_item_quotes" FROM anon, authenticated;
