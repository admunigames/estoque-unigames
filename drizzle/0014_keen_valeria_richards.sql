CREATE TABLE "operational_routine_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"origin_date" text NOT NULL,
	"due_date" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"completed_by" text DEFAULT '' NOT NULL,
	"completed_by_name" text DEFAULT '' NOT NULL,
	"completed_at" text DEFAULT '' NOT NULL,
	"carried_over" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_routines" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"weekday" integer NOT NULL,
	"scope" text DEFAULT 'store' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operational_routine_tasks_origin_unique" ON "operational_routine_tasks" USING btree ("routine_id","origin_date","company_id");--> statement-breakpoint
CREATE INDEX "operational_routine_tasks_due_company_idx" ON "operational_routine_tasks" USING btree ("due_date","company_id");--> statement-breakpoint
CREATE INDEX "operational_routines_weekday_idx" ON "operational_routines" USING btree ("weekday");--> statement-breakpoint
CREATE INDEX "operational_routines_created_by_idx" ON "operational_routines" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "operational_routine_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operational_routines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "operational_routine_tasks" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "operational_routines" FROM anon, authenticated;