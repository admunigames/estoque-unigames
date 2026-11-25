-- Estoque > Recebimento (25/11/2026): a loja envia a nota e confere a compra
-- que chegou, SEM alterar o módulo Compras. Uma linha por pedido
-- (purchase_orders.id). No Compras, a página só grava received_quantity,
-- received_date e o anexo 'nota_fiscal'; o resto fica aqui:
--   delivery_company_*: loja de chegada (vazio = LOJA QUE FATURA do pedido);
--   items_json:   [{itemId, counted, excess, divergence, note}] (excess = além do pedido);
--   extras_json:  [{productName, quantity, note}] (produtos fora do pedido);
--   history_json: [{at, type, byId, byName, ...}] (correções com motivo,
--                 troca de loja, e-mails enviados/falhos);
--   version: trava otimista (UPDATE ... WHERE version=?).
-- Só CREATE TABLE/INDEX.
CREATE TABLE IF NOT EXISTS "purchase_receipts" (
  "order_id" text PRIMARY KEY NOT NULL,
  "delivery_company_id" text DEFAULT '' NOT NULL,
  "delivery_company_name" text DEFAULT '' NOT NULL,
  "nf_number" text DEFAULT '' NOT NULL,
  "nf_attachment_id" text DEFAULT '' NOT NULL,
  "nf_sent_by" text DEFAULT '' NOT NULL,
  "nf_sent_by_name" text DEFAULT '' NOT NULL,
  "nf_sent_at" text DEFAULT '' NOT NULL,
  "checked_by" text DEFAULT '' NOT NULL,
  "checked_by_name" text DEFAULT '' NOT NULL,
  "checked_at" text DEFAULT '' NOT NULL,
  "items_json" text DEFAULT '[]' NOT NULL,
  "extras_json" text DEFAULT '[]' NOT NULL,
  "history_json" text DEFAULT '[]' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_receipts_delivery_company_idx" ON "purchase_receipts" ("delivery_company_id");
