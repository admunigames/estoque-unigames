CREATE TABLE "commercial_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"month" text NOT NULL,
	"target_revenue_cents" integer DEFAULT 0 NOT NULL,
	"target_items" integer DEFAULT 0 NOT NULL,
	"target_warranty_cents" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_goals_employee_month_idx" ON "commercial_goals" USING btree ("employee_id","month");--> statement-breakpoint
CREATE INDEX "commercial_goals_month_idx" ON "commercial_goals" USING btree ("month");--> statement-breakpoint
CREATE INDEX "commercial_goals_company_idx" ON "commercial_goals" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "commercial_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_goals" FROM anon, authenticated;--> statement-breakpoint
CREATE TABLE "commercial_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"month" text NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"entry_date" text NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "commercial_entries_month_idx" ON "commercial_entries" USING btree ("month");--> statement-breakpoint
CREATE INDEX "commercial_entries_employee_month_idx" ON "commercial_entries" USING btree ("employee_id","month");--> statement-breakpoint
ALTER TABLE "commercial_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commercial_entries" FROM anon, authenticated;
