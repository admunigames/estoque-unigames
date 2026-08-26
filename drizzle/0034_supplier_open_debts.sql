-- Módulo "Fornecedores em Aberto" (Financeiro Fase 3) — ver
-- [[estoque_modulo_financeiro_fase3_fornecedores]]. Resumo das decisões:
--  - Cada dívida (supplier_open_debts) tem sua PRÓPRIA linha "gêmea" em
--    accounts_payable (accounts_payable_id), reaproveitando 100% da lógica
--    de status/pagamento/DRE já existente — mesmo padrão de
--    supplier_invoice_installments (ver migration 0031).
--  - accounts_payable.finance_item_id é NOT NULL, mas o formulário de
--    dívida avulsa não exige categoria — por isso o SEED abaixo cria uma
--    categoria/item genéricos ("Fornecedores" / "Fornecedores em Aberto (a
--    categorizar)"), usados como default quando o usuário não escolher
--    outro item explicitamente.
--  - accounts_payable_payment_attachments é uma tabela GENÉRICA de anexo de
--    comprovante para qualquer pagamento de accounts_payable (não é
--    exclusiva de Fornecedores em Aberto) — mesmo padrão de
--    supplier_invoice_attachments (ver migration 0031), mesmo bucket R2.

CREATE TABLE "supplier_open_debts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_name" text DEFAULT '' NOT NULL,
	"invoice_number" text DEFAULT '' NOT NULL,
	"supplier_invoice_id" text DEFAULT '' NOT NULL,
	"order_reference" text DEFAULT '' NOT NULL,
	"purchase_date" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"original_amount_cents" integer NOT NULL,
	"paid_amount_cents" integer DEFAULT 0 NOT NULL,
	"due_date" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"accounts_payable_id" text DEFAULT '' NOT NULL,
	"canceled" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts_payable_payment_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "accounts_payable_payment_attachments_r2_key_unique" UNIQUE("r2_key")
);
--> statement-breakpoint
CREATE INDEX "supplier_open_debts_company_idx" ON "supplier_open_debts" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "supplier_open_debts_supplier_idx" ON "supplier_open_debts" USING btree ("supplier_id");
--> statement-breakpoint
CREATE INDEX "supplier_open_debts_payable_idx" ON "supplier_open_debts" USING btree ("accounts_payable_id");
--> statement-breakpoint
CREATE INDEX "accounts_payable_payment_attachments_payment_idx" ON "accounts_payable_payment_attachments" USING btree ("payment_id");
--> statement-breakpoint
-- SEED: categoria/item financeiro genéricos para dívidas de fornecedor
-- cadastradas sem categoria explícita — id fixo e previsível, checado com
-- ON CONFLICT DO NOTHING pra ser seguro rodar em qualquer ambiente mesmo se
-- já existir (idempotente).
INSERT INTO "finance_categories" ("id", "name", "parent_id", "position", "created_by", "created_by_name")
VALUES ('seed-supplier-open-debt-category', 'Fornecedores', NULL, 0, 'system', 'Sistema')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "finance_items" ("id", "category_id", "name", "position", "created_by", "created_by_name")
VALUES ('seed-supplier-open-debt-item', 'seed-supplier-open-debt-category', 'Fornecedores em Aberto (a categorizar)', 0, 'system', 'Sistema')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "supplier_open_debts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "accounts_payable_payment_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "supplier_open_debts" FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "accounts_payable_payment_attachments" FROM anon, authenticated;
