-- Módulo "Orçamento" (Financeiro Fase 4) — ver
-- [[estoque_modulo_financeiro_fase4_orcamento]]. Valor orçado por
-- loja+categoria(ou subcategoria)+centro de custo+competência, comparado com
-- o Realizado calculado em app/api/finance/budgets/shared.ts (reaproveita a
-- mesma agregação da DRE via finance_store_entries quando sem centro de
-- custo, ou soma direta de accounts_payable quando com centro de custo, já
-- que finance_store_entries não guarda essa dimensão). company_id e
-- cost_center_id vazios ('') representam "todas as lojas"/"todos os centros
-- de custo" — decisão confirmada com o usuário (opcionais).
CREATE TABLE "finance_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"category_id" text NOT NULL,
	"cost_center_id" text DEFAULT '' NOT NULL,
	"month" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_budgets_scope_idx" ON "finance_budgets" USING btree ("company_id","category_id","cost_center_id","month");
--> statement-breakpoint
CREATE INDEX "finance_budgets_month_idx" ON "finance_budgets" USING btree ("month");
--> statement-breakpoint
CREATE INDEX "finance_budgets_category_idx" ON "finance_budgets" USING btree ("category_id");
--> statement-breakpoint
ALTER TABLE "finance_budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "finance_budgets" FROM anon, authenticated;
