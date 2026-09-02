CREATE TABLE "hr_thirteenth_salary" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"year" text NOT NULL,
	"installment" text DEFAULT 'unico' NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"deductions_cents" integer DEFAULT 0 NOT NULL,
	"payment_done" integer DEFAULT 0 NOT NULL,
	"payment_date" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_thirteenth_employee_year_installment_idx" ON "hr_thirteenth_salary" USING btree ("employee_id","year","installment");--> statement-breakpoint
CREATE INDEX "hr_thirteenth_year_idx" ON "hr_thirteenth_salary" USING btree ("year");--> statement-breakpoint
CREATE INDEX "hr_thirteenth_company_idx" ON "hr_thirteenth_salary" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "hr_thirteenth_salary" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_thirteenth_salary" FROM anon, authenticated;