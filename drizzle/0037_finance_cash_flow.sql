CREATE TABLE "accounts_receivable" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"operator_text" text DEFAULT '' NOT NULL,
	"competence_month" text NOT NULL,
	"expected_date" text NOT NULL,
	"expected_amount_cents" integer NOT NULL,
	"received_amount_cents" integer,
	"received_date" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"canceled" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	"canceled_by" text DEFAULT '' NOT NULL,
	"canceled_by_name" text DEFAULT '' NOT NULL,
	"canceled_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_account_balances" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"as_of_date" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_cash_flow_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"receivables_tolerance_bps" integer DEFAULT 200 NOT NULL,
	"receivables_tolerance_fixed_cents" integer DEFAULT 2000 NOT NULL,
	"payroll_default_payment_day" integer DEFAULT 5 NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "accounts_receivable_company_competence_idx" ON "accounts_receivable" USING btree ("company_id","competence_month");--> statement-breakpoint
CREATE INDEX "accounts_receivable_company_expected_idx" ON "accounts_receivable" USING btree ("company_id","expected_date");--> statement-breakpoint
CREATE INDEX "accounts_receivable_operator_idx" ON "accounts_receivable" USING btree ("operator_text");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_receivable_idempotency_idx" ON "accounts_receivable" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_account_balances_account_idx" ON "finance_account_balances" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "finance_account_balances_company_idx" ON "finance_account_balances" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_cash_flow_settings_company_idx" ON "finance_cash_flow_settings" USING btree ("company_id");