CREATE TABLE "divergence_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'aberto' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"finalized_at" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "divergence_requests_company_idx" ON "divergence_requests" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "divergence_requests_status_idx" ON "divergence_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "divergence_requests_created_idx" ON "divergence_requests" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "divergence_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "divergence_requests" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE "divergence_items" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"product_code" text DEFAULT '' NOT NULL,
	"product_name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"physical_qty" integer DEFAULT 0 NOT NULL,
	"system_qty" integer DEFAULT 0 NOT NULL,
	"store_notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'nao_visto' NOT NULL,
	"stock_response" text DEFAULT '' NOT NULL,
	"responded_by" text DEFAULT '' NOT NULL,
	"responded_by_name" text DEFAULT '' NOT NULL,
	"responded_at" text DEFAULT '' NOT NULL,
	"store_reply" text DEFAULT '' NOT NULL,
	"store_reply_by" text DEFAULT '' NOT NULL,
	"store_reply_by_name" text DEFAULT '' NOT NULL,
	"store_reply_at" text DEFAULT '' NOT NULL,
	"inventoried_at" text DEFAULT '' NOT NULL,
	"inventoried_by" text DEFAULT '' NOT NULL,
	"inventoried_by_name" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "divergence_items_request_idx" ON "divergence_items" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "divergence_items_status_idx" ON "divergence_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "divergence_items_product_code_idx" ON "divergence_items" USING btree ("product_code");--> statement-breakpoint
ALTER TABLE "divergence_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "divergence_items" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE "divergence_item_events" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_status" text DEFAULT '' NOT NULL,
	"to_status" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"actor_id" text DEFAULT '' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "divergence_item_events_item_idx" ON "divergence_item_events" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "divergence_item_events_request_idx" ON "divergence_item_events" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "divergence_item_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "divergence_item_events" FROM anon, authenticated;
