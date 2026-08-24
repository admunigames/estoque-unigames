ALTER TABLE "finance_accounts" ALTER COLUMN "type" SET DEFAULT 'checking';--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_type_check"
  CHECK ("type" IN ('checking', 'savings', 'cash', 'wallet', 'digital', 'card', 'investment', 'other'))
  NOT VALID;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "company_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "bank_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "bank_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "agency" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "agency_digit" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "account_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "account_digit" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "holder_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "holder_document" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "pix_key_type" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "pix_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "opening_balance_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "opening_balance_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "finance_accounts_company_active_idx" ON "finance_accounts" USING btree ("company_id","active");