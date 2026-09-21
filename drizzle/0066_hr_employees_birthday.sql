ALTER TABLE "hr_employees" ADD COLUMN "birth_date" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN "birthday_acknowledged_year" integer DEFAULT 0 NOT NULL;
