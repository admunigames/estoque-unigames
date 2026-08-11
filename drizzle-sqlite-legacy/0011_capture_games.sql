ALTER TABLE `captured_products` ADD `game_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `captured_products` ADD `game_console` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `captured_products` ADD `game_condition` text DEFAULT '' NOT NULL;
--> statement-breakpoint
PRAGMA optimize;
