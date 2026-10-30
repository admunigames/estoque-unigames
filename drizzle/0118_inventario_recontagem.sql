-- Inventário > DIVERGENTES: produto marcado para o PDF RECONTAGEM DE LOJA
-- (quem gerencia escolhe). Só ADD COLUMN: nada é apagado; nada vem marcado.
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "recount" integer DEFAULT 0 NOT NULL;
