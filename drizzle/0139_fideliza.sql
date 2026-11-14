-- Comercial > FIDELIZA (14/11/2026): CRM de recompra dentro do Estoque.
-- Vendas de clientes identificados vindas do Relatório de PDV (importado pelo
-- ADM), contatos/agendamentos feitos pela loja e o registro das importações.
-- Configuração (mensagem, histórico, inatividade) em shared_state
-- 'fideliza_settings'. Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "fideliza_sales" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "sale_no" text NOT NULL,
  "sale_date" text NOT NULL,
  "customer_key" text NOT NULL,
  "customer_name" text DEFAULT '' NOT NULL,
  "seller" text DEFAULT '' NOT NULL,
  "payment" text DEFAULT '' NOT NULL,
  "total_cents" integer DEFAULT 0 NOT NULL,
  "items_json" text DEFAULT '[]' NOT NULL,
  "import_id" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fideliza_sales_customer_idx" ON "fideliza_sales" ("company_id", "customer_key", "sale_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fideliza_sales_date_idx" ON "fideliza_sales" ("company_id", "sale_date");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fideliza_contacts" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "customer_key" text NOT NULL,
  "customer_name" text DEFAULT '' NOT NULL,
  "result" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "scheduled_for" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fideliza_contacts_customer_idx" ON "fideliza_contacts" ("company_id", "customer_key", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fideliza_imports" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "file_name" text DEFAULT '' NOT NULL,
  "period_start" text DEFAULT '' NOT NULL,
  "period_end" text DEFAULT '' NOT NULL,
  "sales_total" integer DEFAULT 0 NOT NULL,
  "sales_kept" integer DEFAULT 0 NOT NULL,
  "sales_new" integer DEFAULT 0 NOT NULL,
  "sales_purged" integer DEFAULT 0 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL
);
