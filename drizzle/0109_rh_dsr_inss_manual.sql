-- RH: valores MANUAIS por funcionário e competência (decisão do usuário,
-- 22/10/2026 — nada automático por enquanto):
--   kind 'dsr'  → DSR em R$ (Folha e relatório CUSTO TOTAL POR FUNCIONÁRIO);
--   kind 'inss' → INSS em R$ (DRE Funcionário, por colaborador).
-- Uma linha por funcionário + mês + tipo. Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "hr_employee_month_values" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL,
  "employee_name" text DEFAULT '' NOT NULL,
  "month" text NOT NULL,
  "kind" text NOT NULL,
  "amount_cents" integer DEFAULT 0 NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hr_employee_month_values_key_idx" ON "hr_employee_month_values" ("employee_id","month","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hr_employee_month_values_month_idx" ON "hr_employee_month_values" ("month","kind");
