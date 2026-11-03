ALTER TABLE "finance_bank_statement_entries" ADD COLUMN IF NOT EXISTS "payment_id" text DEFAULT '' NOT NULL;
