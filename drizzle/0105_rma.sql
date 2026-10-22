-- Assistência > RMA: casos, atualizações, anexos, créditos, descartes e
-- fornecedores (substitui o RMA do Base44). Só CREATE TABLE/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "rma_cases" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "arrival_date" text DEFAULT '' NOT NULL,
  "store_id" text DEFAULT '' NOT NULL,
  "store_name" text DEFAULT '' NOT NULL,
  "supplier" text DEFAULT '' NOT NULL,
  "responsible" text DEFAULT '' NOT NULL,
  "status" text NOT NULL,
  "priority" text DEFAULT '' NOT NULL,
  "os_number" text DEFAULT '' NOT NULL,
  "os_deadline" text DEFAULT '' NOT NULL,
  "os_situation" text DEFAULT '' NOT NULL,
  "invoice_number" text DEFAULT '' NOT NULL,
  "accessories" text DEFAULT '' NOT NULL,
  "product_name" text NOT NULL,
  "product_category" text DEFAULT '' NOT NULL,
  "brand" text DEFAULT '' NOT NULL,
  "serial_number" text DEFAULT '' NOT NULL,
  "quantity" integer DEFAULT 1 NOT NULL,
  "product_notes" text DEFAULT '' NOT NULL,
  "defect_type" text DEFAULT '' NOT NULL,
  "defect_description" text DEFAULT '' NOT NULL,
  "technical_analysis" text DEFAULT '' NOT NULL,
  "finalized" integer DEFAULT 0 NOT NULL,
  "finalized_at" text DEFAULT '' NOT NULL,
  "finalized_by_name" text DEFAULT '' NOT NULL,
  "solution_type" text DEFAULT '' NOT NULL,
  "solution_description" text DEFAULT '' NOT NULL,
  "last_update_at" text DEFAULT '' NOT NULL,
  "next_update_date" text DEFAULT '' NOT NULL,
  "next_action" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_cases_store_idx" ON "rma_cases" ("deleted","store_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_cases_os_idx" ON "rma_cases" ("os_number");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rma_updates" (
  "id" text PRIMARY KEY NOT NULL,
  "rma_id" text NOT NULL,
  "update_at" text NOT NULL,
  "responsible" text DEFAULT '' NOT NULL,
  "description" text NOT NULL,
  "new_status" text DEFAULT '' NOT NULL,
  "next_action" text DEFAULT '' NOT NULL,
  "next_update_date" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_updates_rma_idx" ON "rma_updates" ("rma_id","update_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rma_attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_type" text NOT NULL,
  "owner_id" text NOT NULL,
  "rma_id" text DEFAULT '' NOT NULL,
  "file_name" text NOT NULL,
  "r2_key" text DEFAULT '' NOT NULL,
  "source_url" text DEFAULT '' NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "content_type" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "uploaded_by" text DEFAULT '' NOT NULL,
  "uploaded_by_name" text DEFAULT '' NOT NULL,
  "uploaded_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_attachments_owner_idx" ON "rma_attachments" ("owner_type","owner_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rma_credits" (
  "id" text PRIMARY KEY NOT NULL,
  "supplier" text NOT NULL,
  "rma_id" text DEFAULT '' NOT NULL,
  "rma_code" text DEFAULT '' NOT NULL,
  "generated_date" text DEFAULT '' NOT NULL,
  "credit_cents" integer DEFAULT 0 NOT NULL,
  "used_cents" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT '' NOT NULL,
  "usage_type" text DEFAULT '' NOT NULL,
  "usage_date" text DEFAULT '' NOT NULL,
  "document_number" text DEFAULT '' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_credits_supplier_idx" ON "rma_credits" ("deleted","supplier");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rma_disposals" (
  "id" text PRIMARY KEY NOT NULL,
  "rma_id" text DEFAULT '' NOT NULL,
  "rma_code" text DEFAULT '' NOT NULL,
  "product_name" text NOT NULL,
  "product_category" text DEFAULT '' NOT NULL,
  "store_id" text DEFAULT '' NOT NULL,
  "store_name" text DEFAULT '' NOT NULL,
  "supplier" text DEFAULT '' NOT NULL,
  "quantity" integer DEFAULT 1 NOT NULL,
  "unit_cost_cents" integer DEFAULT 0 NOT NULL,
  "total_cost_cents" integer DEFAULT 0 NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "authorized_by" text DEFAULT '' NOT NULL,
  "disposal_date" text DEFAULT '' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_disposals_date_idx" ON "rma_disposals" ("deleted","disposal_date");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rma_suppliers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "contact_name" text DEFAULT '' NOT NULL,
  "phone" text DEFAULT '' NOT NULL,
  "whatsapp" text DEFAULT '' NOT NULL,
  "email" text DEFAULT '' NOT NULL,
  "cnpj" text DEFAULT '' NOT NULL,
  "treatment_model" text DEFAULT '' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "active" integer DEFAULT 1 NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rma_suppliers_name_idx" ON "rma_suppliers" ("name");
