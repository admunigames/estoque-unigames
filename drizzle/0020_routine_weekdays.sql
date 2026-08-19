ALTER TABLE "operational_routines" ADD COLUMN IF NOT EXISTS "weekdays" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "operational_routines" SET "weekdays" = "weekday"::text WHERE "weekdays" = '';--> statement-breakpoint
DROP INDEX IF EXISTS "operational_routines_weekday_idx";--> statement-breakpoint
ALTER TABLE "operational_routines" DROP COLUMN IF EXISTS "weekday";--> statement-breakpoint
ALTER TABLE "operational_routines" ALTER COLUMN "scope" SET DEFAULT 'general';
