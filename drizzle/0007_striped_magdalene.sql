ALTER TABLE `mission_completions` ADD `status` text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `mission_completions` ADD `updated_at` text DEFAULT '' NOT NULL;
