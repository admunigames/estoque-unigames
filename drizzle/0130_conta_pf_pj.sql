-- Conta financeira PF ou PJ (04/11/2026), obrigatório ao cadastrar. Contas
-- antigas: deduzido do CPF (11 dígitos = PF) ou CNPJ (14 = PJ) do titular;
-- sem documento fica '' até alguém editar a conta.
ALTER TABLE "finance_accounts" ADD COLUMN IF NOT EXISTS "person_type" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "finance_accounts" SET "person_type" = CASE
  WHEN length(regexp_replace("holder_document", '\D', '', 'g')) = 11 THEN 'pf'
  WHEN length(regexp_replace("holder_document", '\D', '', 'g')) = 14 THEN 'pj'
  ELSE '' END
WHERE "person_type" = '' AND length(regexp_replace("holder_document", '\D', '', 'g')) IN (11, 14);
