-- Divergências (13/11/2026): anexos (imagem JPG/PNG/WEBP ou PDF) na resposta
-- do ADM e no retorno da loja, por item. side = 'adm' | 'loja'. O arquivo
-- fica no R2 (UPLOADS) em divergences/<request_id>/<item_id>/<id>-<nome>;
-- excluir apaga o arquivo e o registro. Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "divergence_item_attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "item_id" text NOT NULL,
  "request_id" text NOT NULL,
  "side" text NOT NULL,
  "r2_key" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text DEFAULT '' NOT NULL,
  "size" integer DEFAULT 0 NOT NULL,
  "uploaded_by" text DEFAULT '' NOT NULL,
  "uploaded_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "divergence_item_attachments_item_idx" ON "divergence_item_attachments" ("item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "divergence_item_attachments_request_idx" ON "divergence_item_attachments" ("request_id");
