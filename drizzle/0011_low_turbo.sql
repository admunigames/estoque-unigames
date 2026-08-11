ALTER TABLE "captured_products" ADD COLUMN IF NOT EXISTS "game_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "captured_products" ADD COLUMN IF NOT EXISTS "game_console" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "captured_products" ADD COLUMN IF NOT EXISTS "game_condition" text DEFAULT '' NOT NULL;
