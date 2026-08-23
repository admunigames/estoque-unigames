CREATE TABLE "os_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"os_id" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"requester_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"r2_key" text DEFAULT '' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"attached_by" text DEFAULT '' NOT NULL,
	"attached_by_name" text DEFAULT '' NOT NULL,
	"attached_at" text DEFAULT '' NOT NULL,
	"file_removed_at" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "os_notes_status_check" CHECK ("status" IN ('pending', 'attached'))
);
--> statement-breakpoint
CREATE INDEX "os_notes_company_status_created_idx" ON "os_notes" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "os_notes_os_id_idx" ON "os_notes" USING btree ("os_id");--> statement-breakpoint
ALTER TABLE "os_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "os_notes" FROM anon, authenticated;
