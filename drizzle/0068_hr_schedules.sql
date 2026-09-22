CREATE TABLE "hr_schedule_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text DEFAULT '' NOT NULL,
	"employee_name" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"reference_month" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_schedule_assignments_employee_month_idx" ON "hr_schedule_assignments" USING btree ("employee_id","reference_month");--> statement-breakpoint
CREATE INDEX "hr_schedule_assignments_month_idx" ON "hr_schedule_assignments" USING btree ("reference_month");--> statement-breakpoint
CREATE INDEX "hr_schedule_assignments_company_idx" ON "hr_schedule_assignments" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "hr_schedule_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_schedule_assignments" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE "hr_schedule_sunday_work" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text DEFAULT '' NOT NULL,
	"employee_name" text NOT NULL,
	"reference_month" text NOT NULL,
	"work_date" text NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_schedule_sunday_work_employee_date_idx" ON "hr_schedule_sunday_work" USING btree ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "hr_schedule_sunday_work_month_idx" ON "hr_schedule_sunday_work" USING btree ("reference_month");--> statement-breakpoint
CREATE INDEX "hr_schedule_sunday_work_date_idx" ON "hr_schedule_sunday_work" USING btree ("work_date");--> statement-breakpoint
ALTER TABLE "hr_schedule_sunday_work" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_schedule_sunday_work" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE "hr_schedule_weekday_off" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text DEFAULT '' NOT NULL,
	"employee_name" text NOT NULL,
	"reference_month" text NOT NULL,
	"off_date" text NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_schedule_weekday_off_employee_date_idx" ON "hr_schedule_weekday_off" USING btree ("employee_id","off_date");--> statement-breakpoint
CREATE INDEX "hr_schedule_weekday_off_month_idx" ON "hr_schedule_weekday_off" USING btree ("reference_month");--> statement-breakpoint
CREATE INDEX "hr_schedule_weekday_off_date_idx" ON "hr_schedule_weekday_off" USING btree ("off_date");--> statement-breakpoint
ALTER TABLE "hr_schedule_weekday_off" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_schedule_weekday_off" FROM anon, authenticated;
