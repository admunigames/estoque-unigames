-- Comercial: alimentação manual e ao vivo (sem importar planilha).
-- QUANTIDADE DE VENDAS por vendedor/mês; % da VENDA P.A / UNIGAMES nas
-- regras (2% a partir de 2026-10); tabelas de lançamento (PAYJOY, CREFAZ,
-- PARCELEX, ODRES, VENDA P.A, VENDA UNIGAMES) e Meta Loja.
-- Só ADD COLUMN, CREATE TABLE/INDEX e UPDATE da vigência 2026-10: nada é apagado.
ALTER TABLE "commercial_monthly" ADD COLUMN IF NOT EXISTS "sales_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_rules" ADD COLUMN IF NOT EXISTS "partner_sale_rate_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "commercial_rules" SET "partner_sale_rate_bps" = 200 WHERE "valid_from" = '2026-10' AND "partner_sale_rate_bps" = 0;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_credit_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"kind" text NOT NULL,
	"sale_ref" text DEFAULT '' NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_credit_entries_month_idx" ON "commercial_credit_entries" USING btree ("month","kind");--> statement-breakpoint
ALTER TABLE "commercial_credit_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_credit_entries" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_store_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"company_id" text NOT NULL,
	"target_cents" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_store_goals_month_company_idx" ON "commercial_store_goals" USING btree ("month","company_id");--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_store_goals" FROM anon, authenticated;
