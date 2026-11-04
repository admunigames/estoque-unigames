-- Rateio AUTOMÁTICO na DRE (04/11/2026): conta a pagar RATEAR com modelo
-- automático (GRUPO/ASSISTÊNCIA/UNIGAMES/FUNCIONÁRIOS) guarda categoria e lojas
-- escolhidas ({"itemId","companyIds"}) para recalcular as fatias quando o
-- faturamento/funcionários do mês mudarem. '' = fatias congeladas (antigas).
ALTER TABLE "accounts_payable" ADD COLUMN IF NOT EXISTS "dre_rateio_scope" text DEFAULT '' NOT NULL;
