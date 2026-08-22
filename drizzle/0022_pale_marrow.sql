CREATE TABLE "daily_checklist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"item_key" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"date" text NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"completed_by" text DEFAULT '' NOT NULL,
	"completed_by_name" text DEFAULT '' NOT NULL,
	"completed_at" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_checklist_items_unique" ON "daily_checklist_items" USING btree ("kind","item_key","company_id","date");--> statement-breakpoint
CREATE INDEX "daily_checklist_items_date_company_idx" ON "daily_checklist_items" USING btree ("date","company_id");--> statement-breakpoint
ALTER TABLE "daily_checklist_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "daily_checklist_items" FROM anon, authenticated;