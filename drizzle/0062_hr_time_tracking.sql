CREATE TABLE "hr_time_tracking_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"daily_target_minutes" integer DEFAULT 480 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_time_tracking_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"entry_date" text NOT NULL,
	"punches" text DEFAULT '' NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"target_minutes" integer DEFAULT 0 NOT NULL,
	"balance_minutes" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_time_tracking_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"year_month" text NOT NULL,
	"paid_minutes" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hr_time_tracking_settings_employee_idx" ON "hr_time_tracking_settings" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_time_tracking_entries_employee_date_idx" ON "hr_time_tracking_entries" USING btree ("employee_id","entry_date");--> statement-breakpoint
CREATE INDEX "hr_time_tracking_entries_date_idx" ON "hr_time_tracking_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_time_tracking_payouts_employee_month_idx" ON "hr_time_tracking_payouts" USING btree ("employee_id","year_month");--> statement-breakpoint
ALTER TABLE "hr_time_tracking_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_time_tracking_payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_time_tracking_settings" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_time_tracking_entries" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_time_tracking_payouts" FROM anon, authenticated;
