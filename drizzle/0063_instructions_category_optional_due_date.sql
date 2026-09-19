ALTER TABLE "instructions" ADD COLUMN "category" text DEFAULT 'geral' NOT NULL;
--> statement-breakpoint
ALTER TABLE "instructions" ALTER COLUMN "due_date" DROP NOT NULL;
