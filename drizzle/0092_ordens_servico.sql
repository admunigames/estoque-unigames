-- Assistência > Ordens de Serviço: O.S. em andamento + histórico da
-- atualização diária. Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "assist_service_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "os_number" text NOT NULL,
  "category" text NOT NULL,
  "equipment" text DEFAULT '' NOT NULL,
  "status" text DEFAULT '' NOT NULL,
  "store_id" text DEFAULT '' NOT NULL,
  "store_name" text DEFAULT '' NOT NULL,
  "deadline" text DEFAULT '' NOT NULL,
  "situation" text DEFAULT '' NOT NULL,
  "closed" integer DEFAULT 0 NOT NULL,
  "closed_at" text DEFAULT '' NOT NULL,
  "last_update_text" text DEFAULT '' NOT NULL,
  "last_update_at" text DEFAULT '' NOT NULL,
  "last_update_by_name" text DEFAULT '' NOT NULL,
  "canceled" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assist_service_orders_open_idx" ON "assist_service_orders" ("canceled","closed","deadline");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assist_service_orders_store_idx" ON "assist_service_orders" ("store_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assist_service_order_updates" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "update_text" text NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assist_service_order_updates_order_idx" ON "assist_service_order_updates" ("order_id","created_at");
