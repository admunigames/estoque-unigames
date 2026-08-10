CREATE TABLE `password_reset_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `purchase_delivery_records` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`delivered_at` text NOT NULL,
	`percentage` integer DEFAULT 0 NOT NULL,
	`quantity_note` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_delivery_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_key` text NOT NULL,
	`task_id` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'dark' NOT NULL,
	`accent_color` text DEFAULT '#4f86bd' NOT NULL,
	`logo_data_url` text DEFAULT '' NOT NULL,
	`compact_mobile` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_users` ADD `email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_users` ADD `access_group` text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
UPDATE `app_users` SET `access_group` = 'custom';
