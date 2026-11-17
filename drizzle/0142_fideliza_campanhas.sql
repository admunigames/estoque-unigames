-- Comercial > FIDELIZA (17/11/2026): campanhas = lista filtrada de clientes
-- (segmento + loja ou todas) com mensagem própria do WhatsApp e período. O
-- contato registrado a partir da campanha guarda campaign_id para contar
-- contatados/reativados dela. Só CREATE TABLE/INDEX e ADD COLUMN com default.
CREATE TABLE IF NOT EXISTS "fideliza_campaigns" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "message" text DEFAULT '' NOT NULL,
  "segment" text DEFAULT '' NOT NULL,
  "company_id" text DEFAULT '' NOT NULL,
  "starts_on" text DEFAULT '' NOT NULL,
  "ends_on" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "fideliza_contacts" ADD COLUMN IF NOT EXISTS "campaign_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fideliza_contacts_campaign_idx" ON "fideliza_contacts" ("campaign_id");
