CREATE TABLE "finance_card_purchase_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"purchase_date" text DEFAULT '' NOT NULL,
	"merchant" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"installment_label" text DEFAULT '' NOT NULL,
	"installment_current" integer DEFAULT 1 NOT NULL,
	"installment_total" integer DEFAULT 1 NOT NULL,
	"holder_name" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invoice_entry_id" text DEFAULT '' NOT NULL,
	"decision_note" text DEFAULT '' NOT NULL,
	"requested_by" text DEFAULT '' NOT NULL,
	"requested_by_name" text DEFAULT '' NOT NULL,
	"requested_at" text DEFAULT now()::text NOT NULL,
	"decided_by" text DEFAULT '' NOT NULL,
	"decided_by_name" text DEFAULT '' NOT NULL,
	"decided_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_card_invoice_entries" ADD COLUMN "purchase_request_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_corporate_cards" ADD COLUMN "kind" text DEFAULT 'corporate' NOT NULL;--> statement-breakpoint
CREATE INDEX "finance_card_purchase_requests_status_idx" ON "finance_card_purchase_requests" USING btree ("status","company_id");--> statement-breakpoint
CREATE INDEX "finance_card_purchase_requests_card_idx" ON "finance_card_purchase_requests" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "finance_card_purchase_requests_requester_idx" ON "finance_card_purchase_requests" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "finance_card_invoice_entries_request_idx" ON "finance_card_invoice_entries" USING btree ("purchase_request_id");