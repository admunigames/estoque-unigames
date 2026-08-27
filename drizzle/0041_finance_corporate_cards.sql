CREATE TABLE "finance_card_invoice_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"card_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"entry_date" text DEFAULT '' NOT NULL,
	"merchant" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"installment_label" text DEFAULT '' NOT NULL,
	"installment_current" integer DEFAULT 1 NOT NULL,
	"installment_total" integer DEFAULT 1 NOT NULL,
	"category_item_id" text DEFAULT '' NOT NULL,
	"cost_center_id" text DEFAULT '' NOT NULL,
	"holder_name" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"expense_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_invoice_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"reference_month" text DEFAULT '' NOT NULL,
	"source_name" text DEFAULT '' NOT NULL,
	"source_format" text DEFAULT 'csv' NOT NULL,
	"file_hash" text DEFAULT '' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_corporate_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"bank" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"last4" text DEFAULT '' NOT NULL,
	"limit_cents" integer DEFAULT 0 NOT NULL,
	"best_purchase_day" integer DEFAULT 0 NOT NULL,
	"closing_day" integer DEFAULT 1 NOT NULL,
	"due_day" integer DEFAULT 10 NOT NULL,
	"holder_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "finance_card_invoice_entries_card_date_idx" ON "finance_card_invoice_entries" USING btree ("card_id","entry_date");--> statement-breakpoint
CREATE INDEX "finance_card_invoice_entries_import_idx" ON "finance_card_invoice_entries" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "finance_card_invoice_imports_card_idx" ON "finance_card_invoice_imports" USING btree ("card_id","reference_month");--> statement-breakpoint
CREATE INDEX "finance_card_invoice_imports_hash_idx" ON "finance_card_invoice_imports" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "finance_corporate_cards_company_idx" ON "finance_corporate_cards" USING btree ("company_id","status");