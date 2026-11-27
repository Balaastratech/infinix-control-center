// Money: integer paise everywhere. Times: UTC ISO-8601 text.
// "Copy" tables mirror an upstream service. `status` is the effective value we show; `upstream_status` is
// the last value sync saw. They differ when a webhook is ahead of upstream ("local ahead", never silently
// overwritten: see CLAUDE.md "Agreed decisions").
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const ROLES = ["viewer", "operator", "manager"] as const;
export type Role = (typeof ROLES)[number];

export const OPERATION_TYPES = ["cancel", "refund", "reconcile"] as const;
// refund: requested -> pending_approval -> approved -> submitted -> succeeded | failed  (or -> rejected)
// cancel: requested -> submitted -> succeeded | failed  (no approval step; enforced by a CHECK below)
// reconcile: same path as cancel. Pushes a cancel we already have locally (webhook) to the Commerce API.
export const OPERATION_STATUSES = [
  "requested",
  "pending_approval",
  "approved",
  "submitted",
  "succeeded",
  "failed",
  "rejected",
] as const;
// Upstream value sets (docs/external-apis.md).
export const ORDER_STATUSES = ["processing", "shipped", "delivered", "cancelled"] as const;
export const PAYMENT_STATUSES = ["captured", "failed"] as const;
export const SHIPMENT_STATUSES = ["pending", "shipped", "delayed", "delivered", "cancelled"] as const;
export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export const WORKFLOW_TRIGGERS = ["payment.failed", "shipment.updated", "order.cancelled"] as const;
export const WORKFLOW_ACTIONS = ["create_ticket", "request_refund"] as const;
export const EXECUTION_OUTCOMES = ["skipped", "succeeded", "failed"] as const;
export const WEBHOOK_STATUSES = ["applied", "stale", "pending", "ignored"] as const;
export const EVENT_SOURCES = ["webhook", "app"] as const;
export const SERVICES = ["commerce", "payments", "shipping"] as const;
export const SYNC_STATUSES = ["running", "ok", "failed"] as const;

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} IN (${values.map((v) => `'${v}'`).join(", ")})`);

// ---------- ours ----------

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  () => [check("users_role_check", inList("role", ROLES))],
);

// ---------- upstream copies ----------

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(), // C-001
  name: text("name").notNull(),
  email: text("email").notNull(),
  syncedAt: text("synced_at"),
});

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(), // NC-1001
    customerId: text("customer_id").notNull(),
    status: text("status").notNull(),
    upstreamStatus: text("upstream_status"),
    localEventAt: text("local_event_at"), // occurred_at of the webhook that set `status`; null = follows upstream
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    createdAt: text("created_at").notNull(),
    channel: text("channel"),
    localUpdatedAt: text("local_updated_at").notNull().default(now),
    syncedAt: text("synced_at"),
  },
  (t) => [
    index("orders_status_idx").on(t.status),
    index("orders_customer_idx").on(t.customerId),
    check("orders_amount_check", sql`${t.amountMinor} >= 0`),
  ],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(), // P-001
    orderId: text("order_id").notNull().unique(),
    status: text("status").notNull(),
    upstreamStatus: text("upstream_status"),
    localEventAt: text("local_event_at"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    syncedAt: text("synced_at"),
  },
  (t) => [check("payments_amount_check", sql`${t.amountMinor} >= 0`)],
);

export const shipments = sqliteTable("shipments", {
  id: text("id").primaryKey(), // S-001
  orderId: text("order_id").notNull().unique(),
  status: text("status").notNull(),
  updatedAt: text("updated_at").notNull(), // effective; webhook events compare their occurred_at with this
  upstreamStatus: text("upstream_status"),
  upstreamUpdatedAt: text("upstream_updated_at"),
  syncedAt: text("synced_at"),
  // Last failed single-shipment lookup (e.g. NC-1012's permanent 503); cleared by the next successful lookup.
  lookupError: text("lookup_error"),
  lookupErrorAt: text("lookup_error_at"),
});

// Upstream refunds (R-…). Payment rows never change upstream, so "refunded so far" is summed from here.
export const refunds = sqliteTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(), // succeeded | failed
    operationId: integer("operation_id").references(() => operations.id),
    missingUpstream: integer("missing_upstream", { mode: "boolean" }).notNull().default(false), // mock restarted
    createdAt: text("created_at").notNull().default(now),
    syncedAt: text("synced_at"),
  },
  (t) => [index("refunds_order_idx").on(t.orderId), check("refunds_amount_check", sql`${t.amountMinor} > 0`)],
);

export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(), // T-…
    orderId: text("order_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    workflowExecutionId: integer("workflow_execution_id").references(() => workflowExecutions.id),
    createdByLabel: text("created_by_label"),
    missingUpstream: integer("missing_upstream", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
    syncedAt: text("synced_at"),
  },
  (t) => [index("tickets_order_idx").on(t.orderId)],
);

// ---------- operations and approvals ----------

export const operations = sqliteTable(
  "operations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: OPERATION_TYPES }).notNull(),
    orderId: text("order_id").notNull(),
    amountMinor: integer("amount_minor"), // refund only
    status: text("status", { enum: OPERATION_STATUSES }).notNull().default("requested"),
    externalId: text("external_id"), // R-… for refunds
    error: text("error"),
    requestedByUserId: integer("requested_by_user_id").references(() => users.id), // null = system/workflow
    requestedByLabel: text("requested_by_label").notNull(), // email or "workflow:<name>"
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("operations_order_idx").on(t.orderId),
    index("operations_status_idx").on(t.status),
    check("operations_type_check", inList("type", OPERATION_TYPES)),
    check("operations_status_check", inList("status", OPERATION_STATUSES)),
    check(
      "operations_amount_check",
      sql`(${t.type} IN ('cancel', 'reconcile') AND ${t.amountMinor} IS NULL) OR (${t.type} = 'refund' AND ${t.amountMinor} > 0)`,
    ),
    check(
      "operations_cancel_path_check",
      sql`NOT (${t.type} <> 'refund' AND ${t.status} IN ('pending_approval', 'approved', 'rejected'))`,
    ),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    operationId: integer("operation_id")
      .notNull()
      .unique()
      .references(() => operations.id),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
    requestedByUserId: integer("requested_by_user_id").references(() => users.id),
    requestedByLabel: text("requested_by_label").notNull(),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id),
    decidedAt: text("decided_at"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("approvals_status_idx").on(t.status),
    check("approvals_status_check", inList("status", APPROVAL_STATUSES)),
    // Last line of defence for "never approve your own request" (the service checks first).
    check(
      "approvals_not_own_check",
      sql`${t.decidedByUserId} IS NULL OR ${t.requestedByUserId} IS NULL OR ${t.decidedByUserId} <> ${t.requestedByUserId}`,
    ),
  ],
);

// ---------- workflows ----------

export const workflows = sqliteTable(
  "workflows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    trigger: text("trigger", { enum: WORKFLOW_TRIGGERS }).notNull(),
    conditions: text("conditions").notNull(), // JSON: [{ field, op, value }], at least one
    action: text("action", { enum: WORKFLOW_ACTIONS }).notNull(),
    actionParams: text("action_params").notNull().default("{}"), // JSON, e.g. { reason } or { amount_minor }
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  () => [
    check("workflows_trigger_check", inList("trigger", WORKFLOW_TRIGGERS)),
    check("workflows_action_check", inList("action", WORKFLOW_ACTIONS)),
  ],
);

export const workflowExecutions = sqliteTable(
  "workflow_executions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workflowId: integer("workflow_id")
      .notNull()
      .references(() => workflows.id),
    eventId: text("event_id").notNull(),
    orderId: text("order_id"),
    matched: integer("matched", { mode: "boolean" }).notNull(),
    outcome: text("outcome", { enum: EXECUTION_OUTCOMES }).notNull(),
    result: text("result"),
    error: text("error"),
    ranAt: text("ran_at").notNull().default(now),
  },
  (t) => [
    // One run per workflow per event: a replayed event can never fire a workflow twice.
    uniqueIndex("workflow_executions_once").on(t.workflowId, t.eventId),
    index("workflow_executions_ran_idx").on(t.ranAt),
    check("workflow_executions_outcome_check", inList("outcome", EXECUTION_OUTCOMES)),
  ],
);

// ---------- integration ----------

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    eventId: text("event_id").primaryKey(), // UNIQUE: insert first, conflict = duplicate -> 200, no change
    source: text("source", { enum: EVENT_SOURCES }).notNull().default("webhook"), // "app" = our own cancel
    type: text("type").notNull(),
    orderId: text("order_id"),
    occurredAt: text("occurred_at").notNull(),
    payload: text("payload").notNull(),
    status: text("status", { enum: WEBHOOK_STATUSES }).notNull(),
    note: text("note"),
    receivedAt: text("received_at").notNull().default(now),
  },
  (t) => [
    index("webhook_events_status_idx").on(t.status),
    check("webhook_events_status_check", inList("status", WEBHOOK_STATUSES)),
    check("webhook_events_source_check", inList("source", EVENT_SOURCES)),
  ],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    service: text("service", { enum: SERVICES }).notNull(),
    startedAt: text("started_at").notNull().default(now),
    finishedAt: text("finished_at"),
    status: text("status", { enum: SYNC_STATUSES }).notNull().default("running"),
    counts: text("counts"), // JSON
    error: text("error"),
  },
  (t) => [
    index("sync_runs_service_idx").on(t.service, t.startedAt),
    check("sync_runs_service_check", inList("service", SERVICES)),
    check("sync_runs_status_check", inList("status", SYNC_STATUSES)),
  ],
);

export const serviceHealth = sqliteTable(
  "service_health",
  {
    service: text("service", { enum: SERVICES }).primaryKey(),
    lastOkAt: text("last_ok_at"),
    lastErrorAt: text("last_error_at"),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    down: integer("down", { mode: "boolean" }).notNull().default(false),
  },
  () => [check("service_health_service_check", inList("service", SERVICES))],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull().default(now),
    userId: integer("user_id").references(() => users.id), // null = system/workflow
    actorLabel: text("actor_label").notNull(), // email or "workflow:<name>" or "system"
    role: text("role"),
    action: text("action").notNull(),
    target: text("target"),
    outcome: text("outcome").notNull(),
    detail: text("detail"),
  },
  (t) => [index("audit_log_at_idx").on(t.at)],
);

// ---------- assistant (docs/assistant-design.md) ----------
// Conversations are private: every query filters on (owner_user_id, owner_device). Only services/conversations.ts
// touches these tables.

export const ASSISTANT_MODES = ["parser", "ai", "fallback"] as const;

export const assistantConversations = sqliteTable(
  "assistant_conversations",
  {
    id: text("id").primaryKey(), // random UUID
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => users.id),
    ownerDevice: text("owner_device").notNull(),
    title: text("title").notNull(),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("assistant_conversations_owner_idx").on(t.ownerUserId, t.ownerDevice, t.updatedAt)],
);

export const assistantMessages = sqliteTable(
  "assistant_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    text: text("text").notNull(),
    mode: text("mode", { enum: ASSISTANT_MODES }),
    intent: text("intent"),
    understood: text("understood"),
    blocks: text("blocks"), // JSON Block[]
    context: text("context"), // JSON follow-up context
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("assistant_messages_conversation_idx").on(t.conversationId, t.id)],
);

export const assistantToolCalls = sqliteTable("assistant_tool_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => assistantConversations.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["parser", "ai"] }).notNull(),
  tool: text("tool").notNull(),
  input: text("input"),
  outcome: text("outcome").notNull(), // ok | invalid | denied | error | not_allowed
  ms: integer("ms").notNull().default(0),
  at: text("at").notNull().default(now),
});

export const assistantUsage = sqliteTable(
  "assistant_usage",
  {
    day: text("day").notNull(), // IST date
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    questions: integer("questions").notNull().default(0),
    aiQuestions: integer("ai_questions").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
  },
  (t) => [uniqueIndex("assistant_usage_day_user").on(t.day, t.userId)],
);
