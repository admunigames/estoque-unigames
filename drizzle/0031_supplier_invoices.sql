CREATE TABLE "supplier_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"supplier_id" text DEFAULT '' NOT NULL,
	"supplier_document" text DEFAULT '' NOT NULL,
	"invoice_number" text NOT NULL,
	"series" text DEFAULT '' NOT NULL,
	"access_key" text DEFAULT '' NOT NULL,
	"issue_date" text DEFAULT '' NOT NULL,
	"entry_date" text DEFAULT '' NOT NULL,
	"competence_month" text NOT NULL,
	"notion_purchase_id" text DEFAULT '' NOT NULL,
	"notion_purchase_url" text DEFAULT '' NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"finance_category_id" text DEFAULT '' NOT NULL,
	"finance_item_id" text DEFAULT '' NOT NULL,
	"cost_center" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"operational_status" text DEFAULT '' NOT NULL,
	"financial_status" text DEFAULT 'aguardando_envio' NOT NULL,
	"pending_correction" integer DEFAULT 0 NOT NULL,
	"return_reason" text DEFAULT '' NOT NULL,
	"canceled" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"sent_to_finance_by" text DEFAULT '' NOT NULL,
	"sent_to_finance_by_name" text DEFAULT '' NOT NULL,
	"sent_to_finance_at" text DEFAULT '' NOT NULL,
	"returned_by" text DEFAULT '' NOT NULL,
	"returned_by_name" text DEFAULT '' NOT NULL,
	"returned_at" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_installments" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"company_id" text NOT NULL,
	"installment_number" integer DEFAULT 1 NOT NULL,
	"installment_total" integer DEFAULT 1 NOT NULL,
	"document_number" text DEFAULT '' NOT NULL,
	"due_date" text NOT NULL,
	"original_amount_cents" integer NOT NULL,
	"paid_amount_cents" integer DEFAULT 0 NOT NULL,
	"payment_method" text DEFAULT '' NOT NULL,
	"finance_account_id" text DEFAULT '' NOT NULL,
	"boleto_code" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"accounts_payable_id" text DEFAULT '' NOT NULL,
	"canceled" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text DEFAULT '' NOT NULL,
	"installment_id" text DEFAULT '' NOT NULL,
	"payment_id" text DEFAULT '' NOT NULL,
	"attachment_type" text NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "supplier_invoice_attachments_r2_key_unique" UNIQUE("r2_key")
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_events" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"event_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"actor_id" text DEFAULT '' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_unique_doc_idx" ON "supplier_invoices" USING btree ("company_id","supplier_id","invoice_number","series");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_access_key_unique_idx" ON "supplier_invoices" USING btree ("access_key") WHERE "access_key" <> '';--> statement-breakpoint
CREATE INDEX "supplier_invoices_company_status_idx" ON "supplier_invoices" USING btree ("company_id","financial_status");--> statement-breakpoint
CREATE INDEX "supplier_invoices_notion_purchase_idx" ON "supplier_invoices" USING btree ("notion_purchase_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_installments_invoice_idx" ON "supplier_invoice_installments" USING btree ("invoice_id","installment_number");--> statement-breakpoint
CREATE INDEX "supplier_invoice_installments_payable_idx" ON "supplier_invoice_installments" USING btree ("accounts_payable_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_attachments_invoice_idx" ON "supplier_invoice_attachments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_attachments_installment_idx" ON "supplier_invoice_attachments" USING btree ("installment_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_attachments_payment_idx" ON "supplier_invoice_attachments" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_events_invoice_idx" ON "supplier_invoice_events" USING btree ("invoice_id","created_at");--> statement-breakpoint
ALTER TABLE "supplier_invoice_attachments" ADD CONSTRAINT "supplier_invoice_attachments_exactly_one_ref"
  CHECK (
    (("invoice_id" <> '')::int + ("installment_id" <> '')::int + ("payment_id" <> '')::int) = 1
  ) NOT VALID;
