-- Inventário > RECONTAGEM DA LOJA: quantidade que a loja recontou nos
-- produtos marcados para recontagem, comparada à contagem inicial (ajuste
-- no sistema depois do primeiro ajuste). Só ADD COLUMN: nada é apagado.
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "store_recount_qty" integer;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "store_recount_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "store_recount_at" text DEFAULT '' NOT NULL;
