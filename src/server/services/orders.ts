// Orders: list/search, detail (with a live shipment lookup), and cancel through the Commerce API.
// Cancel rule: CLAUDE.md "Business rules". Cancels need no approval.
import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { orderPath, request } from "@/server/clients/mock";
import { getDb } from "@/server/db";
import { customers, operations, orders, payments, refunds, shipments, tickets, webhookEvents } from "@/server/db/schema";
import { formatIst } from "@/lib/format";
import { audit, type Actor } from "./audit";
import { recordNetworkFailure } from "./health";
import { refundPosition, refundRefusal } from "./refunds";
import { shipmentRow, upsertShipment } from "./sync";
import { onWebhookEvent } from "./workflows";

export { ORDER_STATUSES, PAYMENT_STATUSES, SHIPMENT_STATUSES } from "@/server/db/schema";

const NOT_CANCELLABLE_ORDER = ["shipped", "delivered"];
const NOT_CANCELLABLE_SHIPMENT = ["shipped", "delayed", "delivered"];

// ---------- list ----------

export interface OrderListQuery {
  q?: string;
  orderStatus?: string;
  paymentStatus?: string;
  shipmentStatus?: string;
  localAhead?: boolean;
  customerId?: string;
  minAmountMinor?: number; // exclusive ("over")
  maxAmountMinor?: number; // exclusive ("under")
  createdFrom?: string; // UTC ISO, inclusive
  createdTo?: string; // UTC ISO, exclusive
  orderIds?: string[]; // restrict to these (assistant follow-ups)
  page: number;
  pageSize: number;
}

// "Local ahead": a webhook (or our own action) set a status upstream doesn't show yet.
const orderAhead = sql`(${orders.upstreamStatus} IS NOT NULL AND ${orders.status} <> ${orders.upstreamStatus})`;
const paymentAhead = sql`(${payments.upstreamStatus} IS NOT NULL AND ${payments.status} <> ${payments.upstreamStatus})`;
const localAhead = sql<number>`(${orderAhead} OR coalesce(${paymentAhead}, 0))`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

export function listOrders(query: OrderListQuery) {
  const db = getDb();
  const where: SQL[] = [];
  if (query.q) {
    const p = `%${escapeLike(query.q)}%`;
    where.push(
      or(
        sql`${orders.id} LIKE ${p} ESCAPE '\\'`,
        sql`${customers.name} LIKE ${p} ESCAPE '\\'`,
        sql`${customers.email} LIKE ${p} ESCAPE '\\'`,
      )!,
    );
  }
  if (query.orderStatus) where.push(eq(orders.status, query.orderStatus));
  if (query.paymentStatus) where.push(eq(payments.status, query.paymentStatus));
  if (query.shipmentStatus) where.push(eq(shipments.status, query.shipmentStatus));
  if (query.localAhead) where.push(localAhead);
  if (query.customerId) where.push(eq(orders.customerId, query.customerId));
  if (query.minAmountMinor !== undefined) where.push(gt(orders.amountMinor, query.minAmountMinor));
  if (query.maxAmountMinor !== undefined) where.push(lt(orders.amountMinor, query.maxAmountMinor));
  if (query.createdFrom) where.push(gte(orders.createdAt, query.createdFrom));
  if (query.createdTo) where.push(lt(orders.createdAt, query.createdTo));
  if (query.orderIds) where.push(query.orderIds.length ? inArray(orders.id, query.orderIds) : sql`0`);
  const cond = where.length ? and(...where) : undefined;

  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .leftJoin(shipments, eq(shipments.orderId, orders.id))
    .where(cond)
    .get()!.n;
  const rows = db
    .select({
      id: orders.id,
      status: orders.status,
      upstreamStatus: orders.upstreamStatus,
      amountMinor: orders.amountMinor,
      createdAt: orders.createdAt,
      customerId: orders.customerId,
      customerName: customers.name,
      customerEmail: customers.email,
      paymentStatus: payments.status,
      paymentUpstreamStatus: payments.upstreamStatus,
      shipmentStatus: shipments.status,
      localAhead,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .leftJoin(shipments, eq(shipments.orderId, orders.id))
    .where(cond)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();
  return {
    items: rows.map((r) => ({ ...r, localAhead: Boolean(r.localAhead) })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------- detail ----------

// Live shipment read: refresh the local row (same merge rule as sync) or say why we show the stored one.
async function refreshShipment(orderId: string): Promise<string | null> {
  const path = orderPath("/shipping/shipments/", orderId);
  if (!path) return "Shipping lookup failed: invalid order id";
  const res = await request<unknown>("GET", path);
  recordNetworkFailure("shipping", res); // a 503 for this order is this order's error, not Shipping down
  const parsed = res.ok ? shipmentRow.safeParse(res.data) : null;
  if (parsed?.success && parsed.data.order_id === orderId) {
    getDb().transaction(() => {
      upsertShipment(parsed.data, new Date().toISOString());
      getDb().update(shipments).set({ lookupError: null, lookupErrorAt: null }).where(eq(shipments.orderId, orderId)).run();
    });
    return null;
  }
  const stored = getDb().select().from(shipments).where(eq(shipments.orderId, orderId)).get();
  const error = res.ok ? "unexpected reply shape" : res.error;
  getDb()
    .update(shipments)
    .set({ lookupError: error, lookupErrorAt: new Date().toISOString() })
    .where(eq(shipments.orderId, orderId))
    .run();
  return `Shipping lookup failed: ${error}, showing data from ${formatIst(stored?.syncedAt ?? stored?.updatedAt)}`;
}

export async function getOrderDetail(orderId: string) {
  const db = getDb();
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return null;
  const shippingError = await refreshShipment(orderId);
  const payment = db.select().from(payments).where(eq(payments.orderId, orderId)).get() ?? null;
  return {
    order,
    actions: allowedActions(order), // after the shipment refresh: the cancel rule reads the shipment status
    customer: db.select().from(customers).where(eq(customers.id, order.customerId)).get() ?? null,
    payment,
    refundPosition: refundPosition(orderId),
    refunds: db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.createdAt)).all(),
    shipment: db.select().from(shipments).where(eq(shipments.orderId, orderId)).get() ?? null,
    shippingError,
    operations: db.select().from(operations).where(eq(operations.orderId, orderId)).orderBy(desc(operations.id)).all(),
    tickets: db.select().from(tickets).where(eq(tickets.orderId, orderId)).orderBy(asc(tickets.createdAt)).all(),
    events: db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.orderId, orderId))
      .orderBy(desc(webhookEvents.receivedAt))
      .all(),
  };
}

// ---------- cancel and reconcile ----------
// cancel: our rule first, then the Commerce API; success fires order.cancelled workflows.
// reconcile: the order is already cancelled locally (webhook) but upstream still says processing. Push the cancel so
// upstream agrees (the mock's refund eligibility reads its own order status). No workflows: the webhook already fired them.

export type CancelResult =
  | { ok: true; operationId: number; status: string }
  | { ok: false; code: "not_found" | "refused" | "upstream"; reason: string; operationId?: number; httpStatus?: number | null };

type CancelKind = "cancel" | "reconcile";
const AUDIT_ACTION: Record<CancelKind, string> = { cancel: "order.cancel", reconcile: "order.reconcile_cancel" };

type OrderRow = typeof orders.$inferSelect;

function shipmentRefusal(orderId: string): string | null {
  const shipment = getDb().select().from(shipments).where(eq(shipments.orderId, orderId)).get();
  return shipment && NOT_CANCELLABLE_SHIPMENT.includes(shipment.status) ? `shipment is ${shipment.status}` : null;
}

// Why each kind is refused, or null. Checked before any API call.
const REFUSAL: Record<CancelKind, (order: OrderRow) => string | null> = {
  cancel: (order) => {
    if (order.status === "cancelled") {
      return order.upstreamStatus === "cancelled"
        ? "order is already cancelled"
        : "order is already cancelled locally; use Push cancel upstream";
    }
    if (NOT_CANCELLABLE_ORDER.includes(order.status)) return `order is ${order.status}`;
    return shipmentRefusal(order.id);
  },
  reconcile: (order) => {
    if (order.status !== "cancelled") return `order is ${order.status} locally, not cancelled`;
    if (order.upstreamStatus !== "processing") return `upstream order is ${order.upstreamStatus}, not processing`;
    return shipmentRefusal(order.id);
  },
};

const cancelReply = z.object({ id: z.string(), status: z.string() });

// Shared path: refuse or record the operation (requested -> submitted -> succeeded | failed), call the API, audit.
// `onSuccess` runs in the same transaction that marks the operation succeeded.
async function submitCancel(kind: CancelKind, orderId: string, actor: Actor, onSuccess: (opId: number, at: string) => void): Promise<CancelResult> {
  const db = getDb();
  const log = (outcome: string, detail: unknown) =>
    audit({ userId: actor.userId, actorLabel: actor.label, role: actor.role, action: AUDIT_ACTION[kind], target: orderId, outcome, detail });

  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return { ok: false, code: "not_found", reason: "unknown order" };
  const reason = REFUSAL[kind](order);
  if (reason) {
    log("refused", { reason });
    return { ok: false, code: "refused", reason };
  }

  const [op] = db
    .insert(operations)
    .values({ type: kind, orderId, status: "requested", requestedByUserId: actor.userId, requestedByLabel: actor.label })
    .returning({ id: operations.id })
    .all();
  const setOp = (set: Partial<typeof operations.$inferInsert>) =>
    db.update(operations).set({ ...set, updatedAt: new Date().toISOString() }).where(eq(operations.id, op.id)).run();
  setOp({ status: "submitted" });

  const res = await request<unknown>("POST", orderPath("/commerce/orders/", orderId) + "/cancel", {});
  recordNetworkFailure("commerce", res);
  const reply = res.ok ? cancelReply.safeParse(res.data) : null;
  // Final state comes from the answer: only a reply that says "cancelled" for this order is a success.
  if (!reply?.success || reply.data.id !== orderId || reply.data.status !== "cancelled") {
    const error = res.ok ? `unexpected reply: ${JSON.stringify(res.data).slice(0, 200)}` : res.error;
    setOp({ status: "failed", error });
    log("failed", { operationId: op.id, httpStatus: res.status, error });
    return { ok: false, code: "upstream", reason: error, operationId: op.id, httpStatus: res.status };
  }

  const at = new Date().toISOString();
  db.transaction(() => {
    onSuccess(op.id, at);
    setOp({ status: "succeeded" });
  });
  log("succeeded", { operationId: op.id });
  return { ok: true, operationId: op.id, status: "cancelled" };
}

export async function cancelOrder(orderId: string, actor: Actor): Promise<CancelResult> {
  const db = getDb();
  const eventIdFor = (opId: number) => `app-cancel-${opId}`;
  const result = await submitCancel("cancel", orderId, actor, (opId, at) => {
    const eventId = eventIdFor(opId);
    db.update(orders)
      .set({ status: "cancelled", upstreamStatus: "cancelled", localEventAt: at, localUpdatedAt: at })
      .where(eq(orders.id, orderId))
      .run();
    db.insert(webhookEvents)
      .values({
        eventId,
        source: "app",
        type: "order.cancelled",
        orderId,
        occurredAt: at,
        payload: JSON.stringify({ event_id: eventId, type: "order.cancelled", occurred_at: at, order_id: orderId, data: { status: "cancelled" } }),
        status: "applied",
        note: `cancelled in app by ${actor.label}`,
      })
      .run();
  });
  // Our own successful cancel fires order.cancelled workflows (agreed decision), once per cancel.
  if (result.ok) {
    const event = db.select().from(webhookEvents).where(eq(webhookEvents.eventId, eventIdFor(result.operationId))).get()!;
    await onWebhookEvent({ eventId: event.eventId, type: "order.cancelled", orderId, occurredAt: event.occurredAt, data: { status: "cancelled" } });
  }
  return result;
}

// Upstream now agrees, so the order stops being "local ahead". Status and local_event_at stay as the webhook set them.
export function reconcileCancel(orderId: string, actor: Actor): Promise<CancelResult> {
  const db = getDb();
  return submitCancel("reconcile", orderId, actor, (_opId, at) => {
    db.update(orders).set({ upstreamStatus: "cancelled", localUpdatedAt: at }).where(eq(orders.id, orderId)).run();
  });
}

// What can be done to this order right now, from the same rule functions the write paths use (one source of truth).
// The order page and the assistant only render this; every write route checks the rule again.
export interface ActionState {
  allowed: boolean;
  reason: string | null;
}
export interface AllowedActions {
  cancel: ActionState;
  reconcile: ActionState;
  refund: ActionState;
  createTicket: ActionState;
}

export function allowedActions(order: OrderRow): AllowedActions {
  const state = (reason: string | null): ActionState => ({ allowed: reason === null, reason });
  return {
    cancel: state(REFUSAL.cancel(order)),
    reconcile: state(REFUSAL.reconcile(order)),
    refund: state(refundRefusal(order.id, undefined)),
    createTicket: state(null), // any known order; the reason is required on submit
  };
}
