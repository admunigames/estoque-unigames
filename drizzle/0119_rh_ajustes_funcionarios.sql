-- RH > Funcionários (31/10/2026): benefício com VALOR TOTAL MENSAL no cadastro
-- (0 = segue a aba REGRAS), formato de recebimento do benefício, FACEPONTO
-- mensal (DRE Funcionário) e acompanhamento de FÉRIAS. Só ADD COLUMN /
-- CREATE TABLE: nada é apagado.
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "benefit_food_total_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "benefit_transport_total_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "benefit_payment_method" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "faceponto_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_vacations" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL,
  "employee_name" text DEFAULT '' NOT NULL,
  "acquisition_start" text DEFAULT '' NOT NULL,
  "start_date" text NOT NULL,
  "end_date" text NOT NULL,
  "net_cents" integer DEFAULT 0 NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hr_vacations_employee_idx" ON "hr_vacations" ("employee_id");
