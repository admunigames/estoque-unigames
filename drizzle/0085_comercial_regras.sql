-- Comercial: regras de comissão por VIGÊNCIA (aba Regras de Comissão),
-- crediário feito (coluna opcional da planilha) e vendedor NOVATO no mês.
-- Seed: a partir de 2026-10 garantia 6% e crediário 2% (o resto igual à
-- regra de setembro). Meses anteriores continuam na regra padrão do código.
-- Só CREATE TABLE/INDEX, ADD COLUMN e INSERT: nada é apagado.
CREATE TABLE IF NOT EXISTS "commercial_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"valid_from" text NOT NULL,
	"revenue_rate_high_bps" integer DEFAULT 60 NOT NULL,
	"revenue_rate_low_bps" integer DEFAULT 40 NOT NULL,
	"premium_tiers_json" text DEFAULT '[]' NOT NULL,
	"warranty_rate_bps" integer DEFAULT 400 NOT NULL,
	"warranty_attach_target" integer DEFAULT 30 NOT NULL,
	"credit_rate_bps" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_rules_valid_from_idx" ON "commercial_rules" USING btree ("valid_from");--> statement-breakpoint
ALTER TABLE "commercial_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_rules" FROM anon, authenticated;--> statement-breakpoint
INSERT INTO "commercial_rules" ("id", "valid_from", "revenue_rate_high_bps", "revenue_rate_low_bps", "premium_tiers_json", "warranty_rate_bps", "warranty_attach_target", "credit_rate_bps", "notes", "updated_by_name", "updated_at") VALUES
	('commercial-rules-2026-10', '2026-10', 60, 40, '[{"percent":110,"cents":50000},{"percent":120,"cents":150000}]', 600, 30, 200, 'GARANTIA 6% E CREDIÁRIO 2% (PEDIDO DE 06/10/2026)', 'SISTEMA', '2026-10-06T12:00:00.000Z')
	ON CONFLICT ("valid_from") DO NOTHING;--> statement-breakpoint
ALTER TABLE "commercial_monthly" ADD COLUMN IF NOT EXISTS "credit_sales_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commercial_newcomers" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"month" text NOT NULL,
	"marked_by" text DEFAULT '' NOT NULL,
	"marked_by_name" text DEFAULT '' NOT NULL,
	"marked_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_newcomers_employee_month_idx" ON "commercial_newcomers" USING btree ("employee_id","month");--> statement-breakpoint
ALTER TABLE "commercial_newcomers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_newcomers" FROM anon, authenticated;
