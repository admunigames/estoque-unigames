CREATE TABLE "finance_mall_declaration_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"declaration_id" text NOT NULL,
	"file_name" text NOT NULL,
	"r2_key" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text DEFAULT '' NOT NULL,
	"uploaded_by_name" text DEFAULT '' NOT NULL,
	"uploaded_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_mall_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"mall_name" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"competence_month" text NOT NULL,
	"real_revenue_cents" integer DEFAULT 0 NOT NULL,
	"avg_declared_cents" integer DEFAULT 0 NOT NULL,
	"suggested_declared_cents" integer DEFAULT 0 NOT NULL,
	"declared_cents" integer DEFAULT 0 NOT NULL,
	"declaration_date" text DEFAULT '' NOT NULL,
	"contract_percent_bps" integer DEFAULT 0 NOT NULL,
	"minimum_rent_cents" integer DEFAULT 0 NOT NULL,
	"percentage_rent_cents" integer DEFAULT 0 NOT NULL,
	"percentage_rent_paid" integer DEFAULT 0 NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_phone_recharge_events" (
	"id" text PRIMARY KEY NOT NULL,
	"recharge_id" text NOT NULL,
	"recharge_date" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_phone_recharges" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_number" text DEFAULT '' NOT NULL,
	"carrier" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"responsible_name" text DEFAULT '' NOT NULL,
	"last_amount_cents" integer DEFAULT 0 NOT NULL,
	"last_recharge_date" text DEFAULT '' NOT NULL,
	"next_recharge_date" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_replacement_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_date" text NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"product" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"sector" text DEFAULT 'outros' NOT NULL,
	"responsible_name" text DEFAULT '' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'saida' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"expense_id" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "finance_mall_declaration_attachments_declaration_idx" ON "finance_mall_declaration_attachments" USING btree ("declaration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_mall_declarations_unique" ON "finance_mall_declarations" USING btree ("company_id","mall_name","competence_month");--> statement-breakpoint
CREATE INDEX "finance_mall_declarations_competence_idx" ON "finance_mall_declarations" USING btree ("competence_month");--> statement-breakpoint
CREATE INDEX "finance_phone_recharge_events_recharge_idx" ON "finance_phone_recharge_events" USING btree ("recharge_id","recharge_date");--> statement-breakpoint
CREATE INDEX "finance_phone_recharges_next_idx" ON "finance_phone_recharges" USING btree ("next_recharge_date");--> statement-breakpoint
CREATE INDEX "finance_phone_recharges_company_idx" ON "finance_phone_recharges" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "finance_replacement_entries_company_date_idx" ON "finance_replacement_entries" USING btree ("company_id","entry_date");--> statement-breakpoint
CREATE INDEX "finance_replacement_entries_sector_idx" ON "finance_replacement_entries" USING btree ("sector");--> statement-breakpoint
CREATE INDEX "finance_replacement_entries_kind_idx" ON "finance_replacement_entries" USING btree ("kind");