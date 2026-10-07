-- Comercial > Meta Loja: META REALME e REALMES FEITO da loja, lançados à mão
-- (o gráfico REALMES TOTAIS POR LOJA do Ranking passa a usar estes números).
-- Só ADD COLUMN: nada é apagado.
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "target_realme" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "realme" integer DEFAULT 0 NOT NULL;
