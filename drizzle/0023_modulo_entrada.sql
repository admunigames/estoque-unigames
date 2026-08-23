CREATE TABLE "requested_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"quantity" integer NOT NULL,
	"product_name" text NOT NULL,
	"responsible_name" text DEFAULT '' NOT NULL,
	"reason" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"completed_by" text DEFAULT '' NOT NULL,
	"completed_by_name" text DEFAULT '' NOT NULL,
	"completed_at" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "requested_inputs_status_created_idx" ON "requested_inputs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "requested_inputs_company_created_idx" ON "requested_inputs" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "requested_inputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "requested_inputs" FROM anon, authenticated;