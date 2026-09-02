CREATE TABLE "hr_holidays" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"scope" text DEFAULT 'nacional' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_benefit_items" ADD COLUMN "amount_mode" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_benefit_items" ADD COLUMN "per_day_rate_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_benefit_items" ADD COLUMN "working_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN "work_schedule" text DEFAULT '5x2' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_holidays_date_company_idx" ON "hr_holidays" USING btree ("date","company_id");--> statement-breakpoint
CREATE INDEX "hr_holidays_date_idx" ON "hr_holidays" USING btree ("date");--> statement-breakpoint
ALTER TABLE "hr_holidays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_holidays" FROM anon, authenticated;