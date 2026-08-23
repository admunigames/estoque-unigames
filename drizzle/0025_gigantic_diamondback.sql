CREATE TABLE "loan_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"imei" text DEFAULT '' NOT NULL,
	"has_defect" integer DEFAULT 0 NOT NULL,
	"defect_description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"current_company_id" text DEFAULT '' NOT NULL,
	"current_company_name" text DEFAULT '' NOT NULL,
	"loaned_at" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_request_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"message" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text DEFAULT '' NOT NULL,
	"company_id" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"responsible_name" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"separated_by" text DEFAULT '' NOT NULL,
	"separated_by_name" text DEFAULT '' NOT NULL,
	"separated_at" text DEFAULT '' NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "loan_devices_status_idx" ON "loan_devices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "loan_devices_current_company_idx" ON "loan_devices" USING btree ("current_company_id");--> statement-breakpoint
CREATE INDEX "loan_request_updates_request_idx" ON "loan_request_updates" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "loan_requests_company_status_created_idx" ON "loan_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "loan_requests_device_idx" ON "loan_requests" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "loan_requests_status_created_idx" ON "loan_requests" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "loan_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loan_request_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loan_requests" ENABLE ROW LEVEL SECURITY;