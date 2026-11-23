-- Financeiro > Controle de Reposição (23/11/2026): categoria própria e
-- categoria financeira no lançamento (alteráveis depois de lançado), e a
-- tabela de saldos por conta de responsável: SALDO INICIAL ('initial', vale
-- a partir do mês) e FECHAMENTO do mês ('closing', gravado no FINALIZAR MÊS;
-- vira o SALDO MÊS ANTERIOR do mês seguinte). Só ADD COLUMN com default e
-- CREATE TABLE/INDEX. Idempotente.
ALTER TABLE "finance_replacement_entries" ADD COLUMN IF NOT EXISTS "category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_replacement_entries" ADD COLUMN IF NOT EXISTS "finance_item_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_replacement_balances" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "month" text NOT NULL,
  "responsible_name" text DEFAULT '' NOT NULL,
  "amount_cents" integer DEFAULT 0 NOT NULL,
  "opening_cents" integer DEFAULT 0 NOT NULL,
  "inflow_cents" integer DEFAULT 0 NOT NULL,
  "outflow_cents" integer DEFAULT 0 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_replacement_balances_key_idx" ON "finance_replacement_balances" ("kind", "month", "responsible_name");--> statement-breakpoint
ALTER TABLE "finance_replacement_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "finance_replacement_balances" FROM anon, authenticated;
