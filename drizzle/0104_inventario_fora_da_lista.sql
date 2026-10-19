-- Inventário: produto FORA DA LISTA (adicionado na contagem, custo à mão).
-- Só ADD COLUMN: nada é apagado; itens existentes ficam como 'relatorio'.
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'relatorio' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "added_by_name" text DEFAULT '' NOT NULL;
