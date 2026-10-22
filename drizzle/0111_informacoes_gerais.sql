-- INFORMAÇÕES GERAIS (Cadastros, pedido do Douglas — 22/10/2026): itens por
-- loja para compartilhar contatos e dados úteis. kind:
--   'internet'  → provedor (title), plano (service), contrato/ID (contract),
--                 telefone de suporte (phone), observação (notes);
--   'prestador' → nome (title), serviço (service), telefone/WhatsApp (phone),
--                 observação (notes);
--   'outros'    → texto livre (notes).
-- Sem campo de senha (Wi-Fi/roteador) por decisão do usuário. Só CREATE.
CREATE TABLE IF NOT EXISTS "info_gerais_items" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "kind" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "service" text DEFAULT '' NOT NULL,
  "contract" text DEFAULT '' NOT NULL,
  "phone" text DEFAULT '' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "info_gerais_items_company_idx" ON "info_gerais_items" ("company_id","kind","position");
