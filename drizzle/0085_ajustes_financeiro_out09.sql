-- Ajustes do Financeiro (09/10/2026). Só ADD COLUMN / CREATE: nada é apagado.
-- Declaração de Vendas: A DECLARAR planejado por mês (PLANEJAR O ANO).
ALTER TABLE "finance_mall_declarations" ADD COLUMN IF NOT EXISTS "planned_cents" integer DEFAULT 0 NOT NULL;
