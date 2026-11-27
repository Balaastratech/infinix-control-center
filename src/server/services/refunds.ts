// Refund requests. Rules: CLAUDE.md "Business rules". This file only creates pending approvals; it never calls the
// Payment API (that happens on Manager approval, Block 4, which re-checks everything against upstream).
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { approvals, operations, orders, payments, refunds } from "@/server/db/schema";
import { formatMoney } from "@/lib/format";
import { audit, type Actor } from "./audit";

// A request in one of these states still reserves its amount. `submitted` = Payment API call in flight, not yet in
// the refunds table: counting it stops a second request from overshooting while the first is being executed.
export const RESERVING_STATUSES = ["pending_approval", "approved", "submitted"] as const;
const REFUNDABLE_ORDER_STATUSES = ["cancelled", "delivered"];

export interface RefundPosition {
  capturedMinor: number; // 0 when the payment is not captured
  refundedMinor: number; // non-failed refunds
  reservedMinor: number; // open requests
  refundableMinor: number; // the cap for a new request
}

export function refundPosition(orderId: string): RefundPosition {
  const db = getDb();
  const payment = db.select().from(payments).where(eq(payments.orderId, orderId)).get();
  const capturedMinor = payment?.status === "captured" ? payment.amountMinor : 0;
  const refundedMinor = db
    .select({ n: sql<number>`coalesce(sum(${refunds.amountMinor}), 0)` })
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), ne(refunds.status, "failed")))
    .get()!.n;
  const reservedMinor = db
    .select({ n: sql<number>`coalesce(sum(${operations.amountMinor}), 0)` })
    .from(operations)
    .where(and(eq(operations.orderId, orderId), eq(operations.type, "refund"), inArray(operations.status, RESERVING_STATUSES)))
    .get()!.n;
  return { capturedMinor, refundedMinor, reservedMinor, refundableMinor: Math.max(0, capturedMinor - refundedMinor - reservedMinor) };
}

export type RefundRequestResult =
  | { ok: true; operationId: number; approvalId: number; amountMinor: number }
  | { ok: false; code: "not_found" | "refused"; reason: string };

// Why a refund is not allowed right now, or null. Uses local (effective) statuses.
export function refundRefusal(orderId: string, amountMinor: number | undefined): string | null {
  const db = getDb();
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get()!;
  const payment = db.select().from(payments).where(eq(payments.orderId, orderId)).get();
  if (payment?.status !== "captured") return `payment is ${payment?.status ?? "missing"}, not captured`;
  if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) return `order is ${order.status}, not cancelled or delivered`;
  const { refundableMinor } = refundPosition(orderId);
  if (refundableMinor <= 0) return "nothing left to refund";
  if (amountMinor === undefined) return null;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return "amount must be a whole number of paise above 0";
  if (amountMinor > refundableMinor) return `Amount ${formatMoney(amountMinor)} exceeds the refundable ${formatMoney(refundableMinor)}`;
  return null;
}

// amountMinor omitted = the full refundable amount. Check and insert run in one transaction (no double reservation).
export function requestRefund(orderId: string, amountMinor: number | undefined, actor: Actor): RefundRequestResult {
  const db = getDb();
  const result = db.transaction((): RefundRequestResult => {
    if (!db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get()) {
      return { ok: false, code: "not_found", reason: "unknown order" };
    }
    const reason = refundRefusal(orderId, amountMinor);
    if (reason) return { ok: false, code: "refused", reason };
    const amount = amountMinor ?? refundPosition(orderId).refundableMinor;
    const [op] = db
      .insert(operations)
      .values({
        type: "refund",
        orderId,
        amountMinor: amount,
        status: "pending_approval",
        requestedByUserId: actor.userId,
        requestedByLabel: actor.label,
      })
      .returning({ id: operations.id })
      .all();
    const [approval] = db
      .insert(approvals)
      .values({ operationId: op.id, requestedByUserId: actor.userId, requestedByLabel: actor.label })
      .returning({ id: approvals.id })
      .all();
    return { ok: true, operationId: op.id, approvalId: approval.id, amountMinor: amount };
  });
  audit({
    userId: actor.userId,
    actorLabel: actor.label,
    role: actor.role,
    action: "refund.request",
    target: orderId,
    outcome: result.ok ? "pending_approval" : "refused",
    detail: result.ok ? { operationId: result.operationId, amountMinor: result.amountMinor } : { reason: result.reason, amountMinor },
  });
  return result;
}

// "Request full refunds": one pending approval per owed order (cancelled + captured + nothing refunded).
// Orders that already have an open request are skipped.
// Cancelled orders with a captured payment and money still owed: captured minus succeeded refunds.
// amountMinor = what is still owed. pendingApproval = a request is already open for it.
export function owedRefundOrders(): { orderId: string; amountMinor: number; pendingApproval: boolean }[] {
  const succeeded = sql<number>`(SELECT coalesce(sum(r.amount_minor), 0) FROM ${refunds} r WHERE r.order_id = ${orders.id} AND r.status = 'succeeded')`;
  return getDb()
    .select({
      orderId: orders.id,
      amountMinor: sql<number>`${payments.amountMinor} - ${succeeded}`,
      pendingApproval: sql<number>`EXISTS (SELECT 1 FROM ${operations} o WHERE o.order_id = ${orders.id} AND o.type = 'refund'
        AND o.status IN (${sql.join(RESERVING_STATUSES.map((s) => sql`${s}`), sql`, `)}))`,
    })
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(and(eq(orders.status, "cancelled"), eq(payments.status, "captured"), sql`${payments.amountMinor} - ${succeeded} > 0`))
    .orderBy(orders.id)
    .all()
    .map((r) => ({ ...r, pendingApproval: Boolean(r.pendingApproval) }));
}

export function requestBulkRefunds(actor: Actor): { created: number; skipped: number; orderIds: string[] } {
  const owed = owedRefundOrders();
  let skipped = 0;
  const created: string[] = [];
  for (const { orderId: id, amountMinor: owedMinor } of owed) {
    if (refundPosition(id).reservedMinor > 0) {
      skipped++;
      continue;
    }
    const r = requestRefund(id, owedMinor, actor); // the remaining amount, not the original capture
    if (r.ok) created.push(id);
    else skipped++;
  }
  audit({
    userId: actor.userId,
    actorLabel: actor.label,
    role: actor.role,
    action: "refund.bulk_request",
    target: "owed orders",
    outcome: "ok",
    detail: { created: created.length, skipped, orderIds: created },
  });
  return { created: created.length, skipped, orderIds: created };
}
