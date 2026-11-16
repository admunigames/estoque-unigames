-- Financeiro > Fornecedores a Pagar (16/11/2026): lançamento vira PEDIDO com
-- moeda (BRL/USD), vários pagamentos até o total, anexos no R2 e data de
-- programação livre (vazia = sem data). planned_date passa a ser a DATA DO
-- PEDIDO; payment_type_id fica guardado, só sai da tela. Fornecedor ganha o
-- prazo em dias após o pedido (NULL = sem prazo). Só acrescenta; nada é
-- apagado. Pagos de hoje viram 1 pagamento do total (mesma data/responsável);
-- em aberto copiam a data antiga para a programação. Idempotente.
ALTER TABLE "ap_simple_options" ADD COLUMN IF NOT EXISTS "payment_days" integer;--> statement-breakpoint
ALTER TABLE "ap_simple_entries" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'BRL' NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_simple_entries" ADD COLUMN IF NOT EXISTS "scheduled_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ap_simple_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "entry_id" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "paid_date" text NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "deleted_by_name" text DEFAULT '' NOT NULL,
  "deleted_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ap_simple_payments_entry_idx" ON "ap_simple_payments" ("entry_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ap_simple_attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "entry_id" text NOT NULL,
  "file_name" text NOT NULL,
  "r2_key" text NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "content_type" text DEFAULT '' NOT NULL,
  "uploaded_by_name" text DEFAULT '' NOT NULL,
  "uploaded_at" text DEFAULT now()::text NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "deleted_by_name" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ap_simple_attachments_entry_idx" ON "ap_simple_attachments" ("entry_id");--> statement-breakpoint
INSERT INTO "ap_simple_payments" ("id", "entry_id", "amount_cents", "paid_date", "created_by_name", "created_at")
  SELECT 'mig0140-' || "id", "id", "amount_cents", "paid_date", "paid_by_name", COALESCE(NULLIF("paid_at", ''), now()::text)
  FROM "ap_simple_entries" WHERE "status" = 'pago'
  ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "ap_simple_entries" SET "scheduled_date" = "planned_date" WHERE "status" = 'aberto' AND "scheduled_date" = '';
