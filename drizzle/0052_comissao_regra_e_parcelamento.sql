ALTER TABLE "hr_commission_items" ADD COLUMN "installment_group_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_commission_items" ADD COLUMN "installment_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_commission_items" ADD COLUMN "installment_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD COLUMN "commission_rule_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "hr_commission_items_installment_group_idx" ON "hr_commission_items" USING btree ("installment_group_id");