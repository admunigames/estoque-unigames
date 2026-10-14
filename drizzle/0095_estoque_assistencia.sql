-- Assistência > Estoque: peças com entrada/baixa e histórico de movimentos.
-- Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "assist_stock_items" (
  "id" text PRIMARY KEY NOT NULL,
  "category" text NOT NULL,
  "name" text NOT NULL,
  "quantity" integer DEFAULT 0 NOT NULL,
  "sale_price_cents" integer,
  "deleted" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assist_stock_items_category_idx" ON "assist_stock_items" ("deleted","category");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assist_stock_movements" (
  "id" text PRIMARY KEY NOT NULL,
  "item_id" text NOT NULL,
  "kind" text NOT NULL,
  "quantity" integer NOT NULL,
  "balance_after" integer NOT NULL,
  "os_number" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assist_stock_movements_item_idx" ON "assist_stock_movements" ("item_id","created_at");
