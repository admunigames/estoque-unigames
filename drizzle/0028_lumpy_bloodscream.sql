CREATE TABLE "accounts_payable" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"supplier_id" text DEFAULT '' NOT NULL,
	"finance_item_id" text NOT NULL,
	"finance_account_id" text DEFAULT '' NOT NULL,
	"original_amount_cents" integer NOT NULL,
	"paid_amount_cents" integer DEFAULT 0 NOT NULL,
	"issue_date" text DEFAULT '' NOT NULL,
	"competence_month" text NOT NULL,
	"due_date" text NOT NULL,
	"payment_method" text DEFAULT '' NOT NULL,
	"invoice_number" text DEFAULT '' NOT NULL,
	"order_reference" text DEFAULT '' NOT NULL,
	"billing_code" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"recurrence_id" text,
	"recurrence_frequency" text DEFAULT '' NOT NULL,
	"recurrence_occurrence_index" integer DEFAULT 0 NOT NULL,
	"recurrence_occurrence_count" integer,
	"recurrence_end_date" text DEFAULT '' NOT NULL,
	"installment_group_id" text,
	"installment_number" integer DEFAULT 0 NOT NULL,
	"installment_total" integer DEFAULT 0 NOT NULL,
	"finance_entry_id" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	"canceled_by" text DEFAULT '' NOT NULL,
	"canceled_by_name" text DEFAULT '' NOT NULL,
	"canceled_at" text DEFAULT '' NOT NULL,
	CONSTRAINT "accounts_payable_status_check" CHECK ("status" IN ('open', 'scheduled', 'partially_paid', 'paid', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "accounts_payable_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"payable_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"payment_date" text NOT NULL,
	"payment_method" text DEFAULT '' NOT NULL,
	"finance_account_id" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"scheduled" integer DEFAULT 0 NOT NULL,
	"confirmed_at" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"document" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_store_entries" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_store_entries" ADD CONSTRAINT "finance_store_entries_source_check" CHECK ("source" IN ('manual', 'payable'));--> statement-breakpoint
CREATE INDEX "accounts_payable_company_status_due_idx" ON "accounts_payable" USING btree ("company_id","status","due_date");--> statement-breakpoint
CREATE INDEX "accounts_payable_company_competence_idx" ON "accounts_payable" USING btree ("company_id","competence_month");--> statement-breakpoint
CREATE INDEX "accounts_payable_supplier_idx" ON "accounts_payable" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "accounts_payable_recurrence_idx" ON "accounts_payable" USING btree ("recurrence_id");--> statement-breakpoint
CREATE INDEX "accounts_payable_installment_group_idx" ON "accounts_payable" USING btree ("installment_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_payable_idempotency_idx" ON "accounts_payable" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "accounts_payable_payments_payable_idx" ON "accounts_payable_payments" USING btree ("payable_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_payable_payments_idempotency_idx" ON "accounts_payable_payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "finance_accounts_active_name_idx" ON "finance_accounts" USING btree ("active","name");--> statement-breakpoint
CREATE INDEX "finance_suppliers_active_name_idx" ON "finance_suppliers" USING btree ("active","name");--> statement-breakpoint
ALTER TABLE "accounts_payable" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "accounts_payable" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "accounts_payable_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "accounts_payable_payments" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "finance_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "finance_accounts" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "finance_suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "finance_suppliers" FROM anon, authenticated;