CREATE TABLE "app_users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"access_group" text DEFAULT 'operator' NOT NULL,
	"permissions_json" text DEFAULT '[]' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "app_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "captured_products" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"product_name" text NOT NULL,
	"serial_number" text NOT NULL,
	"defects" text NOT NULL,
	"color" text NOT NULL,
	"origin_company_id" text NOT NULL,
	"origin_company_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"destination_company_id" text DEFAULT '' NOT NULL,
	"destination_company_name" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"received_by" text DEFAULT '' NOT NULL,
	"received_by_name" text DEFAULT '' NOT NULL,
	"received_at" text DEFAULT '' NOT NULL,
	"ready_by" text DEFAULT '' NOT NULL,
	"ready_by_name" text DEFAULT '' NOT NULL,
	"ready_at" text DEFAULT '' NOT NULL,
	"assigned_by" text DEFAULT '' NOT NULL,
	"assigned_by_name" text DEFAULT '' NOT NULL,
	"assigned_at" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "defective_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"quantity" integer NOT NULL,
	"product_name" text NOT NULL,
	"defect" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"completed_by" text DEFAULT '' NOT NULL,
	"completed_by_name" text DEFAULT '' NOT NULL,
	"completed_at" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instructions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"due_date" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_completions" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"occurrence_date" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"completed_by" text NOT NULL,
	"completed_by_name" text DEFAULT '' NOT NULL,
	"completed_at" text DEFAULT now()::text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"updated_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"scope" text DEFAULT 'store' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"frequency" text DEFAULT 'once' NOT NULL,
	"start_date" text NOT NULL,
	"due_time" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" text DEFAULT now()::text NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE TABLE "purchase_delivery_records" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL,
	"delivered_at" text NOT NULL,
	"percentage" integer DEFAULT 0 NOT NULL,
	"quantity_note" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_delivery_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_key" text NOT NULL,
	"task_id" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "shared_state" (
	"state_key" text PRIMARY KEY NOT NULL,
	"value_json" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_items" (
	"id" text PRIMARY KEY NOT NULL,
	"product_name" text NOT NULL,
	"quantity_text" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"received_by" text DEFAULT '' NOT NULL,
	"received_by_name" text DEFAULT '' NOT NULL,
	"received_at" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"supply_item_id" text NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"request_date" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_by_name" text DEFAULT '' NOT NULL,
	"requested_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'dark' NOT NULL,
	"accent_color" text DEFAULT '#4f86bd' NOT NULL,
	"logo_data_url" text DEFAULT '' NOT NULL,
	"compact_mobile" integer DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "captured_products_status_updated_idx" ON "captured_products" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "captured_products_origin_created_idx" ON "captured_products" USING btree ("origin_company_id","created_at");--> statement-breakpoint
CREATE INDEX "defective_outputs_status_created_idx" ON "defective_outputs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "defective_outputs_company_created_idx" ON "defective_outputs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "instructions_due_date_created_idx" ON "instructions" USING btree ("due_date","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_completions_occurrence_unique" ON "mission_completions" USING btree ("mission_id","occurrence_date","company_id");--> statement-breakpoint
CREATE INDEX "mission_completions_date_company_idx" ON "mission_completions" USING btree ("occurrence_date","company_id");--> statement-breakpoint
CREATE INDEX "missions_scope_company_date_idx" ON "missions" USING btree ("scope","company_id","start_date");--> statement-breakpoint
CREATE INDEX "missions_created_by_idx" ON "missions" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "password_reset_requests_user_status_idx" ON "password_reset_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "purchase_delivery_records_purchase_idx" ON "purchase_delivery_records" USING btree ("purchase_id","delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_delivery_log_task_unique" ON "push_delivery_log" USING btree ("user_id","task_key","task_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "supply_items_company_status_created_idx" ON "supply_items" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "supply_items_status_updated_idx" ON "supply_items" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_request_events_item_date_unique" ON "supply_request_events" USING btree ("supply_item_id","request_date");--> statement-breakpoint
CREATE INDEX "supply_request_events_company_date_idx" ON "supply_request_events" USING btree ("company_id","request_date");--> statement-breakpoint
CREATE INDEX "supply_request_events_item_requested_idx" ON "supply_request_events" USING btree ("supply_item_id","requested_at");