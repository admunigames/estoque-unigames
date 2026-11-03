-- Crediários: LOGIN de loja usado na venda (pode ser de outra unidade — a
-- unidade X vende no login Y). Crediários antigos ficam com login vazio.
-- Só ADD COLUMN: nada é apagado.
ALTER TABLE "finance_credit_sales" ADD COLUMN IF NOT EXISTS "login_company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_credit_sales" ADD COLUMN IF NOT EXISTS "login_company_name" text DEFAULT '' NOT NULL;
