CREATE TABLE `mission_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`occurrence_date` text NOT NULL,
	`company_id` text NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`completed_by` text NOT NULL,
	`completed_by_name` text DEFAULT '' NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mission_completions_occurrence_unique` ON `mission_completions` (`mission_id`,`occurrence_date`,`company_id`);--> statement-breakpoint
CREATE INDEX `mission_completions_date_company_idx` ON `mission_completions` (`occurrence_date`,`company_id`);--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT 'store' NOT NULL,
	`company_id` text DEFAULT '' NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`frequency` text DEFAULT 'once' NOT NULL,
	`start_date` text NOT NULL,
	`due_time` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `missions_scope_company_date_idx` ON `missions` (`scope`,`company_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `missions_created_by_idx` ON `missions` (`created_by`);