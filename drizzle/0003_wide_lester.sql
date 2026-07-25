CREATE INDEX `password_reset_requests_user_status_idx` ON `password_reset_requests` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `purchase_delivery_records_purchase_idx` ON `purchase_delivery_records` (`purchase_id`,`delivered_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_delivery_log_task_unique` ON `push_delivery_log` (`user_id`,`task_key`,`task_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);