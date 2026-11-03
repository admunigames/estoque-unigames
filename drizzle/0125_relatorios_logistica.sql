-- Estoque > Relatórios Logística (03/11/2026): a loja envia o relatório (PDF
-- anexado ou fotos escaneadas viram PDF) direto para o e-mail da logística.
-- O arquivo NÃO fica salvo: só o registro do envio. Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "logistics_reports" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "report_date" text NOT NULL,
  "file_name" text DEFAULT '' NOT NULL,
  "file_size" integer DEFAULT 0 NOT NULL,
  "email_to" text DEFAULT '' NOT NULL,
  "email_id" text DEFAULT '' NOT NULL,
  "sent_by" text DEFAULT '' NOT NULL,
  "sent_by_name" text DEFAULT '' NOT NULL,
  "sent_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "logistics_reports_company_idx" ON "logistics_reports" ("company_id", "report_date");
