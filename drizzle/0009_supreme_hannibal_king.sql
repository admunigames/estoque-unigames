ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "hierarchy" text DEFAULT 'administrative' NOT NULL;
