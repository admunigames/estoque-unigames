-- Conciliação Bancária (23/10/2026). Só CREATE TABLE/INDEX e ADD COLUMN.
--   finance_bank_activities: ATIVIDADES FINANCEIRAS cadastráveis, separadas
--   em ENTRADAS (ex.: ENTRADA DE VENDA, DEPÓSITO) e SAÍDAS.
--   finance_bank_statement_entries.activity_id: atividade do lançamento;
--   .payable_id: conta a pagar baixada por este lançamento (sugestão por
--   valor igual no Contas a Pagar).
--   finance_bank_period_balances: SALDO INICIAL do período (conta + mês),
--   usado na tela e no relatório da conciliação.
CREATE TABLE IF NOT EXISTS "finance_bank_activities" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "active" integer DEFAULT 1 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_bank_activities_kind_idx" ON "finance_bank_activities" ("kind","position");--> statement-breakpoint
ALTER TABLE "finance_bank_statement_entries" ADD COLUMN IF NOT EXISTS "activity_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_entries" ADD COLUMN IF NOT EXISTS "payable_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_bank_period_balances" (
  "id" text PRIMARY KEY NOT NULL,
  "finance_account_id" text NOT NULL,
  "month" text NOT NULL,
  "opening_cents" integer DEFAULT 0 NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_bank_period_balances_key_idx" ON "finance_bank_period_balances" ("finance_account_id","month");
