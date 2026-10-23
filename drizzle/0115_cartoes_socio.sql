-- CARTÕES DE CRÉDITO SÓCIO (23/10/2026). Só CREATE TABLE/INDEX.
--   finance_partner_card_entries: compras feitas no cartão pessoal de um
--   sócio que a empresa devolve — parcelado (installments) ou FIXO (todo
--   mês, de first_month até end_month), com desconto.
--   finance_partner_card_payments: pagamento do mês por responsável; o total
--   vira uma conta em Contas a Pagar (payable_id).
CREATE TABLE IF NOT EXISTS "finance_partner_card_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "responsible_name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "purchase_date" text DEFAULT '' NOT NULL,
  "amount_cents" integer DEFAULT 0 NOT NULL,
  "discount_cents" integer DEFAULT 0 NOT NULL,
  "installments" integer DEFAULT 1 NOT NULL,
  "fixed" integer DEFAULT 0 NOT NULL,
  "first_month" text NOT NULL,
  "end_month" text DEFAULT '' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_partner_card_entries_resp_idx" ON "finance_partner_card_entries" ("responsible_name","first_month");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_partner_card_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "responsible_name" text NOT NULL,
  "month" text NOT NULL,
  "payment_date" text NOT NULL,
  "payable_id" text DEFAULT '' NOT NULL,
  "total_cents" integer DEFAULT 0 NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_partner_card_payments_key_idx" ON "finance_partner_card_payments" ("responsible_name","month");
