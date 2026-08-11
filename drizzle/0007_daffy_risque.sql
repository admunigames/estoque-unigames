ALTER TABLE "supply_request_items" ADD COLUMN "quantity_separated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "separated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "separated_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "separated_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "separated_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "received_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "received_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "received_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_request_items" ADD COLUMN "received_at" text DEFAULT '' NOT NULL;