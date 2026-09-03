ALTER TABLE "finance_card_sales" ADD COLUMN "recon_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN "reviewed_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN "reviewed_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN "reviewed_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_card_sales" ADD COLUMN "reviewed_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "finance_card_sales_recon_idx" ON "finance_card_sales" USING btree ("company_id","recon_status");--> statement-breakpoint
UPDATE "finance_card_sales" SET "recon_status" = CASE
  WHEN "fee_missing" = 1 THEN 'attention'
  WHEN "received_amount_cents" IS NULL THEN 'pending'
  WHEN ABS(("gross_cents" - "received_amount_cents") - "expected_fee_cents") > 50
   AND ABS(("gross_cents" - "received_amount_cents") - "expected_fee_cents") * 10000 > ABS("gross_cents") * 15
  THEN 'attention'
  ELSE 'ok'
END;
