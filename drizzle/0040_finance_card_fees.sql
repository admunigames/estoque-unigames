CREATE TABLE "finance_card_fees" (
	"id" text PRIMARY KEY NOT NULL,
	"acquirer_id" text NOT NULL,
	"acquirer_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"modality" text DEFAULT 'credit' NOT NULL,
	"installments" integer DEFAULT 1 NOT NULL,
	"fee_bps" integer DEFAULT 0 NOT NULL,
	"anticipation_bps" integer DEFAULT 0 NOT NULL,
	"valid_from" text DEFAULT '' NOT NULL,
	"valid_to" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_sales" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"sale_date" text DEFAULT '' NOT NULL,
	"acquirer_id" text DEFAULT '' NOT NULL,
	"acquirer_name" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"modality" text DEFAULT 'credit' NOT NULL,
	"installments" integer DEFAULT 1 NOT NULL,
	"nsu" text DEFAULT '' NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"fee_bps" integer DEFAULT 0 NOT NULL,
	"expected_fee_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"fee_missing" integer DEFAULT 0 NOT NULL,
	"received_amount_cents" integer,
	"divergence_cents" integer,
	"settlement_import_id" text DEFAULT '' NOT NULL,
	"settled_at" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_sales_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'sales' NOT NULL,
	"reference_month" text DEFAULT '' NOT NULL,
	"source_name" text DEFAULT '' NOT NULL,
	"file_hash" text DEFAULT '' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts_receivable" ADD COLUMN "acquirer_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "finance_card_fees_acquirer_idx" ON "finance_card_fees" USING btree ("acquirer_id");--> statement-breakpoint
CREATE INDEX "finance_card_fees_lookup_idx" ON "finance_card_fees" USING btree ("acquirer_id","modality","installments","valid_from");--> statement-breakpoint
CREATE INDEX "finance_card_sales_company_date_idx" ON "finance_card_sales" USING btree ("company_id","sale_date");--> statement-breakpoint
CREATE INDEX "finance_card_sales_import_idx" ON "finance_card_sales" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "finance_card_sales_nsu_idx" ON "finance_card_sales" USING btree ("nsu");--> statement-breakpoint
CREATE INDEX "finance_card_sales_imports_company_idx" ON "finance_card_sales_imports" USING btree ("company_id","reference_month");--> statement-breakpoint
CREATE INDEX "finance_card_sales_imports_hash_idx" ON "finance_card_sales_imports" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "accounts_receivable_acquirer_idx" ON "accounts_receivable" USING btree ("acquirer_id");--> statement-breakpoint
-- Backfill: liga os recebíveis já existentes ao cadastro de adquirentes
-- criado na Fase 7, casando o texto livre atual (operator_text) com o nome
-- da adquirente (sem diferenciar maiúsculas/espaços nas pontas). Considera a
-- adquirente global ('') e a da mesma loja. Linhas que não baterem ficam com
-- acquirer_id vazio e seguem valendo pelo operator_text — nada é apagado.
UPDATE "accounts_receivable" ar SET "acquirer_id" = fa.id
FROM "finance_acquirers" fa
WHERE ar."acquirer_id" = ''
	AND ar."operator_text" <> ''
	AND lower(trim(ar."operator_text")) = lower(fa."name")
	AND (fa."company_id" = '' OR fa."company_id" = ar."company_id");
