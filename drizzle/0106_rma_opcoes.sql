-- RMA > CONFIGURAÇÕES: opções editáveis. Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "rma_options" (
  "id" text PRIMARY KEY NOT NULL,
  "category" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "color" text DEFAULT '' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" integer DEFAULT 1 NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_options_category_idx" ON "rma_options" ("deleted","category");
