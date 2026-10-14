-- Assistência > Consulta de Preços: tabela de valores de conserto por
-- serviço/marca/modelo. Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "assist_repair_prices" (
  "id" text PRIMARY KEY NOT NULL,
  "service" text NOT NULL,
  "brand" text DEFAULT '' NOT NULL,
  "model" text NOT NULL,
  "price_cents" integer,
  "deleted" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assist_repair_prices_service_idx" ON "assist_repair_prices" ("deleted","service","brand");
