-- Maquinetas (Financeiro 5/9): taxa cadastrada POR MAQUINETA e conferência
-- da taxa real cobrada vinda do próprio arquivo de vendas.
-- finance_card_fees.machine_id '' = taxa da adquirente (como antes).
-- finance_card_sales: maquineta identificada no arquivo (machine_id +
-- identificador cru terminal_ref), taxa cobrada (charged_fee_cents, NULL =
-- arquivo sem taxa/líquido) e resultado da conferência (fee_check '' | 'ok' |
-- 'divergent'). Só ADD COLUMN/INDEX: nada é apagado.
ALTER TABLE "finance_card_fees" ADD COLUMN IF NOT EXISTS "machine_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_card_fees_machine_idx" ON "finance_card_fees" USING btree ("machine_id");--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN IF NOT EXISTS "machine_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN IF NOT EXISTS "terminal_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN IF NOT EXISTS "charged_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN IF NOT EXISTS "fee_check" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_card_sales_machine_date_idx" ON "finance_card_sales" USING btree ("machine_id","sale_date");
