ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "must_change_password" integer DEFAULT 0 NOT NULL;
