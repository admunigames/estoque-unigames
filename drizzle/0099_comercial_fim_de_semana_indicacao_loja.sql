-- Comercial: INDICAÇÃO (quantidade e R$) por loja na Meta Loja, "atualizado
-- em" próprio da aba META ASSISTÊNCIA e a aba META DO FIM DE SEMANA (só
-- controle: não alimenta vendedores, comissão nem RH). Só ADD COLUMN /
-- CREATE TABLE/INDEX (e RLS na tabela nova).
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "indication_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "indication_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "assist_updated_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "assist_updated_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_weekend_goals" (
  "id" text PRIMARY KEY NOT NULL,
  "weekend" text NOT NULL,
  "month" text NOT NULL,
  "company_id" text NOT NULL,
  "target_cents" integer DEFAULT 0 NOT NULL,
  "revenue_cents" integer DEFAULT 0 NOT NULL,
  "target_items" integer DEFAULT 0 NOT NULL,
  "items" integer DEFAULT 0 NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_weekend_goals_weekend_company_idx" ON "commercial_weekend_goals" ("weekend","company_id");--> statement-breakpoint
ALTER TABLE "commercial_weekend_goals" ENABLE ROW LEVEL SECURITY;
