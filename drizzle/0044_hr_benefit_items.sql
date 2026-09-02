CREATE TABLE "hr_benefit_items" (
	"id" text PRIMARY KEY NOT NULL,
	"benefit_id" text NOT NULL,
	"type" text DEFAULT 'outros' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_benefits" ADD COLUMN "gross_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_benefits" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "hr_benefit_items_benefit_idx" ON "hr_benefit_items" USING btree ("benefit_id");--> statement-breakpoint
ALTER TABLE "hr_benefit_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_benefit_items" FROM anon, authenticated;--> statement-breakpoint
-- Backfill: cada lançamento de benefício existente vira uma linha única,
-- sem desconto. O bruto passa a ser igual ao valor atual (que já era
-- líquido, pois desconto não existia).
UPDATE "hr_benefits" SET "gross_cents" = "amount_cents" WHERE "gross_cents" = 0;--> statement-breakpoint
INSERT INTO "hr_benefit_items" ("id", "benefit_id", "type", "amount_cents", "discount_cents", "created_by", "created_at")
SELECT "id", "id", "type", "amount_cents", 0, "created_by", "created_at"
FROM "hr_benefits"
WHERE NOT EXISTS (SELECT 1 FROM "hr_benefit_items" bi WHERE bi."benefit_id" = "hr_benefits"."id");