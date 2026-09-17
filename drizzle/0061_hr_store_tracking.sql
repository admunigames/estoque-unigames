CREATE TABLE "hr_leader_pdi" (
	"id" text PRIMARY KEY NOT NULL,
	"leader_name" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"meeting_date" text DEFAULT '' NOT NULL,
	"topic_discussed" text DEFAULT '' NOT NULL,
	"suggested_activity" text DEFAULT '' NOT NULL,
	"management_feedback" text DEFAULT '' NOT NULL,
	"team_members" text DEFAULT '' NOT NULL,
	"attendance_signed" integer DEFAULT 0 NOT NULL,
	"attachment_file_name" text DEFAULT '' NOT NULL,
	"attachment_r2_key" text DEFAULT '' NOT NULL,
	"attachment_size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_store_tracking" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"team_members" text DEFAULT '' NOT NULL,
	"week" text DEFAULT '' NOT NULL,
	"meeting_date" text DEFAULT '' NOT NULL,
	"management_feedback" text DEFAULT '' NOT NULL,
	"topic_discussed" text DEFAULT '' NOT NULL,
	"suggested_activity" text DEFAULT '' NOT NULL,
	"in_person_return" text DEFAULT '' NOT NULL,
	"member_returns" text DEFAULT '' NOT NULL,
	"attendance_signed" integer DEFAULT 0 NOT NULL,
	"attachment_file_name" text DEFAULT '' NOT NULL,
	"attachment_r2_key" text DEFAULT '' NOT NULL,
	"attachment_size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_leader_pdi_company_idx" ON "hr_leader_pdi" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "hr_leader_pdi_meeting_date_idx" ON "hr_leader_pdi" USING btree ("meeting_date");--> statement-breakpoint
CREATE INDEX "hr_store_tracking_company_idx" ON "hr_store_tracking" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "hr_store_tracking_meeting_date_idx" ON "hr_store_tracking" USING btree ("meeting_date");--> statement-breakpoint
ALTER TABLE "hr_leader_pdi" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_store_tracking" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_leader_pdi" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_store_tracking" FROM anon, authenticated;
