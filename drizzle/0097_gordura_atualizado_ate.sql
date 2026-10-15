-- Controle de Gorduras: data "ATUALIZADO ATÉ" por módulo e loja (sai na
-- imagem). Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "commercial_gd_store_info" (
  "id" text PRIMARY KEY NOT NULL,
  "module" text NOT NULL,
  "store_id" text NOT NULL,
  "updated_until" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_gd_store_info_module_store_idx" ON "commercial_gd_store_info" ("module","store_id");
