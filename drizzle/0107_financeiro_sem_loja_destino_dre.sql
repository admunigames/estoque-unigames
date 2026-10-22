-- Contas a Pagar / Dívidas com Fornecedores / Notas Fiscais SEM loja (inclusive
-- PF) e DESTINO NA DRE escolhido por quem lança (NÃO INCLUIR / RATEAR /
-- INCLUIR EM). Só ADD COLUMN e CREATE TABLE/INDEX: nada é apagado.
--   accounts_payable.dre_target: '' = regra antiga (entra na DRE da própria
--   loja/categoria da conta); 'none' | 'include' | 'rateio' = destino
--   escolhido, com as fatias em finance_dre_allocations.
ALTER TABLE "accounts_payable" ADD COLUMN IF NOT EXISTS "dre_target" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts_payable" ADD COLUMN IF NOT EXISTS "dre_rateio_model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts_payable" ADD COLUMN IF NOT EXISTS "payer_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_open_debts" ADD COLUMN IF NOT EXISTS "payer_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN IF NOT EXISTS "payer_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_dre_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "payable_id" text NOT NULL,
  "store_id" text NOT NULL,
  "store_name" text DEFAULT '' NOT NULL,
  "item_id" text NOT NULL,
  "month" text NOT NULL,
  "percent_basis_points" integer DEFAULT 10000 NOT NULL,
  "amount_cents" integer DEFAULT 0 NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_dre_allocations_payable_idx" ON "finance_dre_allocations" ("payable_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_dre_allocations_slot_idx" ON "finance_dre_allocations" ("store_id","item_id","month");
