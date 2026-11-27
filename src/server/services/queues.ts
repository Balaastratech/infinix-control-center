// Team work queues: what each team should act on next, built only from the existing services and local data.
// Every item links somewhere and names the next action. Counts are the list lengths.
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/server/db";
import { customers, operations, orders, SERVICES, shipments, syncRuns } from "@/server/db/schema";
import { formatMoney } from "@/lib/format";
import { SERVICE_LABELS } from "@/lib/labels";
import { listApprovals } from "./approvals";
import { owedRefunds, unpaidShipped } from "./dashboard";
import { listOrders } from "./orders";
import { listTickets } from "./tickets";

export interface QueueItem {
  key: string;
  kind: string; // e.g. "delayed_shipment", "owed_refund"
  title: string;
  detail: string | null;
  href: string;
  nextAction: string;
  orderId: string | null;
  customerId: string | null;
  customerName: string | null;
  amountMinor: number | null;
  at: string | null;
  canCreateTicket?: boolean; // the UI shows a "Create ticket" button
}

export const QUEUE_NAMES = ["operations", "finance", "support"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
const RECENT_WORKFLOW_TICKETS = 10;

function customerOf(): (orderId: string) => { customerId: string | null; customerName: string | null } {
  const rows = getDb()
    .select({ orderId: orders.id, customerId: customers.id, customerName: customers.name })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .all();
  const map = new Map(rows.map((r) => [r.orderId, r]));
  return (orderId) => ({ customerId: map.get(orderId)?.customerId ?? null, customerName: map.get(orderId)?.customerName ?? null });
}

type Who = ReturnType<typeof customerOf>;
const orderItem = (who: Who, orderId: string, rest: Omit<QueueItem, "orderId" | "customerId" | "customerName" | "href"> & { href?: string }): QueueItem => ({
  orderId,
  href: `/orders/${orderId}`,
  ...who(orderId),
  ...rest,
});

function operationsQueue(who: Who): QueueItem[] {
  const db = getDb();
  const delayed = db.select().from(shipments).where(eq(shipments.status, "delayed")).orderBy(shipments.orderId).all();
  const lookupErrors = db.select().from(shipments).where(isNotNull(shipments.lookupError)).orderBy(shipments.orderId).all();
  const ahead = listOrders({ localAhead: true, page: 1, pageSize: 1000 }).items;
  const failedRuns = SERVICES.flatMap((service) => {
    const run = db.select().from(syncRuns).where(eq(syncRuns.service, service)).orderBy(desc(syncRuns.id)).limit(1).get();
    return run?.status === "failed" ? [run] : [];
  });
  return [
    ...delayed.map((s) =>
      orderItem(who, s.orderId, { key: `delayed-${s.id}`, kind: "delayed_shipment", title: `Shipment ${s.id} delayed`, detail: null, nextAction: "Chase the carrier; tell the customer", amountMinor: null, at: s.updatedAt }),
    ),
    ...lookupErrors.map((s) =>
      orderItem(who, s.orderId, { key: `lookup-${s.id}`, kind: "lookup_error", title: `Shipment lookup failing`, detail: s.lookupError, nextAction: "Check the Shipping API, then reload the order", amountMinor: null, at: s.lookupErrorAt }),
    ),
    ...ahead.map((o) => {
      const cancelAhead = o.status === "cancelled" && o.upstreamStatus === "processing";
      return orderItem(who, o.id, {
        key: `ahead-${o.id}`,
        kind: "local_ahead",
        title: "Local ahead of upstream",
        detail: o.status !== o.upstreamStatus ? `order ${o.status} here, ${o.upstreamStatus} upstream` : `payment ${o.paymentStatus} here, ${o.paymentUpstreamStatus} upstream`,
        nextAction: cancelAhead ? "Push cancel upstream" : "Wait for upstream, or check with the Payment team",
        amountMinor: o.amountMinor,
        at: null,
      });
    }),
    ...failedRuns.map((r) => ({
      key: `sync-${r.id}`,
      kind: "failed_sync",
      title: `${SERVICE_LABELS[r.service]} sync failed`,
      detail: r.error,
      href: "/integrations",
      nextAction: "Check the service, then Sync now",
      orderId: null,
      customerId: null,
      customerName: null,
      amountMinor: null,
      at: r.finishedAt ?? r.startedAt,
    })),
  ];
}

function financeQueue(who: Who): QueueItem[] {
  const pending = listApprovals().filter((a) => a.status === "pending");
  const failedRefunds = getDb()
    .select()
    .from(operations)
    .where(and(eq(operations.type, "refund"), eq(operations.status, "failed")))
    .orderBy(desc(operations.id))
    .all();
  return [
    ...owedRefunds().orders.map((o) =>
      orderItem(who, o.orderId, {
        key: `owed-${o.orderId}`,
        kind: "owed_refund",
        title: "Refund owed on cancelled order",
        detail: `${formatMoney(o.amountMinor)} captured, nothing refunded`,
        nextAction: o.pendingApproval ? "Waiting for Manager approval" : "Request refund",
        amountMinor: o.amountMinor,
        at: null,
      }),
    ),
    ...unpaidShipped().orders.map((o) =>
      orderItem(who, o.orderId, {
        key: `unpaid-${o.orderId}`,
        kind: "unpaid_shipped",
        title: `Unpaid ${o.status} order`,
        detail: o.openTicketId ? `ticket ${o.openTicketId} open` : "payment failed",
        nextAction: o.openTicketId ? "Ticket open; waiting for payment" : "Create support ticket",
        amountMinor: o.amountMinor,
        at: null,
        canCreateTicket: !o.openTicketId,
      }),
    ),
    ...pending.map((a) =>
      orderItem(who, a.orderId, {
        key: `approval-${a.id}`,
        kind: "pending_approval",
        title: "Refund waiting for approval",
        detail: `requested by ${a.requestedByLabel}`,
        href: "/approvals",
        nextAction: "Manager: approve or reject",
        amountMinor: a.amountMinor,
        at: a.createdAt,
      }),
    ),
    ...failedRefunds.map((op) =>
      orderItem(who, op.orderId, { key: `refund-failed-${op.id}`, kind: "failed_refund", title: "Refund failed", detail: op.error, nextAction: "Check the reason, then retry from Approvals", amountMinor: op.amountMinor, at: op.updatedAt }),
    ),
  ];
}

function supportQueue(who: Who, ops: QueueItem[], fin: QueueItem[]): QueueItem[] {
  const tickets = listTickets().items;
  const open = tickets.filter((t) => t.status === "open");
  // Orders with any customer-facing problem: the order-level items from the other queues, one row per order.
  const problems = new Map<string, string[]>();
  for (const i of [...ops, ...fin]) {
    if (!i.orderId || i.kind === "failed_sync") continue;
    problems.set(i.orderId, [...(problems.get(i.orderId) ?? []), i.title.toLowerCase()]);
  }
  return [
    ...open.map((t) =>
      orderItem(who, t.orderId, { key: `ticket-${t.id}`, kind: "open_ticket", title: `Ticket ${t.id} open`, detail: t.reason, href: `/tickets?orderId=${t.orderId}`, nextAction: "Follow up with the customer", amountMinor: null, at: t.createdAt }),
    ),
    ...[...problems].map(([orderId, list]) =>
      orderItem(who, orderId, { key: `problem-${orderId}`, kind: "customer_problem", title: "Customer affected", detail: [...new Set(list)].join("; "), nextAction: "Tell the customer what is happening", amountMinor: null, at: null }),
    ),
    ...tickets
      .filter((t) => t.fromWorkflow)
      .slice(0, RECENT_WORKFLOW_TICKETS)
      .map((t) =>
        orderItem(who, t.orderId, { key: `wf-ticket-${t.id}`, kind: "workflow_ticket", title: `Ticket ${t.id} by ${t.createdByLabel}`, detail: t.reason, href: `/tickets?orderId=${t.orderId}`, nextAction: "Check the ticket is handled", amountMinor: null, at: t.createdAt }),
      ),
  ];
}

export function getQueues(): Record<QueueName, { count: number; items: QueueItem[] }> {
  const who = customerOf();
  const ops = operationsQueue(who);
  const fin = financeQueue(who);
  const sup = supportQueue(who, ops, fin);
  const q = (items: QueueItem[]) => ({ count: items.length, items });
  return { operations: q(ops), finance: q(fin), support: q(sup) };
}
