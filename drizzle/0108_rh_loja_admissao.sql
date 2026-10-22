-- RH > Funcionários: LOJA DE ADMISSÃO (onde está registrado). A LOJA ATUANTE
-- de cada mês fica em hr_schedule_assignments (MÊS → LOJA, fonte única com as
-- Escalas) — ver app/lib/acting-store.ts. Só ADD COLUMN; a loja de admissão
-- começa igual à loja atual do cadastro (nada é apagado).
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "admission_company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "admission_company_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "hr_employees" SET "admission_company_id" = "company_id", "admission_company_name" = "company_name"
WHERE "admission_company_id" = '' AND "company_id" <> '';
