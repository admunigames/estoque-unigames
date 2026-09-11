CREATE TABLE "purchase_order_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"attachment_type" text NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "purchase_order_attachments_r2_key_unique" UNIQUE("r2_key")
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "canceled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "purchase_order_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "purchase_order_attachments_order_idx" ON "purchase_order_attachments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_purchase_order_idx" ON "supplier_invoices" USING btree ("purchase_order_id");--> statement-breakpoint
ALTER TABLE "purchase_order_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "purchase_order_attachments" FROM anon, authenticated;
