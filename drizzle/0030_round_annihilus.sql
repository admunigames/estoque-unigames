CREATE TABLE "expense_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"expense_id" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"file_name" text NOT NULL,
	"r2_key" text NOT NULL,
	"content_type" text DEFAULT '' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_by_name" text DEFAULT '' NOT NULL,
	"uploaded_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_rateio_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"expense_id" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"percent_basis_points" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"supplier_id" text DEFAULT '' NOT NULL,
	"finance_item_id" text NOT NULL,
	"finance_account_id" text DEFAULT '' NOT NULL,
	"cost_center" text DEFAULT '' NOT NULL,
	"original_amount_cents" integer NOT NULL,
	"issue_date" text DEFAULT '' NOT NULL,
	"competence_month" text NOT NULL,
	"due_date" text NOT NULL,
	"payment_method" text DEFAULT '' NOT NULL,
	"invoice_number" text DEFAULT '' NOT NULL,
	"order_reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"installment_total" integer DEFAULT 0 NOT NULL,
	"recurrence_frequency" text DEFAULT '' NOT NULL,
	"recurrence_occurrence_count" integer,
	"recurrence_end_date" text DEFAULT '' NOT NULL,
	"rateio_type" text DEFAULT 'single_store' NOT NULL,
	"rateio_model" text DEFAULT '' NOT NULL,
	"card_id" text DEFAULT '' NOT NULL,
	"bank_reconciliation_id" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_rateio_model_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"percent_basis_points" integer NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_store_headcount" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "finance_store_headcount_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
ALTER TABLE "accounts_payable" ADD COLUMN "expense_id" text;--> statement-breakpoint
ALTER TABLE "accounts_payable" ADD COLUMN "cost_center" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "expense_attachments_expense_idx" ON "expense_attachments" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_rateio_shares_expense_idx" ON "expense_rateio_shares" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_rateio_shares_company_idx" ON "expense_rateio_shares" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "expenses_company_competence_idx" ON "expenses" USING btree ("company_id","competence_month");--> statement-breakpoint
CREATE INDEX "expenses_supplier_idx" ON "expenses" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "expenses_finance_item_idx" ON "expenses" USING btree ("finance_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_idempotency_idx" ON "expenses" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_rateio_model_shares_model_company_idx" ON "finance_rateio_model_shares" USING btree ("model","company_id");--> statement-breakpoint
CREATE INDEX "accounts_payable_expense_idx" ON "accounts_payable" USING btree ("expense_id");