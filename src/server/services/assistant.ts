// Operations assistant: rule-based intent matching (no LLM) over our own services. Local DB only for reads, and the
// same requestRefund / approval flow for writes: it never calls an upstream API and never refunds directly.
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { customers, operations, orders, payments, shipments, tickets, webhookEvents, workflowExecutions, workflows } from "@/server/db/schema";
import { formatIst, formatMoney } from "@/lib/format";
import type { AuthUser } from "@/server/auth/require-role";
import { audit, userActor } from "./audit";
import { listApprovals } from "./approvals";
import { owedRefunds, unpaidShipped } from "./dashboard";
import { allowedActions } from "./orders";
import { refundPosition, requestRefund, RESERVING_STATUSES } from "./refunds";

export interface Item {
  text: string;
  href?: string;
}
export interface Reply {
  status: number; // HTTP status the route answers with: 200 ok, 403 role, 404 unknown order, 409 rule refusal
  intent: string;
  title: string;
  items: Item[];
}

const orderLink = (id: string) => `/orders/${id}`;
const reply = (intent: string, title: string, items: Item[] = [], status = 200): Reply => ({ status, intent, title, items });

const HELP: Item[] = [
  { text: "show delayed shipments" },
  { text: "refunds waiting for approval" },
  { text: "money at risk" },
  { text: "investigate order NC-1004" },
  { text: "request a refund for order NC-1002 (full refundable amount; needs Manager approval)" },
];

// "NC-1004", "nc 1004" -> "NC-1004". Anything else that looks like an order id (NC-abc) is not one.
function orderIdIn(text: string): string | null {
  const m = /\bnc[-\s]?(\d{1,10})\b/i.exec(text);
  return m ? `NC-${m[1]}` : null;
}

export function ask(text: string, user: AuthUser): Reply {
  const t = text.toLowerCase();
  const orderId = orderIdIn(text);
  if (orderId && /\b(investigate|look into|check|status of|details?)\b/.test(t)) return investigate(orderId);
  if (orderId && /\brefunds?\b/.test(t)) return refundFor(orderId, user);
  if (/\b(waiting|pending|approvals?)\b/.test(t)) return pendingApprovals();
  if (/\bdelayed\b/.test(t)) return delayedShipments();
  if (/at risk|\bowed\b|\bunpaid\b/.test(t)) return moneyAtRisk();
  if (orderId) return investigate(orderId);
  return reply("help", "I can answer these (no AI, fixed phrases):", HELP);
}

function unknownOrder(intent: string, orderId: string): Reply {
  return reply(intent, `I can't find order ${orderId}. Check the id on the Orders page.`, [{ text: "Orders", href: "/orders" }], 404);
}

function delayedShipments(): Reply {
  const rows = getDb()
    .select({ orderId: shipments.orderId, shipmentId: shipments.id, updatedAt: shipments.updatedAt, amountMinor: orders.amountMinor })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(shipments.status, "delayed"))
    .orderBy(shipments.orderId)
    .all();
  return reply("delayed_shipments", `${rows.length} delayed shipment${rows.length === 1 ? "" : "s"}`, [
    ...rows.map((r) => ({ text: `${r.orderId} · ${r.shipmentId} · ${formatMoney(r.amountMinor)} · updated ${formatIst(r.updatedAt)}`, href: orderLink(r.orderId) })),
    ...(rows.length ? [{ text: "Open in the orders list", href: "/orders?shipmentStatus=delayed" }] : []),
  ]);
}

function pendingApprovals(): Reply {
  const rows = listApprovals().filter((a) => a.status === "pending");
  return reply("pending_approvals", `${rows.length} refund${rows.length === 1 ? "" : "s"} waiting for approval`, [
    ...rows.map((a) => ({ text: `${a.orderId} · ${formatMoney(a.amountMinor)} · requested by ${a.requestedByLabel} · ${formatIst(a.createdAt)}`, href: orderLink(a.orderId) })),
    ...(rows.length ? [{ text: "Open the approval queue (Managers decide)", href: "/approvals" }] : []),
  ]);
}

function moneyAtRisk(): Reply {
  const owed = owedRefunds();
  const unpaid = unpaidShipped();
  return reply("money_at_risk", `Money at risk: ${formatMoney(owed.totalMinor + unpaid.totalMinor)}`, [
    { text: `Owed refunds: ${owed.count} cancelled orders, ${formatMoney(owed.totalMinor)} captured and not refunded` },
    ...owed.orders.map((o) => ({ text: `${o.orderId} · ${formatMoney(o.amountMinor)}${o.pendingApproval ? " · request pending" : ""}`, href: orderLink(o.orderId) })),
    { text: `Unpaid: ${unpaid.count} shipped or delivered orders with a failed payment, ${formatMoney(unpaid.totalMinor)}` },
    ...unpaid.orders.map((o) => ({ text: `${o.orderId} · ${o.status} · ${formatMoney(o.amountMinor)} · fix: open a support ticket`, href: orderLink(o.orderId) })),
  ]);
}

function investigate(orderId: string): Reply {
  const db = getDb();
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return unknownOrder("investigate_order", orderId);
  const customer = db.select().from(customers).where(eq(customers.id, order.customerId)).get();
  const payment = db.select().from(payments).where(eq(payments.orderId, orderId)).get();
  const shipment = db.select().from(shipments).where(eq(shipments.orderId, orderId)).get();
  const ops = db.select().from(operations).where(eq(operations.orderId, orderId)).orderBy(desc(operations.id)).all();
  const orderTickets = db.select().from(tickets).where(eq(tickets.orderId, orderId)).all();
  const runs = db
    .select({ name: workflows.name, outcome: workflowExecutions.outcome, result: workflowExecutions.result, error: workflowExecutions.error })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(eq(workflowExecutions.orderId, orderId))
    .orderBy(desc(workflowExecutions.id))
    .all();
  const events = db.select().from(webhookEvents).where(eq(webhookEvents.orderId, orderId)).all();

  const ahead: string[] = [];
  if (order.upstreamStatus && order.status !== order.upstreamStatus) ahead.push(`order is ${order.status} locally but ${order.upstreamStatus} upstream`);
  if (payment?.upstreamStatus && payment.status !== payment.upstreamStatus) ahead.push(`payment is ${payment.status} locally but ${payment.upstreamStatus} upstream`);
  const list = (label: string, rows: string[]) => ({ text: rows.length ? `${label}: ${rows.join("; ")}` : `${label}: none` });

  return reply("investigate_order", `Order ${orderId} (from local data)`, [
    { text: `Order ${order.status}, ${formatMoney(order.amountMinor)}, ${customer?.name ?? order.customerId}, placed ${formatIst(order.createdAt)}` },
    { text: `Payment: ${payment ? `${payment.status}, ${formatMoney(payment.amountMinor)}` : "none on record"}` },
    { text: `Shipment: ${shipment ? `${shipment.status}, updated ${formatIst(shipment.updatedAt)}` : "none on record"}` },
    { text: ahead.length ? `LOCAL AHEAD: ${ahead.join("; ")}` : "Local data agrees with upstream." },
    list("Operations", ops.map((o) => `${o.type}${o.amountMinor ? ` ${formatMoney(o.amountMinor)}` : ""} ${o.status}${o.error ? ` (${o.error})` : ""}`)),
    list("Tickets", orderTickets.map((x) => `${x.id} ${x.status} "${x.reason}"`)),
    list("Workflow runs", runs.map((r) => `${r.name} → ${r.outcome}${r.error ?? r.result ? ` (${r.error ?? r.result})` : ""}`)),
    list("Webhook events", events.map((e) => `${e.eventId} ${e.type} ${e.status}`)),
    ...nextSteps(order, payment, shipment?.status ?? null, orderTickets.length, ops),
    { text: "Open the order page", href: orderLink(orderId) },
  ]);
}

function nextSteps(
  order: typeof orders.$inferSelect,
  payment: typeof payments.$inferSelect | undefined,
  shipmentStatus: string | null,
  ticketCount: number,
  ops: { type: string; status: string }[],
): Item[] {
  const next: string[] = [];
  const actions = allowedActions(order);
  const reserving: readonly string[] = RESERVING_STATUSES;
  if (ops.some((o) => o.type === "refund" && reserving.includes(o.status))) {
    next.push("a refund request is already open: a Manager decides it on the Approvals page");
  } else if (actions.refund.allowed) {
    next.push(`request a refund of ${formatMoney(refundPosition(order.id).refundableMinor)} (ask: "request a refund for order ${order.id}")`);
  }
  if (actions.reconcile.allowed) next.push("push the cancel upstream from the order page (a refund needs upstream to agree)");
  if (actions.cancel.allowed) next.push("cancel the order from the order page");
  if (payment?.status === "failed" && ["shipped", "delivered"].includes(order.status) && ticketCount === 0) next.push("open a support ticket for the unpaid order");
  if (shipmentStatus === "delayed") next.push("the shipment is delayed: check the workflow runs above");
  return (next.length ? next : ["nothing to do right now"]).map((n) => ({ text: `Next: ${n}` }));
}

function refundFor(orderId: string, user: AuthUser): Reply {
  const intent = "request_refund";
  const actor = userActor(user);
  if (user.role === "viewer") {
    audit({ userId: user.id, actorLabel: actor.label, role: user.role, action: "refund.request", target: orderId, outcome: "forbidden", detail: { via: "assistant" } });
    return reply(intent, "Your role (viewer) cannot request refunds. Ask an Operator or Manager.", [], 403);
  }
  const result = requestRefund(orderId, undefined, actor);
  if (!result.ok) {
    return result.code === "not_found"
      ? unknownOrder(intent, orderId)
      : reply(intent, `Refund for ${orderId} refused: ${result.reason}.`, [{ text: "Open the order page", href: orderLink(orderId) }], 409);
  }
  return reply(intent, `Refund of ${formatMoney(result.amountMinor)} for ${orderId} is waiting for Manager approval. Nothing was sent to the Payment API.`, [
    { text: "Open the approval queue", href: "/approvals" },
  ]);
}
