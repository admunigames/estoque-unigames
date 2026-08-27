CREATE TABLE "finance_acquirers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_machines" (
	"id" text PRIMARY KEY NOT NULL,
	"acquirer_id" text DEFAULT '' NOT NULL,
	"acquirer_name" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"serial" text DEFAULT '' NOT NULL,
	"establishment_code" text DEFAULT '' NOT NULL,
	"terminal" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"installed_at" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_card_machine_events" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"kind" text NOT NULL,
	"event_date" text DEFAULT '' NOT NULL,
	"from_company_id" text DEFAULT '' NOT NULL,
	"from_company_name" text DEFAULT '' NOT NULL,
	"to_company_id" text DEFAULT '' NOT NULL,
	"to_company_name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "finance_acquirers_company_idx" ON "finance_acquirers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "finance_acquirers_status_idx" ON "finance_acquirers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "finance_card_machines_company_status_idx" ON "finance_card_machines" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "finance_card_machines_acquirer_idx" ON "finance_card_machines" USING btree ("acquirer_id");--> statement-breakpoint
CREATE INDEX "finance_card_machines_serial_idx" ON "finance_card_machines" USING btree ("serial");--> statement-breakpoint
CREATE INDEX "finance_card_machine_events_machine_idx" ON "finance_card_machine_events" USING btree ("machine_id","event_date");
