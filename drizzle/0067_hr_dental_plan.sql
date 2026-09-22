CREATE TABLE "hr_dental_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text DEFAULT '' NOT NULL,
	"employee_name" text NOT NULL,
	"unit_name" text DEFAULT '' NOT NULL,
	"cnpj" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'faltando_incluir_excluir' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"process_number" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_dental_plan_employee_idx" ON "hr_dental_plan" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "hr_dental_plan_status_idx" ON "hr_dental_plan" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hr_dental_plan_reason_idx" ON "hr_dental_plan" USING btree ("reason");--> statement-breakpoint
ALTER TABLE "hr_dental_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "hr_dental_plan" FROM anon, authenticated;
