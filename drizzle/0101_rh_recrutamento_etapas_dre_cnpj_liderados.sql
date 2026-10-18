-- RH (out/2026, 2º pacote): rescisão paga, recrutamento por etapas
-- (telefone, etapa de treinamento, data única do checklist) e
-- acompanhamento por liderado. Só ADD COLUMN / CREATE TABLE/INDEX (e RLS).
ALTER TABLE "hr_terminations" ADD COLUMN IF NOT EXISTS "severance_paid_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN IF NOT EXISTS "phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN IF NOT EXISTS "training_schedule_script_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN IF NOT EXISTS "training_confirmed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN IF NOT EXISTS "training_script_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN IF NOT EXISTS "training_trainer_informed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_recruitment_candidates" ADD COLUMN IF NOT EXISTS "checklist_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hr_store_followups" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "company_name" text DEFAULT '' NOT NULL,
  "leader_name" text DEFAULT '' NOT NULL,
  "leader_area" text DEFAULT 'comercial' NOT NULL,
  "member_name" text NOT NULL,
  "cycle_start" text NOT NULL,
  "week" integer NOT NULL,
  "mode" text DEFAULT 'online' NOT NULL,
  "meeting_date" text DEFAULT '' NOT NULL,
  "topic" text DEFAULT '' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "done" integer DEFAULT 0 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" text DEFAULT '' NOT NULL,
  "updated_by" text DEFAULT '' NOT NULL,
  "updated_by_name" text DEFAULT '' NOT NULL,
  "updated_at" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hr_store_followups_cycle_week_idx" ON "hr_store_followups" ("company_id","member_name","cycle_start","week");--> statement-breakpoint
ALTER TABLE "hr_store_followups" ENABLE ROW LEVEL SECURITY;
