-- Crediários (Financeiro 7/9): vendas financiadas por FINANCEIRA PARCEIRA,
-- que aprova a proposta e deposita de uma vez o valor sem taxa. O depósito
-- do extrato vinculado vira status 'credit_sale' (coluna já existente, sem
-- alteração aqui).
-- Só CREATE TABLE/INDEX: nada é apagado nem alterado.
CREATE TABLE IF NOT EXISTS "finance_credit_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"default_fee_bps" integer DEFAULT 0 NOT NULL,
	"bank_keyword" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_credit_sales" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"provider_id" text NOT NULL,
	"provider_name" text DEFAULT '' NOT NULL,
	"sale_date" text DEFAULT '' NOT NULL,
	"sale_ref" text DEFAULT '' NOT NULL,
	"proposal" text DEFAULT '' NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"fee_bps" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"expected_date" text DEFAULT '' NOT NULL,
	"bank_entry_id" text DEFAULT '' NOT NULL,
	"received_date" text DEFAULT '' NOT NULL,
	"received_cents" integer DEFAULT 0 NOT NULL,
	"canceled" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_credit_sales_company_date_idx" ON "finance_credit_sales" USING btree ("company_id","sale_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_credit_sales_provider_idx" ON "finance_credit_sales" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_credit_sales_bank_entry_idx" ON "finance_credit_sales" USING btree ("bank_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_credit_sales_proposal_idx" ON "finance_credit_sales" USING btree ("provider_id","proposal") WHERE "proposal" <> '';
