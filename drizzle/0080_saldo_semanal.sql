-- Fluxo de Caixa > CAIXA SEMANAL (Financeiro 4/9): saldo de cada conta
-- informado toda SEGUNDA-FEIRA, com histórico semana a semana.
-- finance_account_balances continua sendo o saldo "atual" (fonte do Caixa
-- Atual); ao salvar a semana mais recente ele é atualizado junto.
CREATE TABLE IF NOT EXISTS "finance_account_weekly_balances" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"week_date" text NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_account_weekly_balances_account_week_idx" ON "finance_account_weekly_balances" USING btree ("account_id","week_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_account_weekly_balances_company_week_idx" ON "finance_account_weekly_balances" USING btree ("company_id","week_date");
