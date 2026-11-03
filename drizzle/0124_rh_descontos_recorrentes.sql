-- RH > Folha de Pagamento (03/11/2026): DESCONTO RECORRENTE por funcionário —
-- valor mensal de start_month até end_month ('' = sem fim, até ENCERRAR).
-- Somado ao desconto avulso da folha na leitura. Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "hr_recurring_deductions" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "amount_cents" integer DEFAULT 0 NOT NULL,
  "start_month" text NOT NULL,
  "end_month" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hr_recurring_deductions_employee_idx" ON "hr_recurring_deductions" ("employee_id");
