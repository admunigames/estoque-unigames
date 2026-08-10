CREATE TABLE `shared_state` (
	`state_key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

