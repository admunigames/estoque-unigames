ALTER TABLE "loan_requests" ADD COLUMN "returned_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_requests" ADD COLUMN "returned_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_requests" ADD COLUMN "returned_at" text DEFAULT '' NOT NULL;