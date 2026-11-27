// Assistant tools: the ONLY things the assistant (parser or AI) can run. Each one validates its input with zod, runs as
// the logged-in user, checks the role itself, reads local data through existing services, and returns display blocks.
// Nothing here writes business data: actions come back as proposals, and the UI's Confirm button calls the normal
// routes. docs/assistant-design.md sections 4, 5, 7.
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import {
  auditLog,
  customers,
  operations,
  orders,
  payments,
  refunds,
  shipments,
  tickets,
  webhookEvents,
  workflowExecutions,
  workflows,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  SHIPMENT_STATUSES,
} from "@/server/db/schema";
import { formatIst, formatMoney } from "@/lib/format";
import { statusLabel } from "@/lib/labels";
import type { AuthUser } from "@/server/auth/require-role";
import { listApprovals } from "./approvals";
import { getCustomerDetail } from "./customers";
import { owedRefunds, unpaidShipped } from "./dashboard";
import { briefingText, collectIssues, HIGH_VALUE_MINOR } from "./briefing";
import { getHealth } from "./health";
import { allowedActions, listOrders } from "./orders";
import { QUEUE_NAMES, getQueues } from "./queues";
import { refundPosition, refundRefusal, RESERVING_STATUSES } from "./refunds";
import { listTickets, ticketReasonSchema } from "./tickets";

// ---------- blocks (what the UI renders; the only place facts appear) ----------

export interface Item {
  text: string;
  href?: string;
}
export type Cell = string | { text: string; href: string };
export type Block =
  | { kind: "table"; title: string; columns: string[]; rows: Cell[][]; more?: Item }
  | { kind: "list"; title: string; items: Item[] }
  | { kind: "proposal"; action: "cancel" | "refund" | "ticket"; orderId: string; amountMinor?: number; maxAmountMinor?: number; reason?: string; label: string; note: string; done?: string };

export interface ToolResult {
  outcome: "ok" | "invalid" | "denied" | "not_found";
  title: string;
  blocks: Block[];
  resultIds?: string[]; // order ids listed, for follow-ups
  filters?: Record<string, unknown>;
}

export const UI_ROWS = 200; // rows the UI gets; the AI gets fewer (assistant-ai.ts)
const orderLink = (id: string) => `/orders/${id}`;
const orderCell = (id: string): Cell => ({ text: id, href: orderLink(id) });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const result = (title: string, blocks: Block[] = [], extra: Partial<ToolResult> = {}): ToolResult => ({ outcome: "ok", title, blocks, ...extra });
const fail = (outcome: ToolResult["outcome"], title: string): ToolResult => ({ outcome, title, blocks: [] });

// ---------- input schemas (strict: unknown keys are rejected) ----------

const orderId = z.string().regex(/^NC-\d{1,10}$/, "order id like NC-1004");
const paise = z.number().int().positive().max(10_000_000_000);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
const orderFilters = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    orderStatus: z.enum(ORDER_STATUSES).optional(),
    orderStatuses: z.array(z.enum(ORDER_STATUSES)).max(ORDER_STATUSES.length).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    shipmentStatus: z.enum(SHIPMENT_STATUSES).optional(),
    localAhead: z.boolean().optional(),
    customerId: z.string().regex(/^C-\d{1,6}$/).optional(),
    minAmountMinor: z.number().int().min(0).max(10_000_000_000).optional(),
    maxAmountMinor: z.number().int().min(0).max(10_000_000_000).optional(),
    createdFrom: isoTime.optional(),
    createdTo: isoTime.optional(),
    order_ids: z.array(orderId).max(UI_ROWS).optional(),
  })
  .strict();

export const TOOL_SCHEMAS = {
  find_orders: orderFilters,
  count_orders: orderFilters,
  get_customer: z
    .object({ customer_id: z.string().regex(/^C-\d{1,6}$/).optional(), order_id: orderId.optional() })
    .strict()
    .refine((v) => Boolean(v.customer_id) !== Boolean(v.order_id), "give a customer id or an order id"),
  investigate_order: z.object({ order_id: orderId }).strict(),
  money_at_risk: z.object({}).strict(),
  team_queues: z.object({ queue: z.enum(QUEUE_NAMES).optional() }).strict(),
  list_tickets: z.object({ status: z.enum(["open", "closed"]).optional(), order_id: orderId.optional(), customer_id: z.string().regex(/^C-\d{1,6}$/).optional() }).strict(),
  list_approvals: z.object({ status: z.enum(["pending", "approved", "rejected"]).optional() }).strict(),
  workflow_runs: z
    .object({ outcome: z.enum(["skipped", "succeeded", "failed"]).optional(), order_id: orderId.optional(), ran_from: isoTime.optional(), ran_to: isoTime.optional() })
    .strict(),
  health_and_sync: z.object({}).strict(),
  briefing: z.object({}).strict(),
  customers_at_risk: z.object({}).strict(),
  refunds_summary: z.object({ from: isoTime.optional(), to: isoTime.optional() }).strict(),
  search_audit: z
    .object({ action: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(40).optional(), target: z.string().max(40).optional(), actor: z.string().max(100).optional() })
    .strict(),
  propose_cancel: z.object({ order_id: orderId }).strict(),
  propose_refund: z.object({ order_id: orderId, amount_minor: paise.optional() }).strict(),
  propose_ticket: z.object({ order_id: orderId, reason: ticketReasonSchema.pipe(z.string().max(200)) }).strict(),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_SCHEMAS, name);

// ---------- run ----------

export function runTool(name: string, rawInput: unknown, user: AuthUser): ToolResult {
  if (!isToolName(name)) return fail("invalid", `Unknown tool "${String(name).slice(0, 40)}".`);
  const parsed = TOOL_SCHEMAS[name].safeParse(rawInput ?? {});
  if (!parsed.success) return fail("invalid", "I couldn't use that request: some values are not valid.");
  const input = parsed.data as Record<string, unknown>;
  switch (name) {
    case "find_orders":
      return findOrders(input, false);
    case "count_orders":
      return findOrders(input, true);
    case "get_customer":
      return customerView(input.customer_id as string | undefined, input.order_id as string | undefined);
    case "investigate_order":
      return investigate(input.order_id as string);
    case "money_at_risk":
      return moneyAtRisk();
    case "team_queues":
      return teamQueues(input.queue as string | undefined);
    case "list_tickets":
      return ticketList(input);
    case "list_approvals":
      return approvalList((input.status as string | undefined) ?? "pending");
    case "workflow_runs":
      return workflowRuns(input);
    case "health_and_sync":
      return health();
    case "briefing":
      return briefing();
    case "customers_at_risk":
      return customersAtRisk();
    case "refunds_summary":
      return refundsSummary(input.from as string | undefined, input.to as string | undefined);
    case "search_audit":
      return searchAudit(input);
    case "propose_cancel":
    case "propose_refund":
    case "propose_ticket":
      return propose(name, input, user);
  }
}

// ---------- read tools ----------

// "cancelled orders with a failed payment over ₹5,000.00 for C-003": the filters in words, from the validated input.
function orderPhrase(f: Record<string, unknown>, count: number): string {
  const adj = [f.orderStatus, Array.isArray(f.orderStatuses) ? (f.orderStatuses as string[]).join(" or ") : undefined].filter(Boolean).join(" ");
  const noun = count === 1 ? "order" : "orders";
  const tail: string[] = [];
  if (f.paymentStatus === "failed") tail.push("with a failed payment");
  else if (f.paymentStatus === "captured") tail.push("that are paid");
  if (f.shipmentStatus) tail.push(`with a ${f.shipmentStatus} shipment`);
  if (f.localAhead) tail.push("that are ahead of upstream");
  if (typeof f.minAmountMinor === "number") tail.push(`over ${formatMoney(f.minAmountMinor)}`);
  if (typeof f.maxAmountMinor === "number") tail.push(`under ${formatMoney(f.maxAmountMinor)}`);
  if (f.customerId) tail.push(`for ${f.customerId}`);
  if (f.createdFrom) tail.push(`placed since ${formatIst(f.createdFrom as string)}`);
  if (f.createdTo) tail.push(`placed before ${formatIst(f.createdTo as string)}`);
  if (f.q) tail.push(`matching "${String(f.q).slice(0, 40)}"`);
  if (f.order_ids) tail.push("in your previous result");
  return [adj, noun, ...tail].filter(Boolean).join(" ");
}

function ordersSentence(input: Record<string, unknown>, items: { id: string; amountMinor: number }[], total: number): string {
  const what = orderPhrase(input, total);
  if (total === 0) return `There are no ${orderPhrase(input, 2)}.`;
  const parts = [`There ${total === 1 ? "is" : "are"} ${total} ${what}`];
  if (items.length === total) {
    if (total > 1) parts[0] += `, worth ${formatMoney(items.reduce((s, o) => s + o.amountMinor, 0))} in total`;
    if (input.shipmentStatus === "delayed" && input.minAmountMinor === undefined) {
      const high = items.filter((o) => o.amountMinor > HIGH_VALUE_MINOR).length;
      parts[0] += `; ${high} ${high === 1 ? "is" : "are"} over ${formatMoney(HIGH_VALUE_MINOR)}`;
    }
  }
  const biggest = [...items].sort((a, b) => b.amountMinor - a.amountMinor)[0];
  if (total > 1 && biggest) parts.push(`The biggest is ${biggest.id} (${formatMoney(biggest.amountMinor)})`);
  return `${parts.join(". ")}.`;
}

function findOrders(input: Record<string, unknown>, countOnly: boolean): ToolResult {
  const { order_ids, ...filters } = input as { order_ids?: string[] } & Record<string, unknown>;
  const page = listOrders({ ...(filters as object), orderIds: order_ids, page: 1, pageSize: UI_ROWS });
  const title = ordersSentence(input, page.items, page.total);
  const ids = page.items.map((o) => o.id);
  if (countOnly) return result(title, [], { resultIds: ids, filters: input });
  const rows: Cell[][] = page.items.map((o) => [
    orderCell(o.id),
    o.customerId ? { text: o.customerName ?? o.customerId, href: `/customers/${o.customerId}` } : "-",
    formatMoney(o.amountMinor),
    o.status + (o.localAhead ? " (local ahead)" : ""),
    o.paymentStatus ?? "-",
    o.shipmentStatus ?? "-",
    formatIst(o.createdAt),
  ]);
  const qs = new URLSearchParams();
  for (const k of ["orderStatus", "paymentStatus", "shipmentStatus", "customerId"] as const) if (typeof filters[k] === "string") qs.set(k, filters[k] as string);
  const blocks: Block[] = rows.length
    ? [{ kind: "table", title: "Orders", columns: ["Order", "Customer", "Amount", "Order status", "Payment", "Shipment", "Placed"], rows, more: page.total > rows.length ? { text: `Showing ${rows.length} of ${page.total}: open the orders list`, href: `/orders?${qs}` } : undefined }]
    : [];
  return result(title, blocks, { resultIds: ids, filters: input });
}

function customerView(customerIdIn: string | undefined, orderId: string | undefined): ToolResult {
  const customerId = customerIdIn ?? getDb().select({ c: orders.customerId }).from(orders).where(eq(orders.id, orderId!)).get()?.c;
  if (!customerId) return fail("not_found", `I can't find order ${orderId}. Check the id on the Orders page.`);
  const d = getCustomerDetail(customerId);
  if (!d) return fail("not_found", `I can't find customer ${customerId}.`);
  const risk = d.moneyAtRisk;
  const riskText = risk.totalMinor
    ? ` ${formatMoney(risk.totalMinor)} is at risk (${[risk.owedMinor ? `${formatMoney(risk.owedMinor)} owed in refunds` : "", risk.unpaidMinor ? `${formatMoney(risk.unpaidMinor)} unpaid` : ""].filter(Boolean).join(", ")}).`
    : " Nothing is at risk.";
  const said = `${d.customer.name} (${d.customer.id}) has ${plural(d.orders.length, "order")} and has spent ${formatMoney(d.spentMinor)} net.${riskText} ${d.openTickets.length ? `${plural(d.openTickets.length, "open ticket")}.` : "No open tickets."}`;
  return result(said, [
    {
      kind: "list",
      title: "Customer",
      items: [
        { text: `${d.customer.name} · ${d.customer.email}`, href: `/customers/${d.customer.id}` },
        { text: `${plural(d.orders.length, "order")} · spent ${formatMoney(d.spentMinor)} net` },
        { text: `Money at risk: ${formatMoney(d.moneyAtRisk.totalMinor)} (owed refunds ${formatMoney(d.moneyAtRisk.owedMinor)}, unpaid ${formatMoney(d.moneyAtRisk.unpaidMinor)})` },
        { text: `Open tickets: ${d.openTickets.length}` },
      ],
    },
    {
      kind: "table",
      title: "Orders",
      columns: ["Order", "Amount", "Order status", "Payment", "Shipment"],
      rows: d.orders.slice(0, UI_ROWS).map((o) => [orderCell(o.id), formatMoney(o.amountMinor), o.status, o.paymentStatus ?? "-", o.shipmentStatus ?? "-"]),
    },
  ], { resultIds: d.orders.map((o) => o.id) });
}

function moneyAtRisk(): ToolResult {
  const owed = owedRefunds();
  const unpaid = unpaidShipped();
  const all = [...owed.orders, ...unpaid.orders].sort((a, b) => b.amountMinor - a.amountMinor);
  const said = [
    owed.count ? `${plural(owed.count, "cancelled order")} still ${owed.count === 1 ? "holds" : "hold"} ${formatMoney(owed.totalMinor)} that hasn't been refunded` : "No cancelled order is waiting for a refund",
    unpaid.count ? `${plural(unpaid.count, "shipped or delivered order")} worth ${formatMoney(unpaid.totalMinor)} ${unpaid.count === 1 ? "was" : "were"} never paid` : "every shipped or delivered order is paid",
  ].join(", and ");
  const title = all.length ? `${said}. The biggest is ${all[0].orderId} (${formatMoney(all[0].amountMinor)}).` : "Nothing is at risk: no owed refunds and no unpaid shipped orders.";
  return result(title, [
    {
      kind: "table",
      title: `Owed refunds: ${plural(owed.count, "cancelled order")}, ${formatMoney(owed.totalMinor)} captured and not refunded`,
      columns: ["Order", "Amount", "Request"],
      rows: owed.orders.map((o) => [orderCell(o.orderId), formatMoney(o.amountMinor), o.pendingApproval ? "pending approval" : "none yet"]),
    },
    {
      kind: "table",
      title: `Unpaid: ${plural(unpaid.count, "shipped or delivered order")} with a failed payment, ${formatMoney(unpaid.totalMinor)}`,
      columns: ["Order", "Status", "Amount", "Fix"],
      rows: unpaid.orders.map((o) => [orderCell(o.orderId), o.status, formatMoney(o.amountMinor), "open a support ticket"]),
    },
  ], { resultIds: [...owed.orders.map((o) => o.orderId), ...unpaid.orders.map((o) => o.orderId)] });
}

function teamQueues(queue: string | undefined): ToolResult {
  const all = getQueues();
  const names = queue ? [queue as keyof typeof all] : QUEUE_NAMES;
  const counts = names.map((n) => `${n[0].toUpperCase()}${n.slice(1)} has ${plural(all[n].count, "item")}`).join(", ");
  const busiest = [...names].sort((a, b) => all[b].count - all[a].count)[0];
  const top = all[busiest].items[0];
  const said = `${counts}.${top ? ` First in ${busiest}: ${top.title}${top.orderId ? ` (${top.orderId})` : ""}.` : ""}`;
  return result(said, names.map((n) => ({
    kind: "table" as const,
    title: `${n[0].toUpperCase()}${n.slice(1)} queue (${all[n].count})`,
    columns: ["Item", "Order", "Detail", "Next"],
    rows: all[n].items.slice(0, UI_ROWS).map((i) => [i.href ? { text: i.title, href: i.href } : i.title, i.orderId ? orderCell(i.orderId) : "-", i.detail ?? "-", i.nextAction ?? "-"]),
    more: { text: "Open the team queues", href: "/queues" },
  })));
}

function ticketList(input: Record<string, unknown>): ToolResult {
  const r = listTickets({ status: input.status as string | undefined, orderId: input.order_id as string | undefined, customerId: input.customer_id as string | undefined });
  const scope = [input.status, "ticket"].filter(Boolean).join(" ");
  const forWhat = input.order_id ? ` for ${input.order_id}` : input.customer_id ? ` for ${input.customer_id}` : "";
  const newest = r.items[0];
  const said = r.items.length
    ? `There ${r.items.length === 1 ? "is" : "are"} ${plural(r.items.length, scope)}${forWhat}. The newest is ${newest.id} on ${newest.orderId} (${newest.status}, ${formatIst(newest.createdAt)}).`
    : `There are no ${scope}s${forWhat}.`;
  return result(said, r.items.length ? [{
    kind: "table",
    title: "Tickets",
    columns: ["Ticket", "Order", "Customer", "Status", "Reason", "Created"],
    rows: r.items.slice(0, UI_ROWS).map((x) => [x.id, orderCell(x.orderId), x.customerName ?? "-", x.status, x.reason, formatIst(x.createdAt)]),
    more: { text: "Open tickets page", href: "/tickets" },
  }] : [], { resultIds: r.items.map((x) => x.orderId) });
}

function approvalList(status: string): ToolResult {
  const rows = listApprovals().filter((a) => a.status === status);
  const total = rows.reduce((s, a) => s + (a.amountMinor ?? 0), 0);
  const oldest = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const said = !rows.length
    ? `There are no ${status} refund requests.`
    : status === "pending"
      ? `${plural(rows.length, "refund request")} worth ${formatMoney(total)} ${rows.length === 1 ? "is" : "are"} waiting for a Manager. The oldest is ${oldest.orderId} (${formatMoney(oldest.amountMinor ?? 0)}), requested by ${oldest.requestedByLabel}.`
      : `${plural(rows.length, "refund request")} worth ${formatMoney(total)} ${rows.length === 1 ? "was" : "were"} ${status}.`;
  return result(said, rows.length ? [{
    kind: "table",
    title: "Refund approvals",
    columns: ["Order", "Amount", "Requested by", "Requested", "Status"],
    rows: rows.slice(0, UI_ROWS).map((a) => [orderCell(a.orderId), formatMoney(a.amountMinor), a.requestedByLabel, formatIst(a.createdAt), a.operationStatus]),
    more: { text: "Open the approval queue (Managers decide)", href: "/approvals" },
  }] : [], { resultIds: rows.map((a) => a.orderId) });
}

function workflowRuns(input: Record<string, unknown>): ToolResult {
  const db = getDb();
  let rows = db
    .select({ name: workflows.name, orderId: workflowExecutions.orderId, outcome: workflowExecutions.outcome, result: workflowExecutions.result, error: workflowExecutions.error, ranAt: workflowExecutions.ranAt })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .orderBy(desc(workflowExecutions.id))
    .limit(500)
    .all();
  if (input.outcome) rows = rows.filter((r) => r.outcome === input.outcome);
  if (input.order_id) rows = rows.filter((r) => r.orderId === input.order_id);
  if (input.ran_from) rows = rows.filter((r) => r.ranAt >= (input.ran_from as string));
  if (input.ran_to) rows = rows.filter((r) => r.ranAt < (input.ran_to as string));
  const by = (o: string) => rows.filter((r) => r.outcome === o).length;
  const latest = rows[0];
  const said = rows.length
    ? `${plural(rows.length, "workflow run")}: ${by("succeeded")} succeeded, ${by("skipped")} skipped, ${by("failed")} failed. The latest is ${latest.name}${latest.orderId ? ` on ${latest.orderId}` : ""} (${latest.outcome}, ${formatIst(latest.ranAt)}).`
    : "No workflow runs match.";
  return result(said, rows.length ? [{
    kind: "table",
    title: "Workflow runs (newest first)",
    columns: ["Workflow", "Order", "Outcome", "Detail", "Ran"],
    rows: rows.slice(0, UI_ROWS).map((r) => [r.name, r.orderId ? orderCell(r.orderId) : "-", r.outcome, r.error ?? r.result ?? "-", formatIst(r.ranAt)]),
    more: { text: "Open workflows", href: "/workflows" },
  }] : []);
}

function health(): ToolResult {
  const rows = getHealth();
  const down = rows.filter((r) => r.status === "down");
  const NAMES: Record<string, string> = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" };
  const lastSync = rows.map((r) => r.lastSyncAt).filter((x): x is string => Boolean(x)).sort().at(-1);
  const syncText = lastSync ? ` The last sync was ${formatIst(lastSync)}.` : " No sync has run yet.";
  const said = down.length
    ? `${down.map((d) => NAMES[d.service] ?? d.service).join(" and ")} ${down.length === 1 ? "is" : "are"} unreachable; I'm showing local data.${syncText}`
    : `All ${rows.length} services are up.${syncText}`;
  return result(said, [{
    kind: "table",
    title: "Services",
    columns: ["Service", "Status", "Last OK", "Last sync", "Sync result", "Last error"],
    rows: rows.map((r) => [r.service, r.status, formatIst(r.lastOkAt), formatIst(r.lastSyncAt), r.lastSyncStatus ?? "-", r.lastError ?? "-"]),
    more: { text: "Open integrations", href: "/integrations" },
  }]);
}

// Per customer: owed refunds (cancelled + captured, not refunded), unpaid shipped/delivered, orders, open tickets.
function customersAtRisk(): ToolResult {
  const db = getDb();
  const owner = new Map(db.select({ id: orders.id, c: orders.customerId }).from(orders).all().map((o) => [o.id, o.c]));
  const names = new Map(db.select({ id: customers.id, name: customers.name }).from(customers).all().map((c) => [c.id, c.name]));
  const per = new Map<string, { owed: number; unpaid: number; orders: number; tickets: number }>();
  const row = (id: string) => per.get(id) ?? per.set(id, { owed: 0, unpaid: 0, orders: 0, tickets: 0 }).get(id)!;
  for (const o of owedRefunds().orders) { const c = owner.get(o.orderId); if (c) row(c).owed += o.amountMinor; }
  for (const o of unpaidShipped().orders) { const c = owner.get(o.orderId); if (c) row(c).unpaid += o.amountMinor; }
  for (const c of owner.values()) if (per.has(c)) row(c).orders++;
  for (const t of db.select({ orderId: tickets.orderId }).from(tickets).where(eq(tickets.status, "open")).all()) { const c = owner.get(t.orderId); if (c && per.has(c)) row(c).tickets++; }
  const list = [...per.entries()].map(([id, r]) => ({ id, name: names.get(id) ?? id, ...r, total: r.owed + r.unpaid })).sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  const top = list[0];
  const said = top
    ? `${top.name} (${top.id}) has the most money at risk: ${formatMoney(top.total)} (${formatMoney(top.owed)} owed in refunds, ${formatMoney(top.unpaid)} unpaid). ${plural(list.length, "customer")} ${list.length === 1 ? "has" : "have"} money at risk, ${formatMoney(list.reduce((s2, c) => s2 + c.total, 0))} in total.`
    : "No customer has money at risk.";
  return result(said, list.length ? [{
    kind: "table",
    title: "Customers with money at risk (largest first)",
    columns: ["Customer", "At risk", "Owed refunds", "Unpaid", "Orders", "Open tickets"],
    rows: list.map((c) => [{ text: `${c.name} (${c.id})`, href: `/customers/${c.id}` }, formatMoney(c.total), formatMoney(c.owed), formatMoney(c.unpaid), String(c.orders), String(c.tickets)]),
  }] : []);
}

// Refunds in a time range (UTC ISO; default all time): approved, paid out (succeeded) and failed, each counted and summed.
function refundsSummary(from: string | undefined, to: string | undefined): ToolResult {
  const rows = getDb().select().from(refunds).all().filter((r) => (!from || r.createdAt >= from) && (!to || r.createdAt < to));
  const part = (st: string) => { const x = rows.filter((r) => r.status === st); return { n: x.length, sum: x.reduce((s2, r) => s2 + r.amountMinor, 0) }; };
  const ok = part("succeeded");
  const bad = part("failed");
  const when = from || to ? ` ${from ? `since ${formatIst(from)}` : ""}${from && to ? " and " : ""}${to ? `before ${formatIst(to)}` : ""}` : "";
  // Approved = a Manager said yes (decided in the range). Paid out = succeeded at the Payment API: the only money
  // that went out. Failed refunds are stated so the AI can't count them as money out.
  const approved = listApprovals().filter((x) => x.status === "approved" && x.decidedAt && (!from || x.decidedAt >= from) && (!to || x.decidedAt < to));
  const approvedSum = approved.reduce((s2, x) => s2 + (x.amountMinor ?? 0), 0);
  const said = `${plural(approved.length, "refund")} approved${when} (${formatMoney(approvedSum)}). Paid out (succeeded): ${plural(ok.n, "refund")}, ${formatMoney(ok.sum)}; that is the money that went out. Failed: ${plural(bad.n, "refund")}, ${formatMoney(bad.sum)}, not paid out.`;
  return result(said, rows.length ? [{
    kind: "table",
    title: "Refunds (newest first)",
    columns: ["Refund", "Order", "Amount", "Status", "When"],
    rows: [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => [r.id, orderCell(r.orderId), formatMoney(r.amountMinor), r.status, formatIst(r.createdAt)]),
  }] : []);
}

function briefing(): ToolResult {
  const issues = collectIssues();
  return result(briefingText(issues), issues.length ? [{
    kind: "list",
    title: "What needs attention (most urgent first)",
    items: issues.map((i) => ({ text: `${i.sentence[0].toUpperCase()}${i.sentence.slice(1)}`, href: i.href })),
  }] : []);
}

function searchAudit(input: Record<string, unknown>): ToolResult {
  const db = getDb();
  const cond = and(
    input.action ? eq(auditLog.action, input.action as string) : undefined,
    input.target ? eq(auditLog.target, input.target as string) : undefined,
    input.actor ? eq(auditLog.actorLabel, input.actor as string) : undefined,
  );
  const rows = db.select().from(auditLog).where(cond).orderBy(desc(auditLog.id)).limit(UI_ROWS).all();
  const a = rows[0];
  const said = rows.length
    ? `${plural(rows.length, "audit entry", "audit entries")}. The latest: ${a.actorLabel}${a.role ? ` (${a.role})` : ""} ${statusLabel(a.action).toLowerCase()}${a.target ? ` on ${a.target}` : ""} at ${formatIst(a.at)}, outcome ${a.outcome}.`
    : "No audit entries match.";
  return result(said, rows.length ? [{
    kind: "table",
    title: "Audit log (newest first)",
    columns: ["When", "Who", "Role", "Action", "Target", "Outcome"],
    rows: rows.map((r) => [formatIst(r.at), r.actorLabel, r.role ?? "-", statusLabel(r.action), r.target && /^NC-\d+$/.test(r.target) ? orderCell(r.target) : (r.target ?? "-"), r.outcome]),
    more: { text: "Open the audit log", href: "/audit" },
  }] : []);
}

// ---------- investigate (local data only) ----------

function investigate(id: string): ToolResult {
  const db = getDb();
  const order = db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return fail("not_found", `I can't find order ${id}. Check the id on the Orders page.`);
  const customer = db.select().from(customers).where(eq(customers.id, order.customerId)).get();
  const payment = db.select().from(payments).where(eq(payments.orderId, id)).get();
  const shipment = db.select().from(shipments).where(eq(shipments.orderId, id)).get();
  const ops = db.select().from(operations).where(eq(operations.orderId, id)).orderBy(desc(operations.id)).all();
  const orderTickets = db.select().from(tickets).where(eq(tickets.orderId, id)).all();
  const runs = db
    .select({ name: workflows.name, outcome: workflowExecutions.outcome, result: workflowExecutions.result, error: workflowExecutions.error })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(eq(workflowExecutions.orderId, id))
    .orderBy(desc(workflowExecutions.id))
    .all();
  const events = db.select().from(webhookEvents).where(eq(webhookEvents.orderId, id)).all();

  const ahead: string[] = [];
  if (order.upstreamStatus && order.status !== order.upstreamStatus) ahead.push(`order is ${order.status} locally but ${order.upstreamStatus} upstream`);
  if (payment?.upstreamStatus && payment.status !== payment.upstreamStatus) ahead.push(`payment is ${payment.status} locally but ${payment.upstreamStatus} upstream`);
  const list = (label: string, rows: string[]): Item => ({ text: rows.length ? `${label}: ${rows.join("; ")}` : `${label}: none` });

  const actions = allowedActions(order);
  const pay = !payment ? "has no payment on record" : payment.status === "captured" ? "paid" : `its payment ${payment.status}`;
  const ship = shipment ? `the shipment is ${shipment.status}` : "there is no shipment yet";
  const can = [actions.cancel.allowed && "cancel it", actions.refund.allowed && "request a refund", actions.reconcile.allowed && "push the cancel upstream"].filter(Boolean) as string[];
  const said = [
    `${id} is ${order.status} and ${pay}; ${ship}.`,
    ahead.length ? `Local data is ahead of upstream: ${ahead.join("; ")}.` : "",
    can.length ? `You can ${can.join(" or ")}.` : "",
  ].filter(Boolean).join(" ");
  return result(said, [
    {
      kind: "list",
      title: "Facts",
      items: [
        { text: `Order ${order.status}, ${formatMoney(order.amountMinor)}, ${customer?.name ?? order.customerId}, placed ${formatIst(order.createdAt)}`, href: orderLink(id) },
        { text: `Payment: ${payment ? `${payment.status}, ${formatMoney(payment.amountMinor)}` : "none on record"}` },
        { text: `Shipment: ${shipment ? `${shipment.status}, updated ${formatIst(shipment.updatedAt)}` : "none on record"}` },
        { text: ahead.length ? `LOCAL AHEAD: ${ahead.join("; ")}` : "Local data agrees with upstream." },
        list("Operations", ops.map((o) => `${o.type}${o.amountMinor ? ` ${formatMoney(o.amountMinor)}` : ""} ${o.status}${o.error ? ` (${o.error})` : ""}`)),
        list("Tickets", orderTickets.map((x) => `${x.id} ${x.status} "${x.reason}"`)),
        list("Workflow runs", runs.map((r) => `${r.name} → ${r.outcome}${(r.error ?? r.result) ? ` (${r.error ?? r.result})` : ""}`)),
        list("Webhook events", events.map((e) => `${e.eventId} ${e.type} ${e.status}`)),
      ],
    },
    { kind: "list", title: "What you can do next", items: nextSteps(order, payment, shipment?.status ?? null, orderTickets.length, ops) },
  ], { resultIds: [id] });
}

function nextSteps(
  order: typeof orders.$inferSelect,
  payment: typeof payments.$inferSelect | undefined,
  shipmentStatus: string | null,
  ticketCount: number,
  ops: { type: string; status: string }[],
): Item[] {
  const next: Item[] = [];
  const orderPage = orderLink(order.id);
  const actions = allowedActions(order);
  const reserving: readonly string[] = RESERVING_STATUSES;
  if (ops.some((o) => o.type === "refund" && reserving.includes(o.status))) next.push({ text: "A refund request is already open: a Manager decides it on the Approvals page", href: "/approvals" });
  else if (actions.refund.allowed) next.push({ text: `Request a refund of ${formatMoney(refundPosition(order.id).refundableMinor)} (ask: "refund ${order.id}")`, href: orderPage });
  if (actions.reconcile.allowed) next.push({ text: "Push the cancel upstream from the order page (a refund needs upstream to agree)", href: orderPage });
  if (actions.cancel.allowed) next.push({ text: `Cancel the order (ask: "cancel ${order.id}")`, href: orderPage });
  if (payment?.status === "failed" && ["shipped", "delivered"].includes(order.status) && ticketCount === 0) next.push({ text: `Open a support ticket for the unpaid order (ask: "create a ticket for ${order.id}")`, href: orderPage });
  if (shipmentStatus === "delayed") next.push({ text: "The shipment is delayed: check the workflow runs above", href: "/workflows" });
  if (next.length === 0) next.push({ text: "Nothing to do right now" });
  return next;
}

// ---------- proposals (never execute) ----------

function propose(name: "propose_cancel" | "propose_refund" | "propose_ticket", input: Record<string, unknown>, user: AuthUser): ToolResult {
  const verb = name === "propose_cancel" ? "cancel orders" : name === "propose_refund" ? "request refunds" : "create tickets";
  if (user.role === "viewer") return fail("denied", `Your role (viewer) cannot ${verb}. Ask an Operator or Manager.`);
  const id = input.order_id as string;
  const order = getDb().select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return fail("not_found", `I can't find order ${id}. Check the id on the Orders page.`);
  const page = { text: "Open the order page", href: orderLink(id) };
  if (name === "propose_cancel") {
    const a = allowedActions(order).cancel;
    if (!a.allowed) return result(`Order ${id} can't be cancelled: ${a.reason}.`, [{ kind: "list", title: "Order", items: [page] }]);
    return result(`Cancel order ${id}?`, [{ kind: "proposal", action: "cancel", orderId: id, label: `Cancel ${id} (${formatMoney(order.amountMinor)})`, note: "This calls the Commerce API as you when you confirm. Nothing happens until then." }]);
  }
  if (name === "propose_refund") {
    const amount = input.amount_minor as number | undefined;
    const refusal = refundRefusal(id, amount);
    if (refusal) return result(`A refund for ${id} is not possible: ${refusal}.`, [{ kind: "list", title: "Order", items: [page] }]);
    const max = refundPosition(id).refundableMinor;
    const amountMinor = amount ?? max;
    return result(`Request a refund of ${formatMoney(amountMinor)} for ${id}?`, [{ kind: "proposal", action: "refund", orderId: id, amountMinor, maxAmountMinor: max, label: `Refund ${formatMoney(amountMinor)} on ${id}`, note: "Confirming creates a request that waits for Manager approval. Nothing is sent to the Payment API until a Manager approves." }]);
  }
  return result(`Create a support ticket for ${id}?`, [{ kind: "proposal", action: "ticket", orderId: id, reason: input.reason as string, label: `Ticket for ${id}`, note: "Confirming creates the ticket in the Commerce API as you." }]);
}
