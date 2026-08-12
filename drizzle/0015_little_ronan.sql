CREATE TABLE "pdv_change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"sale_id" text NOT NULL,
	"requester_name" text DEFAULT '' NOT NULL,
	"details_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "pdv_change_requests_type_check" CHECK ("type" IN ('observation', 'payment', 'seller', 'customer', 'product', 'markup', 'cancellation')),
	CONSTRAINT "pdv_change_requests_status_check" CHECK ("status" IN ('open', 'done', 'not_done', 'doubt'))
);
--> statement-breakpoint
CREATE INDEX "pdv_change_requests_sale_idx" ON "pdv_change_requests" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "pdv_change_requests_status_created_idx" ON "pdv_change_requests" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "pdv_change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "pdv_change_requests" FROM anon, authenticated;
