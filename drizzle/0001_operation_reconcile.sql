-- Hand edit of the drizzle-kit output. The migrator runs in one transaction, where PRAGMA foreign_keys=OFF is ignored,
-- so DROP TABLE operations fails while approvals/refunds point at it (deferred FKs don't help: SQLite doesn't recount
-- after the rename). Park the child rows, rebuild operations, put them back. Same ids, nothing lost.
CREATE TEMP TABLE `_approvals` AS SELECT * FROM `approvals`;--> statement-breakpoint
CREATE TEMP TABLE `_refunds` AS SELECT * FROM `refunds`;--> statement-breakpoint
DELETE FROM `approvals`;--> statement-breakpoint
DELETE FROM `refunds`;--> statement-breakpoint
CREATE TABLE `__new_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`order_id` text NOT NULL,
	`amount_minor` integer,
	`status` text DEFAULT 'requested' NOT NULL,
	`external_id` text,
	`error` text,
	`requested_by_user_id` integer,
	`requested_by_label` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "operations_type_check" CHECK(type IN ('cancel', 'refund', 'reconcile')),
	CONSTRAINT "operations_status_check" CHECK(status IN ('requested', 'pending_approval', 'approved', 'submitted', 'succeeded', 'failed', 'rejected')),
	CONSTRAINT "operations_amount_check" CHECK(("__new_operations"."type" IN ('cancel', 'reconcile') AND "__new_operations"."amount_minor" IS NULL) OR ("__new_operations"."type" = 'refund' AND "__new_operations"."amount_minor" > 0)),
	CONSTRAINT "operations_cancel_path_check" CHECK(NOT ("__new_operations"."type" <> 'refund' AND "__new_operations"."status" IN ('pending_approval', 'approved', 'rejected')))
);
--> statement-breakpoint
INSERT INTO `__new_operations`("id", "type", "order_id", "amount_minor", "status", "external_id", "error", "requested_by_user_id", "requested_by_label", "created_at", "updated_at") SELECT "id", "type", "order_id", "amount_minor", "status", "external_id", "error", "requested_by_user_id", "requested_by_label", "created_at", "updated_at" FROM `operations`;--> statement-breakpoint
DROP TABLE `operations`;--> statement-breakpoint
ALTER TABLE `__new_operations` RENAME TO `operations`;--> statement-breakpoint
INSERT INTO `approvals` SELECT * FROM `_approvals`;--> statement-breakpoint
INSERT INTO `refunds` SELECT * FROM `_refunds`;--> statement-breakpoint
DROP TABLE `_approvals`;--> statement-breakpoint
DROP TABLE `_refunds`;--> statement-breakpoint
CREATE INDEX `operations_order_idx` ON `operations` (`order_id`);--> statement-breakpoint
CREATE INDEX `operations_status_idx` ON `operations` (`status`);