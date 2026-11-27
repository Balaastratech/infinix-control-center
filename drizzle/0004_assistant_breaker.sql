CREATE TABLE `assistant_ai_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`category` text,
	`paused_until` text,
	`last_error_at` text,
	`last_error_category` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assistant_counters` (
	`day` text NOT NULL,
	`key` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_counters_day_key` ON `assistant_counters` (`day`,`key`);