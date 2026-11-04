-- RH > Funcionários > FÉRIAS (04/11/2026): DATA DO PAGAMENTO das férias. A
-- DRE Funcionário mostra as férias no mês do PAGAMENTO (sem data, no mês do
-- início, como antes). Só ADD COLUMN: nada é apagado.
ALTER TABLE "hr_vacations" ADD COLUMN IF NOT EXISTS "payment_date" text DEFAULT '' NOT NULL;
