ALTER TABLE "obra_entries" ADD COLUMN "attachment_file_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "obra_entries" ADD COLUMN "attachment_r2_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "obra_entries" ADD COLUMN "attachment_size_bytes" integer DEFAULT 0 NOT NULL;