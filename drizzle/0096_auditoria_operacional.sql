-- Auditoria Operacional (checklist de loja): itens editáveis, auditorias e
-- respostas (com o texto do item da época). Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "ops_audit_items" (
  "id" text PRIMARY KEY NOT NULL,
  "section" text NOT NULL,
  "group_name" text DEFAULT '' NOT NULL,
  "text" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" integer DEFAULT 1 NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_audit_items_order_idx" ON "ops_audit_items" ("sort_order");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops_audits" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "audit_date" text NOT NULL,
  "auditor_id" text DEFAULT '' NOT NULL,
  "auditor_name" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "finalized_by" text DEFAULT '' NOT NULL,
  "finalized_by_name" text DEFAULT '' NOT NULL,
  "finalized_at" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_audits_company_idx" ON "ops_audits" ("deleted","company_id","audit_date");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops_audit_answers" (
  "id" text PRIMARY KEY NOT NULL,
  "audit_id" text NOT NULL,
  "item_id" text NOT NULL,
  "section" text NOT NULL,
  "group_name" text DEFAULT '' NOT NULL,
  "text" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "answer" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_audit_answers_audit_idx" ON "ops_audit_answers" ("audit_id","sort_order");
