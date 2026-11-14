-- Financeiro > Fornecedores a Pagar (14/11/2026): controle simples de
-- pedidos/pagamentos a fornecedores (um pagamento por lançamento, sem
-- duplicatas). Cadastros próprios do módulo (fornecedor e tipo de pagamento,
-- só o nome) — não aparecem em outro módulo. Interno: login com loja não vê.
-- Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "ap_simple_options" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ap_simple_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "supplier_id" text NOT NULL,
  "payment_type_id" text DEFAULT '' NOT NULL,
  "amount_cents" integer NOT NULL,
  "planned_date" text NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'aberto' NOT NULL,
  "paid_date" text DEFAULT '' NOT NULL,
  "paid_by_name" text DEFAULT '' NOT NULL,
  "paid_at" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ap_simple_entries_planned_idx" ON "ap_simple_entries" ("status", "planned_date");
