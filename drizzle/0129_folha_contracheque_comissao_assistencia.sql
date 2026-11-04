-- Folha 04/11/2026: CONTRACHEQUE digitado (só pagamento: VALOR TOTAL =
-- contracheque + premiação − descontos; custo total/DRE não usam).
ALTER TABLE "hr_payroll_entries" ADD COLUMN IF NOT EXISTS "payslip_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Comissão do OPERACIONAL: parte que é despesa da ASSISTÊNCIA na DRE
-- (comissão sobre o feito da assistência + premiação da assistência).
ALTER TABLE "hr_commissions" ADD COLUMN IF NOT EXISTS "assist_cents" integer DEFAULT 0 NOT NULL;
