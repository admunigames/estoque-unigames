-- RH > Relatório Contabilidade (31/10/2026): OBSERVAÇÕES em texto livre por
-- EMPRESA (CNPJ; '' = grupo SEM CNPJ) e competência. Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "hr_accounting_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "cnpj" text DEFAULT '' NOT NULL,
  "month" text NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hr_accounting_notes_key_idx" ON "hr_accounting_notes" ("cnpj","month");
