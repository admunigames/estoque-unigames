CREATE TABLE "hr_recruitment_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"desired_role" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'selecionado_entrevista' NOT NULL,
	"interview_date" text DEFAULT '' NOT NULL,
	"interview_time" text DEFAULT '' NOT NULL,
	"script_sent" integer DEFAULT 0 NOT NULL,
	"interview_result" text DEFAULT '' NOT NULL,
	"interview_result_reason" text DEFAULT '' NOT NULL,
	"test_script_sent" integer DEFAULT 0 NOT NULL,
	"test_confirmed" integer DEFAULT 0 NOT NULL,
	"cancelled_at" text DEFAULT '' NOT NULL,
	"cancelled_reason" text DEFAULT '' NOT NULL,
	"kit_delivered" integer DEFAULT 0 NOT NULL,
	"kit_delivered_date" text DEFAULT '' NOT NULL,
	"training_start_date" text DEFAULT '' NOT NULL,
	"admission_date" text DEFAULT '' NOT NULL,
	"admission_company_id" text DEFAULT '' NOT NULL,
	"admission_company_name" text DEFAULT '' NOT NULL,
	"fixed_unit_id" text DEFAULT '' NOT NULL,
	"fixed_unit_name" text DEFAULT '' NOT NULL,
	"uniform_sent" integer DEFAULT 0 NOT NULL,
	"uniform_sent_date" text DEFAULT '' NOT NULL,
	"system1_done" integer DEFAULT 0 NOT NULL,
	"system1_date" text DEFAULT '' NOT NULL,
	"system2_done" integer DEFAULT 0 NOT NULL,
	"system2_date" text DEFAULT '' NOT NULL,
	"system3_done" integer DEFAULT 0 NOT NULL,
	"system3_date" text DEFAULT '' NOT NULL,
	"ifood_done" integer DEFAULT 0 NOT NULL,
	"ifood_date" text DEFAULT '' NOT NULL,
	"benefits_included" integer DEFAULT 0 NOT NULL,
	"benefits_calculated" integer DEFAULT 0 NOT NULL,
	"benefits_date" text DEFAULT '' NOT NULL,
	"faceponto_done" integer DEFAULT 0 NOT NULL,
	"faceponto_date" text DEFAULT '' NOT NULL,
	"payjoy_done" integer DEFAULT 0 NOT NULL,
	"payjoy_date" text DEFAULT '' NOT NULL,
	"birthday_list_added" integer DEFAULT 0 NOT NULL,
	"birthday_list_date" text DEFAULT '' NOT NULL,
	"photo_taken" integer DEFAULT 0 NOT NULL,
	"aso_requested" integer DEFAULT 0 NOT NULL,
	"aso_clinic" text DEFAULT '' NOT NULL,
	"aso_value_cents" integer DEFAULT 0 NOT NULL,
	"shopping_registered" integer DEFAULT 0 NOT NULL,
	"admission_docs_drive_link" text DEFAULT '' NOT NULL,
	"dental_plan_included" integer DEFAULT 0 NOT NULL,
	"dental_plan_date" text DEFAULT '' NOT NULL,
	"references_checked" integer DEFAULT 0 NOT NULL,
	"integration_meeting_done" integer DEFAULT 0 NOT NULL,
	"integration_term_signed" integer DEFAULT 0 NOT NULL,
	"integration_term_file_name" text DEFAULT '' NOT NULL,
	"integration_term_r2_key" text DEFAULT '' NOT NULL,
	"integration_term_size_bytes" integer DEFAULT 0 NOT NULL,
	"integration_print_file_name" text DEFAULT '' NOT NULL,
	"integration_print_r2_key" text DEFAULT '' NOT NULL,
	"integration_print_size_bytes" integer DEFAULT 0 NOT NULL,
	"integration_meeting_transcript" text DEFAULT '' NOT NULL,
	"hr_employee_id" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_recruitment_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"from_status" text DEFAULT '' NOT NULL,
	"to_status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"changed_by" text DEFAULT '' NOT NULL,
	"changed_by_name" text DEFAULT '' NOT NULL,
	"changed_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_recruitment_test_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"paid_date" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_recruitment_sponsors" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text DEFAULT '' NOT NULL,
	"employee_name" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"sponsor_name" text DEFAULT '' NOT NULL,
	"informed_date" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_recruitment_sponsor_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"sponsor_id" text NOT NULL,
	"update_text" text NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_recruitment_candidates_status_idx" ON "hr_recruitment_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hr_recruitment_candidates_interview_date_idx" ON "hr_recruitment_candidates" USING btree ("interview_date");--> statement-breakpoint
CREATE INDEX "hr_recruitment_status_history_candidate_idx" ON "hr_recruitment_status_history" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "hr_recruitment_test_payments_candidate_idx" ON "hr_recruitment_test_payments" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "hr_recruitment_sponsors_employee_idx" ON "hr_recruitment_sponsors" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "hr_recruitment_sponsor_updates_sponsor_idx" ON "hr_recruitment_sponsor_updates" USING btree ("sponsor_id");--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_recruitment_status_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_recruitment_test_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_recruitment_sponsors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_recruitment_sponsor_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_recruitment_candidates" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_recruitment_status_history" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_recruitment_test_payments" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_recruitment_sponsors" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_recruitment_sponsor_updates" FROM anon, authenticated;
