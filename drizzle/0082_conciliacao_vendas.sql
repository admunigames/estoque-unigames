-- Conciliação de Vendas (Financeiro 6/9): vendas do PONTTIE (todas as formas
-- de pagamento) classificadas em VENDA (loja da maquineta) × SERVIÇO
-- (ASSISTÊNCIA), conferidas com a maquineta e com o extrato bancário, e o
-- prazo de recebimento por adquirente para o CARTÃO × BANCO.
-- Só CREATE/ADD COLUMN/INDEX: nada é apagado.
CREATE TABLE IF NOT EXISTS "finance_sales_recon_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"reference_month" text DEFAULT '' NOT NULL,
	"source_name" text DEFAULT '' NOT NULL,
	"file_hash" text DEFAULT '' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_sales_recon_imports_hash_idx" ON "finance_sales_recon_imports" USING btree ("file_hash");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_sales_recon_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"sale_date" text DEFAULT '' NOT NULL,
	"sale_ref" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"payment_method" text DEFAULT 'other' NOT NULL,
	"installments" integer DEFAULT 1 NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"authorization_code" text DEFAULT '' NOT NULL,
	"terminal_ref" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'sale' NOT NULL,
	"kind_source" text DEFAULT 'auto' NOT NULL,
	"machine_id" text DEFAULT '' NOT NULL,
	"revenue_company_id" text DEFAULT '' NOT NULL,
	"card_sale_id" text DEFAULT '' NOT NULL,
	"bank_entry_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_sales_recon_rows_company_date_idx" ON "finance_sales_recon_rows" USING btree ("company_id","sale_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_sales_recon_rows_import_idx" ON "finance_sales_recon_rows" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_sales_recon_rows_revenue_date_idx" ON "finance_sales_recon_rows" USING btree ("revenue_company_id","sale_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_sales_recon_rows_card_sale_idx" ON "finance_sales_recon_rows" USING btree ("card_sale_id");--> statement-breakpoint
ALTER TABLE "finance_acquirers" ADD COLUMN IF NOT EXISTS "debit_days" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_acquirers" ADD COLUMN IF NOT EXISTS "credit_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_acquirers" ADD COLUMN IF NOT EXISTS "anticipated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_acquirers" ADD COLUMN IF NOT EXISTS "bank_keyword" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_entries" ADD COLUMN IF NOT EXISTS "sales_recon_status" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_entries" ADD COLUMN IF NOT EXISTS "sales_recon_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_entries" ADD COLUMN IF NOT EXISTS "acquirer_id" text DEFAULT '' NOT NULL;
