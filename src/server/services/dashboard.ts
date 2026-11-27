// Dashboard and Integrations page data. Local DB only: never calls upstream, so it works with every service down.
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import {
  auditLog,
  operations,
  orders,
  payments,
  refunds,
  shipments,
  syncRuns,
  webhookEvents,
  WEBHOOK_STATUSES,
  workflowExecutions,
  workflows,
} from "@/server/db/schema";
import { listApprovals } from "./approvals";
import { getHealth } from "./health";
import { listOrders } from "./orders";
import { RESERVING_STATUSES } from "./refunds";

const RECENT = 10;

const countBy = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.n]));

// Cancelled orders holding a captured payment with nothing refunded (failed refunds don't count).
export function owedRefunds() {
  const rows = getDb()
    .select({
      orderId: orders.id,
      amountMinor: payments.amountMinor,
      pendingApproval: sql<number>`EXISTS (SELECT 1 FROM ${operations} o WHERE o.order_id = ${orders.id} AND o.type = 'refund'
        AND o.status IN (${sql.join(RESERVING_STATUSES.map((s) => sql`${s}`), sql`, `)}))`,
    })
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(
      and(
        eq(orders.status, "cancelled"),
        eq(payments.status, "captured"),
        sql`NOT EXISTS (SELECT 1 FROM ${refunds} r WHERE r.order_id = ${orders.id} AND r.status <> 'failed')`,
      ),
    )
    .orderBy(orders.id)
    .all()
    .map((r) => ({ ...r, pendingApproval: Boolean(r.pendingApproval) }));
  return { count: rows.length, totalMinor: rows.reduce((s, r) => s + r.amountMinor, 0), orders: rows };
}

// Shipped or delivered orders whose payment failed. Fix = support ticket; stays here until upstream shows it paid.
export function unpaidShipped() {
  const rows = getDb()
    .select({ orderId: orders.id, status: orders.status, amountMinor: orders.amountMinor })
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(and(inArray(orders.status, ["shipped", "delivered"]), eq(payments.status, "failed")))
    .orderBy(orders.id)
    .all();
  return { count: rows.length, totalMinor: rows.reduce((s, r) => s + r.amountMinor, 0), orders: rows };
}

export function getDashboard() {
  const db = getDb();
  const n = sql<number>`count(*)`;

  const ordersByStatus = countBy(db.select({ k: orders.status, n }).from(orders).groupBy(orders.status).all());
  const paymentsByStatus = countBy(db.select({ k: payments.status, n }).from(payments).groupBy(payments.status).all());
  const shipmentsByStatus = countBy(db.select({ k: shipments.status, n }).from(shipments).groupBy(shipments.status).all());

  const failedRefunds = db
    .select({ id: operations.id, orderId: operations.orderId, amountMinor: operations.amountMinor, error: operations.error, updatedAt: operations.updatedAt })
    .from(operations)
    .where(and(eq(operations.type, "refund"), eq(operations.status, "failed")))
    .orderBy(desc(operations.id))
    .all();
  const lookupErrors = db
    .select({ orderId: shipments.orderId, error: shipments.lookupError, at: shipments.lookupErrorAt })
    .from(shipments)
    .where(isNotNull(shipments.lookupError))
    .orderBy(shipments.orderId)
    .all();

  const pendingApprovals = listApprovals().filter((a) => a.status === "pending");

  return {
    orders: { total: Object.values(ordersByStatus).reduce((s, v) => s + v, 0), byStatus: ordersByStatus },
    moneyAtRisk: { owedRefunds: owedRefunds(), unpaidShipped: unpaidShipped() },
    paymentIssues: { failedPayments: paymentsByStatus.failed ?? 0, failedRefunds: { count: failedRefunds.length, items: failedRefunds } },
    shipmentIssues: { delayed: shipmentsByStatus.delayed ?? 0, lookupErrors: { count: lookupErrors.length, items: lookupErrors } },
    pendingApprovals: { count: pendingApprovals.length, items: pendingApprovals.slice(0, RECENT) },
    recentExecutions: db
      .select({
        id: workflowExecutions.id,
        workflow: workflows.name,
        eventId: workflowExecutions.eventId,
        orderId: workflowExecutions.orderId,
        outcome: workflowExecutions.outcome,
        result: workflowExecutions.result,
        error: workflowExecutions.error,
        ranAt: workflowExecutions.ranAt,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
      .orderBy(desc(workflowExecutions.id))
      .limit(RECENT)
      .all(),
    recentOperations: db.select().from(operations).orderBy(desc(operations.id)).limit(RECENT).all(),
    recentAudit: db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(RECENT).all(),
    localAhead: listOrders({ localAhead: true, page: 1, pageSize: 100 }).items,
    health: getHealth(),
  };
}

export type Dashboard = ReturnType<typeof getDashboard>;

// ---------- Integrations page ----------

export const EVENT_FILTER_STATUSES = [...WEBHOOK_STATUSES, "rejected"] as const;

export function listSyncRuns(limit = 50) {
  return getDb().select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(limit).all();
}

export interface EventRow {
  id: string;
  type: string;
  orderId: string | null;
  status: string;
  occurredAt: string | null;
  receivedAt: string;
  note: string | null;
}

// Stored webhook events, plus rejected ones (bad secret: never stored as events, only audited).
// NOTE: rejected rows come from audit_log; give them their own table if they need payload/filters by type.
export function listWebhookEvents(q: { status?: string; type?: string; limit?: number }): EventRow[] {
  const db = getDb();
  const limit = q.limit ?? 100;
  const stored: EventRow[] =
    q.status === "rejected"
      ? []
      : db
          .select({
            id: webhookEvents.eventId,
            type: webhookEvents.type,
            orderId: webhookEvents.orderId,
            status: webhookEvents.status,
            occurredAt: webhookEvents.occurredAt,
            receivedAt: webhookEvents.receivedAt,
            note: webhookEvents.note,
          })
          .from(webhookEvents)
          .where(
            and(
              q.status ? eq(webhookEvents.status, q.status as (typeof WEBHOOK_STATUSES)[number]) : undefined,
              q.type ? eq(webhookEvents.type, q.type) : undefined,
            ),
          )
          .orderBy(desc(webhookEvents.receivedAt))
          .limit(limit)
          .all();
  const rejected: EventRow[] =
    (q.status && q.status !== "rejected") || q.type
      ? []
      : db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, "webhook.rejected"))
          .orderBy(desc(auditLog.id))
          .limit(limit)
          .all()
          .map((a) => ({ id: `audit-${a.id}`, type: "-", orderId: null, status: "rejected", occurredAt: null, receivedAt: a.at, note: a.detail }));
  return [...stored, ...rejected].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
}

export function webhookEventTypes(): string[] {
  return getDb().selectDistinct({ t: webhookEvents.type }).from(webhookEvents).orderBy(webhookEvents.type).all().map((r) => r.t);
}
