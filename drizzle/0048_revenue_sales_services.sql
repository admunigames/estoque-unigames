ALTER TABLE "finance_store_revenue" ADD COLUMN "sales_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_store_revenue" ADD COLUMN "services_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Receita já lançada era valor único: trata todo o valor atual como Vendas
-- (o usuário pode reclassificar depois). Serviços fica em 0.
UPDATE "finance_store_revenue" SET "sales_amount_cents" = "amount_cents" WHERE "sales_amount_cents" = 0 AND "amount_cents" <> 0;