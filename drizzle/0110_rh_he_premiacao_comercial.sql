-- RH (22/10/2026): relatório COMISSIONAMENTO / HORAS / PREMIAÇÃO para a
-- contabilidade. Só ADD COLUMN — nada é apagado.
--   hr_commissions.commercial_premium_cents: PREMIAÇÃO vinda do Comercial,
--   separada da comissão (commission_cents passa a ser só a comissão do
--   Comercial). O total do recibo não muda: comissão + premiação do
--   Comercial + itens do RH. Os meses desde COMMISSION_SYNC_FROM são
--   regravados pelo syncHrCommissions (relatório, regras ou lançamento).
--   hr_time_tracking_payouts: HORAS EXTRAS A PAGAR em três tipos — HE 50%,
--   HE 100% e ADICIONAL NOTURNO — com minutos e valor da hora (salário ÷ 220
--   × fator, editável). paid_minutes continua abatendo o banco de horas.
ALTER TABLE "hr_commissions" ADD COLUMN IF NOT EXISTS "commercial_premium_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_payouts" ADD COLUMN IF NOT EXISTS "he50_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_payouts" ADD COLUMN IF NOT EXISTS "he100_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_payouts" ADD COLUMN IF NOT EXISTS "night_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_payouts" ADD COLUMN IF NOT EXISTS "he50_rate_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_payouts" ADD COLUMN IF NOT EXISTS "he100_rate_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_payouts" ADD COLUMN IF NOT EXISTS "night_rate_cents" integer DEFAULT 0 NOT NULL;
