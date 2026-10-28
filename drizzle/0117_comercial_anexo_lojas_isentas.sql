-- Comercial > Regras de Comissão: lojas em que o critério de ANEXO MÍNIMO DE
-- GARANTIA não vale (ex.: QUIOSQUE P.A), por vigência. Lista JSON de ids de
-- loja. Só ADD COLUMN: nada é apagado.
ALTER TABLE "commercial_rules" ADD COLUMN IF NOT EXISTS "attach_exempt_json" text DEFAULT '[]' NOT NULL;
