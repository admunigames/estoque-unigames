-- Comercial: LÍDER COMERCIAL e OPERACIONAL (regras por vigência e tipo do
-- colaborador no mês), META/FEITO DA ASSISTÊNCIA na Meta Loja e a aba
-- INDICAÇÃO (só controle). Só ADD COLUMN / CREATE TABLE/INDEX (e RLS ligado
-- nas tabelas novas, como nas outras do Comercial): nada é apagado.
ALTER TABLE "commercial_rules" ADD COLUMN IF NOT EXISTS "roles_json" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "assist_target_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_store_goals" ADD COLUMN IF NOT EXISTS "assist_revenue_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_roles" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL,
  "month" text NOT NULL,
  "role" text NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_roles_employee_month_idx" ON "commercial_roles" ("employee_id","month");--> statement-breakpoint
ALTER TABLE "commercial_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_indications" (
  "id" text PRIMARY KEY NOT NULL,
  "month" text NOT NULL,
  "date" text NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "employee_id" text DEFAULT '' NOT NULL,
  "referrer_name" text DEFAULT '' NOT NULL,
  "customer" text DEFAULT '' NOT NULL,
  "reference" text DEFAULT '' NOT NULL,
  "amount_cents" integer DEFAULT 0 NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL,
  "deleted_at" text DEFAULT '' NOT NULL,
  "deleted_by_name" text DEFAULT '' NOT NULL,
  "history_json" text DEFAULT '[]' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_indications_month_idx" ON "commercial_indications" ("month","company_id");--> statement-breakpoint
ALTER TABLE "commercial_indications" ENABLE ROW LEVEL SECURITY;
