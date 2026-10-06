-- Recargas de Celulares (Financeiro 8/9): período de recarga por linha
-- (30 / 60 / 90 dias). Linhas existentes ficam com 90 e mantêm a próxima
-- recarga já gravada (recalculada só na próxima recarga/edição).
-- Só ADD COLUMN: nada é apagado.
ALTER TABLE "finance_phone_recharges" ADD COLUMN IF NOT EXISTS "period_days" integer DEFAULT 90 NOT NULL;
