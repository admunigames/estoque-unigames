ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "sector" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "app_users"
SET "sector" = 'assistance', "company_id" = ''
WHERE "access_group" = 'assistance' OR lower("username") = 'assistencia';
