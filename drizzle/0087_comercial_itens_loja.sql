-- Comercial > Meta Loja: META ITENS e ITENS FEITO da loja, lançados à mão
-- (o gráfico ITENS TOTAIS POR LOJA do Ranking passa a usar estes números).
-- Só ADD COLUMN: nada é apagado.
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "target_items" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "items" integer DEFAULT 0 NOT NULL;
