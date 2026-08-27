CREATE TABLE "finance_bank_classification_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"merchant_key" text NOT NULL,
	"category_item_id" text DEFAULT '' NOT NULL,
	"subcategory" text DEFAULT '' NOT NULL,
	"cost_center_id" text DEFAULT '' NOT NULL,
	"in_dre" integer DEFAULT 1 NOT NULL,
	"in_rateio" integer DEFAULT 0 NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_bank_statement_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"finance_account_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"entry_date" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"raw_merchant" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"fit_id" text DEFAULT '' NOT NULL,
	"category_item_id" text DEFAULT '' NOT NULL,
	"subcategory" text DEFAULT '' NOT NULL,
	"cost_center_id" text DEFAULT '' NOT NULL,
	"in_dre" integer DEFAULT 1 NOT NULL,
	"in_rateio" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expense_id" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_bank_statement_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"finance_account_id" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"source_name" text DEFAULT '' NOT NULL,
	"source_format" text DEFAULT 'ofx' NOT NULL,
	"period_start" text DEFAULT '' NOT NULL,
	"period_end" text DEFAULT '' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_bank_classification_rules_key_idx" ON "finance_bank_classification_rules" USING btree ("company_id","merchant_key");--> statement-breakpoint
CREATE INDEX "finance_bank_statement_entries_account_date_idx" ON "finance_bank_statement_entries" USING btree ("finance_account_id","entry_date");--> statement-breakpoint
CREATE INDEX "finance_bank_statement_entries_import_idx" ON "finance_bank_statement_entries" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "finance_bank_statement_entries_fit_idx" ON "finance_bank_statement_entries" USING btree ("finance_account_id","fit_id");--> statement-breakpoint
CREATE INDEX "finance_bank_statement_entries_merchant_idx" ON "finance_bank_statement_entries" USING btree ("raw_merchant");--> statement-breakpoint
CREATE INDEX "finance_bank_statement_imports_account_idx" ON "finance_bank_statement_imports" USING btree ("finance_account_id","period_start");