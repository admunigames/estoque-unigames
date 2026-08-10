CREATE TABLE `defective_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`quantity` integer NOT NULL,
	`product_name` text NOT NULL,
	`defect` text NOT NULL,
	`company_id` text NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`created_by` text NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_by` text DEFAULT '' NOT NULL,
	`completed_by_name` text DEFAULT '' NOT NULL,
	`completed_at` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `defective_outputs_status_created_idx` ON `defective_outputs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `defective_outputs_company_created_idx` ON `defective_outputs` (`company_id`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
