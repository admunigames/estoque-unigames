-- Ajustes do Financeiro (09/10/2026). Só ADD COLUMN / CREATE: nada é apagado.
-- Declaração de Vendas: A DECLARAR planejado por mês (PLANEJAR O ANO).
ALTER TABLE "finance_mall_declarations" ADD COLUMN IF NOT EXISTS "planned_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Recargas: despesa do mês lançada ao registrar a recarga.
ALTER TABLE "finance_phone_recharge_events" ADD COLUMN IF NOT EXISTS "expense_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Maquinetas: senha administrativa da maquineta.
ALTER TABLE "finance_card_machines" ADD COLUMN IF NOT EXISTS "admin_password" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Controle de Reposição: saída do extrato bancário batida com o lançamento.
ALTER TABLE "finance_replacement_entries" ADD COLUMN IF NOT EXISTS "bank_entry_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Conciliação Uber: corridas anotadas × cobranças UBER da fatura do cartão.
CREATE TABLE IF NOT EXISTS "finance_uber_rides" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"ride_date" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"passenger" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"source_name" text DEFAULT '' NOT NULL,
	"card_entry_id" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_uber_rides_card_date_idx" ON "finance_uber_rides" USING btree ("card_id","ride_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_uber_rides_entry_idx" ON "finance_uber_rides" USING btree ("card_entry_id");
