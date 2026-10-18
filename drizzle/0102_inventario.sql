-- Estoque > Inventário: inventários por loja/data, categorias contadas, itens
-- (sistema x contado, custo, motivo) e recontagens escaneadas.
-- Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "inventories" (
  "id" text PRIMARY KEY NOT NULL,
  "store_id" text NOT NULL,
  "store_name" text DEFAULT '' NOT NULL,
  "inventory_date" text NOT NULL,
  "status" text DEFAULT 'aberto' NOT NULL,
  "costs_file_name" text DEFAULT '' NOT NULL,
  "costs_uploaded_by_name" text DEFAULT '' NOT NULL,
  "costs_uploaded_at" text DEFAULT '' NOT NULL,
  "finalized_by_name" text DEFAULT '' NOT NULL,
  "finalized_at" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventories_store_idx" ON "inventories" ("deleted","store_id","inventory_date");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_categories" (
  "id" text PRIMARY KEY NOT NULL,
  "inventory_id" text NOT NULL,
  "category" text NOT NULL,
  "file_name" text DEFAULT '' NOT NULL,
  "uploaded_by_name" text DEFAULT '' NOT NULL,
  "uploaded_at" text DEFAULT '' NOT NULL,
  "counted_by_name" text DEFAULT '' NOT NULL,
  "counted_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_categories_inventory_category_idx" ON "inventory_categories" ("inventory_id","category");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_items" (
  "id" text PRIMARY KEY NOT NULL,
  "inventory_id" text NOT NULL,
  "category" text NOT NULL,
  "code" text DEFAULT '' NOT NULL,
  "product" text NOT NULL,
  "system_qty" integer DEFAULT 0 NOT NULL,
  "counted_qty" integer,
  "counted_by_name" text DEFAULT '' NOT NULL,
  "counted_at" text DEFAULT '' NOT NULL,
  "cost_cents" integer,
  "reason" text DEFAULT '' NOT NULL,
  "removed" integer DEFAULT 0 NOT NULL,
  "removed_by_name" text DEFAULT '' NOT NULL,
  "removed_at" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_items_inventory_idx" ON "inventory_items" ("inventory_id","category");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "inventory_id" text NOT NULL,
  "file_name" text NOT NULL,
  "r2_key" text NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "content_type" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "uploaded_by" text DEFAULT '' NOT NULL,
  "uploaded_by_name" text DEFAULT '' NOT NULL,
  "uploaded_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_attachments_inventory_idx" ON "inventory_attachments" ("inventory_id");
