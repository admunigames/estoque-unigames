CREATE TABLE `captured_products` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`product_name` text NOT NULL,
	`serial_number` text NOT NULL,
	`defects` text NOT NULL,
	`color` text NOT NULL,
	`origin_company_id` text NOT NULL,
	`origin_company_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`destination_company_id` text DEFAULT '' NOT NULL,
	`destination_company_name` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`received_by` text DEFAULT '' NOT NULL,
	`received_by_name` text DEFAULT '' NOT NULL,
	`received_at` text DEFAULT '' NOT NULL,
	`ready_by` text DEFAULT '' NOT NULL,
	`ready_by_name` text DEFAULT '' NOT NULL,
	`ready_at` text DEFAULT '' NOT NULL,
	`assigned_by` text DEFAULT '' NOT NULL,
	`assigned_by_name` text DEFAULT '' NOT NULL,
	`assigned_at` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `captured_products_status_updated_idx` ON `captured_products` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `captured_products_origin_created_idx` ON `captured_products` (`origin_company_id`,`created_at`);