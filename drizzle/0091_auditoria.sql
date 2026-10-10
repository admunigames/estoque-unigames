-- Auditoria: registro central de quem cadastrou/alterou/excluiu/anexou em
-- qualquer módulo (gravado pelo Worker). Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" text PRIMARY KEY NOT NULL,
  "at" text NOT NULL,
  "user_id" text DEFAULT '' NOT NULL,
  "user_name" text DEFAULT '' NOT NULL,
  "company_id" text DEFAULT '' NOT NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "module" text DEFAULT '' NOT NULL,
  "action" text DEFAULT '' NOT NULL,
  "record_id" text DEFAULT '' NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "status" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_at_idx" ON "audit_log" ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_module_at_idx" ON "audit_log" ("module","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_user_at_idx" ON "audit_log" ("user_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_record_idx" ON "audit_log" ("record_id");
