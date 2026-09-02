CREATE TABLE "hr_dre_mapping" (
	"block" text PRIMARY KEY NOT NULL,
	"finance_item_id" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_dre_mapping" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_dre_mapping" FROM anon, authenticated;
