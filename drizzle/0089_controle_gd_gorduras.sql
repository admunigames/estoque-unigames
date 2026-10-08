-- Comercial > Controle GD: gordura por venda (ID da venda + vendedor), edição
-- registrada e SALDO ANTERIOR corrigido à mão por loja/mês.
-- Só ADD COLUMN / CREATE TABLE: nada é apagado.
ALTER TABLE "commercial_gd_balance_adjustments" ADD COLUMN IF NOT EXISTS "sale_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_gd_balance_adjustments" ADD COLUMN IF NOT EXISTS "seller_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_gd_balance_adjustments" ADD COLUMN IF NOT EXISTS "updated_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_gd_balance_adjustments" ADD COLUMN IF NOT EXISTS "updated_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_gd_balance_adjustments" ADD COLUMN IF NOT EXISTS "updated_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_gd_opening_balances" (
  "id" text PRIMARY KEY NOT NULL,
  "store_id" text NOT NULL,
  "month" text NOT NULL,
  "balance_cents" integer NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_gd_opening_store_month_idx" ON "commercial_gd_opening_balances" ("store_id","month");
