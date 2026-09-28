ALTER TABLE "instructions" ADD COLUMN "deactivated_at" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE "instruction_carousel_images" (
	"id" text PRIMARY KEY NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text DEFAULT 'image/jpeg' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "instruction_carousel_images_position_idx" ON "instruction_carousel_images" USING btree ("position");
