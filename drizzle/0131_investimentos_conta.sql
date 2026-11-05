-- INVESTIMENTOS dentro de uma conta financeira já cadastrada (04/11/2026):
-- aplicações e resgates; saldo investido = aplicações − resgates até a data.
CREATE TABLE IF NOT EXISTS "finance_account_investments" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "kind" text DEFAULT 'aplicacao' NOT NULL,
  "entry_date" text NOT NULL,
  "amount_cents" integer DEFAULT 0 NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT now()::text NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_account_investments_account_idx" ON "finance_account_investments" ("account_id", "entry_date");
