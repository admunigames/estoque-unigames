-- Assistência > RMA > CRÉDITOS (23/11/2026): o crédito do fornecedor é
-- gerado por empresa/loja. Um RMA pode ter créditos em várias lojas
-- (uma linha por loja). Créditos antigos ficam sem loja (''). Só ADD COLUMN
-- com default. Idempotente.
ALTER TABLE "rma_credits" ADD COLUMN IF NOT EXISTS "company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "rma_credits" ADD COLUMN IF NOT EXISTS "company_name" text DEFAULT '' NOT NULL;
