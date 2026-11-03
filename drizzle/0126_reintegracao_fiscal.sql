-- Estoque > Reintegração Fiscal (03/11/2026): cancelamentos anotados na
-- semana (ID da venda e/ou nº da nota, loja, data e quem solicitou) e
-- fechados um a um com a data e o nº da nota de reintegração emitida.
-- Informação interna: login com loja não vê. Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "fiscal_reintegrations" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "sale_id" text DEFAULT '' NOT NULL,
  "invoice_number" text DEFAULT '' NOT NULL,
  "requested_date" text NOT NULL,
  "requested_by" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'aberto' NOT NULL,
  "reintegration_date" text DEFAULT '' NOT NULL,
  "reintegration_number" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "closed_by" text DEFAULT '' NOT NULL,
  "closed_by_name" text DEFAULT '' NOT NULL,
  "closed_at" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fiscal_reintegrations_status_idx" ON "fiscal_reintegrations" ("status", "requested_date");
