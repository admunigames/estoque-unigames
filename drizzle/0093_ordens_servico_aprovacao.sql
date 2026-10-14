-- Ordens de Serviço: APROVADA (antes FINALIZADA), SEGUE PARA A LOJA e teste
-- da loja (aprovada / reprovada em loja). Só ADD COLUMN + troca do nome do
-- status: nada é apagado.
ALTER TABLE "assist_service_orders" ADD COLUMN IF NOT EXISTS "ship_to_store" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_service_orders" ADD COLUMN IF NOT EXISTS "ship_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_service_orders" ADD COLUMN IF NOT EXISTS "ship_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_service_orders" ADD COLUMN IF NOT EXISTS "store_check" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_service_orders" ADD COLUMN IF NOT EXISTS "store_check_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_service_orders" ADD COLUMN IF NOT EXISTS "store_check_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_service_orders" ADD COLUMN IF NOT EXISTS "store_check_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "assist_service_orders" SET "status"='APROVADA', "ship_to_store"='nao' WHERE "status"='FINALIZADA';
