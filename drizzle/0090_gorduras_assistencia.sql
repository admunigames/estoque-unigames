-- Controle Gorduras Assistência: clone do Controle de Gorduras do Comercial nas
-- mesmas tabelas, separado pela coluna module. Linhas existentes = 'comercial'.
-- Nada é apagado; o índice único do saldo anterior passa a incluir o módulo.
ALTER TABLE "commercial_gd_balance_adjustments" ADD COLUMN IF NOT EXISTS "module" text DEFAULT 'comercial' NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_gd_opening_balances" ADD COLUMN IF NOT EXISTS "module" text DEFAULT 'comercial' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_gd_opening_module_store_month_idx" ON "commercial_gd_opening_balances" ("module","store_id","month");--> statement-breakpoint
DROP INDEX IF EXISTS "commercial_gd_opening_store_month_idx";
