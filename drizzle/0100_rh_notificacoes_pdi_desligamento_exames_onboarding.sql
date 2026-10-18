-- RH: textos das pendências do Recrutamento (hr_settings), PDI com
-- transcrição e próximas ações, motivo + checklist demissional, vencimento
-- do ASO e Onboarding (vídeos no R2, progresso por colaborador e reunião).
-- Só ADD COLUMN / CREATE TABLE/INDEX (e RLS nas tabelas novas).
CREATE TABLE IF NOT EXISTS "hr_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value_json" text DEFAULT '{}' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
ALTER TABLE "hr_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_leader_pdi" ADD COLUMN IF NOT EXISTS "transcript_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leader_pdi" ADD COLUMN IF NOT EXISTS "transcript_file_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leader_pdi" ADD COLUMN IF NOT EXISTS "agreed_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leader_pdi" ADD COLUMN IF NOT EXISTS "participants" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leader_pdi" ADD COLUMN IF NOT EXISTS "next_actions_json" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_terminations" ADD COLUMN IF NOT EXISTS "reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_terminations" ADD COLUMN IF NOT EXISTS "reason_other" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_terminations" ADD COLUMN IF NOT EXISTS "checklist_json" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_aso_exams" ADD COLUMN IF NOT EXISTS "expiry_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "onboarding_started_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "onboarding_meeting_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "onboarding_meeting_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN IF NOT EXISTS "onboarding_meeting_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_onboarding_videos" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "role_title" text DEFAULT '' NOT NULL,
  "company_id" text DEFAULT '' NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "file_name" text DEFAULT '' NOT NULL,
  "r2_key" text DEFAULT '' NOT NULL,
  "content_type" text DEFAULT '' NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "duration_seconds" integer DEFAULT 0 NOT NULL,
  "active" integer DEFAULT 1 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
ALTER TABLE "hr_onboarding_videos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_onboarding_progress" (
  "id" text PRIMARY KEY NOT NULL,
  "employee_id" text NOT NULL,
  "video_id" text NOT NULL,
  "watched_seconds" integer DEFAULT 0 NOT NULL,
  "position_seconds" integer DEFAULT 0 NOT NULL,
  "completed_at" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hr_onboarding_progress_employee_video_idx" ON "hr_onboarding_progress" ("employee_id","video_id");--> statement-breakpoint
ALTER TABLE "hr_onboarding_progress" ENABLE ROW LEVEL SECURITY;
