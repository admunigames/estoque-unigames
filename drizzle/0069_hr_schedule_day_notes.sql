ALTER TABLE "hr_schedule_sunday_work" ADD COLUMN "work_time" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE "hr_schedule_day_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"reference_month" text NOT NULL,
	"note_date" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_schedule_day_notes_company_date_idx" ON "hr_schedule_day_notes" USING btree ("company_id","note_date");--> statement-breakpoint
CREATE INDEX "hr_schedule_day_notes_month_idx" ON "hr_schedule_day_notes" USING btree ("reference_month");--> statement-breakpoint
ALTER TABLE "hr_schedule_day_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_schedule_day_notes" FROM anon, authenticated;
