-- RECEBIMENTOS DO ARQUIVO DO BANCO (Fluxo de Caixa, 09/11/2026): cada parcela
-- do arquivo de recebimentos da adquirente (Stone, Cielo, Rede…). As parcelas
-- de uma mesma conta + loja + adquirente + data de pagamento somam UM
-- recebível (accounts_receivable.idempotency_key = group_key), que entra na
-- projeção e substitui a estimativa calculada pelas vendas.
CREATE TABLE IF NOT EXISTS "finance_card_receipt_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "line_key" text NOT NULL,
  "group_key" text NOT NULL,
  "finance_account_id" text NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "acquirer_id" text NOT NULL,
  "acquirer_name" text DEFAULT '' NOT NULL,
  "category" text DEFAULT '' NOT NULL,
  "sale_date" text DEFAULT '' NOT NULL,
  "due_date" text NOT NULL,
  "brand" text DEFAULT '' NOT NULL,
  "product" text DEFAULT '' NOT NULL,
  "installments" integer DEFAULT 1 NOT NULL,
  "installment_no" integer DEFAULT 1 NOT NULL,
  "gross_cents" integer DEFAULT 0 NOT NULL,
  "net_cents" integer DEFAULT 0 NOT NULL,
  "fee_cents" integer DEFAULT 0 NOT NULL,
  "status_text" text DEFAULT '' NOT NULL,
  "paid" integer DEFAULT 0 NOT NULL,
  "sale_ref" text DEFAULT '' NOT NULL,
  "establishment" text DEFAULT '' NOT NULL,
  "source_name" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_card_receipt_lines_key_idx" ON "finance_card_receipt_lines" ("line_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_card_receipt_lines_group_idx" ON "finance_card_receipt_lines" ("group_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_card_receipt_lines_account_due_idx" ON "finance_card_receipt_lines" ("finance_account_id", "due_date");
