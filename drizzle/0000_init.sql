CREATE TABLE `approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by_user_id` integer,
	`requested_by_label` text NOT NULL,
	`decided_by_user_id` integer,
	`decided_at` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_status_check" CHECK(status IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "approvals_not_own_check" CHECK("approvals"."decided_by_user_id" IS NULL OR "approvals"."requested_by_user_id" IS NULL OR "approvals"."decided_by_user_id" <> "approvals"."requested_by_user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_operation_id_unique` ON `approvals` (`operation_id`);--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`user_id` integer,
	`actor_label` text NOT NULL,
	`role` text,
	`action` text NOT NULL,
	`target` text,
	`outcome` text NOT NULL,
	`detail` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`synced_at` text
);
--> statement-breakpoint
CREATE TABLE `operations` (
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
	CONSTRAINT "operations_type_check" CHECK(type IN ('cancel', 'refund')),
	CONSTRAINT "operations_status_check" CHECK(status IN ('requested', 'pending_approval', 'approved', 'submitted', 'succeeded', 'failed', 'rejected')),
	CONSTRAINT "operations_amount_check" CHECK(("operations"."type" = 'cancel' AND "operations"."amount_minor" IS NULL) OR ("operations"."type" = 'refund' AND "operations"."amount_minor" > 0)),
	CONSTRAINT "operations_cancel_path_check" CHECK(NOT ("operations"."type" = 'cancel' AND "operations"."status" IN ('pending_approval', 'approved', 'rejected')))
);
--> statement-breakpoint
CREATE INDEX `operations_order_idx` ON `operations` (`order_id`);--> statement-breakpoint
CREATE INDEX `operations_status_idx` ON `operations` (`status`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`upstream_status` text,
	`local_event_at` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`created_at` text NOT NULL,
	`channel` text,
	`local_updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`synced_at` text,
	CONSTRAINT "orders_amount_check" CHECK("orders"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text NOT NULL,
	`upstream_status` text,
	`local_event_at` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`synced_at` text,
	CONSTRAINT "payments_amount_check" CHECK("payments"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_order_id_unique` ON `payments` (`order_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`operation_id` integer,
	`missing_upstream` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`synced_at` text,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refunds_amount_check" CHECK("refunds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE TABLE `service_health` (
	`service` text PRIMARY KEY NOT NULL,
	`last_ok_at` text,
	`last_error_at` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`down` integer DEFAULT false NOT NULL,
	CONSTRAINT "service_health_service_check" CHECK(service IN ('commerce', 'payments', 'shipping'))
);
--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`upstream_status` text,
	`upstream_updated_at` text,
	`synced_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_order_id_unique` ON `shipments` (`order_id`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service` text NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`counts` text,
	`error` text,
	CONSTRAINT "sync_runs_service_check" CHECK(service IN ('commerce', 'payments', 'shipping')),
	CONSTRAINT "sync_runs_status_check" CHECK(status IN ('running', 'ok', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `sync_runs_service_idx` ON `sync_runs` (`service`,`started_at`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`workflow_execution_id` integer,
	`created_by_label` text,
	`missing_upstream` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`synced_at` text,
	FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tickets_order_idx` ON `tickets` (`order_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "users_role_check" CHECK(role IN ('viewer', 'operator', 'manager'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source` text DEFAULT 'webhook' NOT NULL,
	`type` text NOT NULL,
	`order_id` text,
	`occurred_at` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "webhook_events_status_check" CHECK(status IN ('applied', 'stale', 'pending', 'ignored')),
	CONSTRAINT "webhook_events_source_check" CHECK(source IN ('webhook', 'app'))
);
--> statement-breakpoint
CREATE INDEX `webhook_events_status_idx` ON `webhook_events` (`status`);--> statement-breakpoint
CREATE TABLE `workflow_executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_id` integer NOT NULL,
	`event_id` text NOT NULL,
	`order_id` text,
	`matched` integer NOT NULL,
	`outcome` text NOT NULL,
	`result` text,
	`error` text,
	`ran_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_executions_outcome_check" CHECK(outcome IN ('skipped', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_executions_once` ON `workflow_executions` (`workflow_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `workflow_executions_ran_idx` ON `workflow_executions` (`ran_at`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`conditions` text NOT NULL,
	`action` text NOT NULL,
	`action_params` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflows_trigger_check" CHECK(trigger IN ('payment.failed', 'shipment.updated', 'order.cancelled')),
	CONSTRAINT "workflows_action_check" CHECK(action IN ('create_ticket', 'request_refund'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_name_unique` ON `workflows` (`name`);