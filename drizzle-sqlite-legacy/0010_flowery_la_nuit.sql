CREATE TABLE `supply_items` (
	`id` text PRIMARY KEY NOT NULL,
	`product_name` text NOT NULL,
	`quantity_text` text NOT NULL,
	`company_id` text NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by` text NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`received_by` text DEFAULT '' NOT NULL,
	`received_by_name` text DEFAULT '' NOT NULL,
	`received_at` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supply_items_company_status_created_idx` ON `supply_items` (`company_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `supply_items_status_updated_idx` ON `supply_items` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `supply_request_events` (
	`id` text PRIMARY KEY NOT NULL,
	`supply_item_id` text NOT NULL,
	`company_id` text NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`request_date` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_by_name` text DEFAULT '' NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supply_request_events_item_date_unique` ON `supply_request_events` (`supply_item_id`,`request_date`);--> statement-breakpoint
CREATE INDEX `supply_request_events_company_date_idx` ON `supply_request_events` (`company_id`,`request_date`);--> statement-breakpoint
CREATE INDEX `supply_request_events_item_requested_idx` ON `supply_request_events` (`supply_item_id`,`requested_at`);--> statement-breakpoint
PRAGMA optimize;
