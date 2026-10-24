-- Fluxo de Caixa por CONTA e Conciliação de Contas a Receber (23/10/2026).
-- Só ADD COLUMN / CREATE INDEX.
--   accounts_receivable.finance_account_id: conta bancária onde o
--   recebimento cai (projeção do Fluxo de Caixa por conta).
--   accounts_receivable.bank_entry_id: lançamento do extrato que confirmou
--   o recebimento (CONCILIAÇÃO DE CONTAS A RECEBER: previsto × entrou).
ALTER TABLE "accounts_receivable" ADD COLUMN IF NOT EXISTS "finance_account_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts_receivable" ADD COLUMN IF NOT EXISTS "bank_entry_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_receivable_account_expected_idx" ON "accounts_receivable" ("finance_account_id","expected_date");
