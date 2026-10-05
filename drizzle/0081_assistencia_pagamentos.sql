-- Assistência: aba PAGAMENTOS (formas de pagamento do PDF), desconto em R$ por
-- item do orçamento e cópia das formas de pagamento em cada orçamento.
CREATE TABLE "assist_payment_options" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"installments" integer DEFAULT 1 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assist_payment_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "assist_payment_options" FROM anon, authenticated;--> statement-breakpoint
INSERT INTO "assist_payment_options" ("id", "kind", "label", "discount_bp", "installments", "sort_order") VALUES
	('assist-pay-credito-6x', 'credit', 'PAGAMENTO NO CRÉDITO ATÉ 6X SEM JUROS', 0, 6, 1),
	('assist-pay-debito', 'always', 'PAGAMENTO NO DÉBITO COM 5% DE DESCONTO', 500, 1, 2),
	('assist-pay-dinheiro-pix', 'always', 'PAGAMENTO NO DINHEIRO OU PIX COM 10% DE DESCONTO', 1000, 1, 3);--> statement-breakpoint
ALTER TABLE "assist_quotes" ADD COLUMN "payments" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_quote_items" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;
