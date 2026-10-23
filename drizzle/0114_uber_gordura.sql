-- Conciliação Uber a partir da gordura (23/10/2026). Só ADD COLUMN / CREATE INDEX.
--   commercial_gd_balance_adjustments.uber_ride: gordura marcada CORRIDA UBER.
--   finance_uber_rides.gd_adjustment_id: corrida criada por essa gordura
--   (fica com card_id '' até casar com a cobrança da fatura de um cartão).
ALTER TABLE "commercial_gd_balance_adjustments" ADD COLUMN IF NOT EXISTS "uber_ride" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_uber_rides" ADD COLUMN IF NOT EXISTS "gd_adjustment_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_uber_rides_gd_idx" ON "finance_uber_rides" ("gd_adjustment_id");
