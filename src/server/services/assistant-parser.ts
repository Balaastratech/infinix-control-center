// Built-in assistant parser (always on, no key). Pure: text + last context + customer list -> intent, tool input and an
// "I understood: …" line. No DB access, so the phrasing table in tests/assistant-parser.test.ts runs instantly.
// docs/assistant-design.md section 3.
import { formatMoney } from "@/lib/format";

export interface OrderFilters {
  q?: string;
  orderStatus?: string;
  paymentStatus?: string;
  shipmentStatus?: string;
  localAhead?: boolean;
  customerId?: string;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  createdFrom?: string;
  createdTo?: string;
}

// What the next question can refer back to ("which of those …").
export interface AssistantContext {
  intent: string;
  filters?: OrderFilters;
  resultIds?: string[];
}

export interface CustomerRef {
  id: string;
  name: string;
  email: string;
}

export type ToolCall = { tool: string; input: Record<string, unknown> };

export interface Parsed {
  intent: string; // a tool's intent, "help", "ambiguous" or "no_match"
  call?: ToolCall;
  understood: string;
  suggestions?: string[];
  question?: string; // ambiguity / no-match text
}

export const HELP = [
  "money at risk",
  "late orders over Rs 5,000",
  "how many cancelled orders this week",
  "unpaid shipped orders",
  "investigate order NC-1004",
  "orders for Demo Customer 3",
  "refunds waiting for approval",
  "open tickets",
  "what's in the finance queue",
  "failed workflow runs",
  "is any service down",
  "who cancelled NC-1004",
  "request a refund for NC-1002",
];

const ORDER_ID = /\b(?:order\s*#?\s*)?nc[-\s]?(\d{1,10})\b|\border\s*#?\s*(\d{3,10})\b/i;
const CUSTOMER_ID = /\bc-(\d{3})\b/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// ---------- money ----------

// "10,000" / "1,00,000" / "10k" / "1.5 lakh" / "2500.50" -> paise, integer maths only.
export function amountToPaise(digits: string, unit?: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(digits.replace(/,/g, ""));
  if (!m) return null;
  const base = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  const u = (unit ?? "").toLowerCase();
  const mult = u === "k" ? 1000 : /^(lakh|lakhs|lac|lacs|l)$/.test(u) ? 100000 : /^(crore|cr)$/.test(u) ? 10000000 : 1;
  const paise = base * mult;
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

const AMT = String.raw`(?:rs\.?|₹|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|lakhs?|lacs?|l|crore|cr)?\b`;

function amounts(t: string): Pick<OrderFilters, "minAmountMinor" | "maxAmountMinor"> {
  const between = new RegExp(String.raw`between\s+${AMT}\s+(?:and|to|-)\s+${AMT}`, "i").exec(t);
  if (between) {
    const a = amountToPaise(between[1], between[2]);
    const b = amountToPaise(between[3], between[4]);
    if (a !== null && b !== null) return { minAmountMinor: Math.min(a, b) - 1, maxAmountMinor: Math.max(a, b) + 1 };
  }
  const out: Pick<OrderFilters, "minAmountMinor" | "maxAmountMinor"> = {};
  const over = new RegExp(String.raw`(?:over|above|more than|greater than|bigger than|>|at least|>=|min(?:imum)?)\s*${AMT}`, "i").exec(t);
  if (over) {
    const v = amountToPaise(over[1], over[2]);
    if (v !== null) out.minAmountMinor = /at least|>=|min/i.test(over[0]) ? v - 1 : v;
  }
  const under = new RegExp(String.raw`(?:under|below|less than|smaller than|<|at most|<=|max(?:imum)?)\s*${AMT}`, "i").exec(t);
  if (under) {
    const v = amountToPaise(under[1], under[2]);
    if (v !== null) out.maxAmountMinor = /at most|<=|max/i.test(under[0]) ? v + 1 : v;
  }
  return out;
}

// ---------- dates (IST days, stored as UTC) ----------

const IST_MS = 330 * 60 * 1000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function istMidnightUtc(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d) - IST_MS).toISOString();
}

function dates(t: string, now: Date): { from?: string; to?: string; label?: string } {
  const ist = new Date(now.getTime() + IST_MS);
  const [y, m, d] = [ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()];
  if (/\btoday\b/.test(t)) return { from: istMidnightUtc(y, m, d), label: "today" };
  if (/\byesterday\b/.test(t)) return { from: istMidnightUtc(y, m, d - 1), to: istMidnightUtc(y, m, d), label: "yesterday" };
  if (/\b(this week|last 7 days|past week|last week)\b/.test(t)) return { from: istMidnightUtc(y, m, d - 6), label: "last 7 days" };
  if (/\bthis month\b/.test(t)) return { from: istMidnightUtc(y, m, 1), label: "this month" };
  const iso = /\b(since|after|from|on|before)\s+(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  const dm = new RegExp(String.raw`\b(since|after|from|on|before)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTHS.join("|")})[a-z]*\b`).exec(t);
  let word: string | undefined;
  let day: [number, number, number] | undefined;
  if (iso) [word, day] = [iso[1], [Number(iso[2]), Number(iso[3]) - 1, Number(iso[4])]];
  else if (dm) [word, day] = [dm[1], [y, MONTHS.indexOf(dm[3]), Number(dm[2])]];
  if (!word || !day) return {};
  const start = istMidnightUtc(...day);
  const next = istMidnightUtc(day[0], day[1], day[2] + 1);
  const label = `${word} ${new Date(Date.UTC(...day)).toISOString().slice(0, 10)}`;
  if (word === "on") return { from: start, to: next, label };
  if (word === "before") return { to: start, label };
  return { from: word === "after" ? next : start, label };
}

// ---------- customers ----------

function customerMatches(t: string, customers: CustomerRef[]): CustomerRef[] {
  const id = CUSTOMER_ID.exec(t);
  if (id) return customers.filter((c) => c.id.toLowerCase() === `c-${id[1]}`);
  const email = EMAIL.exec(t);
  if (email) return customers.filter((c) => c.email.toLowerCase() === email[0].toLowerCase());
  const esc = (s: string) => s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (s: string) => s.length >= 4 && new RegExp(`(^|[^a-z0-9])${esc(s)}($|[^a-z0-9])`).test(t);
  const full = customers.filter((c) => has(c.name));
  if (full.length) return full;
  // "customer 3" for "Demo Customer 3": the name without its first word, if that is still specific.
  return customers.filter((c) => {
    const rest = c.name.split(/\s+/).slice(1).join(" ");
    return rest.includes(" ") && has(rest);
  });
}

// ---------- statuses ----------

function statuses(t: string): { filters: OrderFilters; parts: string[]; conflict?: string[] } {
  const f: OrderFilters = {};
  const parts: string[] = [];
  if (/\b(late|stuck|delayed|delays?)\b/.test(t)) [f.shipmentStatus, parts[parts.length]] = ["delayed", "shipment delayed"];
  if (/\b(unpaid|not paid|payment failed|failed payments?|payments? failed)\b/.test(t)) [f.paymentStatus, parts[parts.length]] = ["failed", "payment failed"];
  else if (/\b(captured|paid)\b/.test(t)) [f.paymentStatus, parts[parts.length]] = ["captured", "payment captured"];
  if (/\b(local(ly)? ahead|out of sync|mismatch(ed)?)\b/.test(t)) [f.localAhead, parts[parts.length]] = [true, "local ahead"];
  const orderStatuses = [
    ["cancelled", /\bcancell?ed\b/],
    ["shipped", /\bshipped\b/],
    ["delivered", /\bdelivered\b/],
    ["processing", /\b(processing|open orders|not shipped)\b/],
  ] as const;
  const found = orderStatuses.filter(([, re]) => re.test(t)).map(([s]) => s);
  if (found.length > 1) return { filters: f, parts, conflict: found };
  if (found.length === 1) [f.orderStatus, parts[parts.length]] = [found[0], `order ${found[0]}`];
  return { filters: f, parts };
}

// ---------- main ----------

const FOLLOW_UP_REF = /\b(those|these|them|of them|which ones|the same|that list)\b/;
const FOLLOW_UP_START = /^(and|also|only|now|what about|how about)\b/;

function suggest(t: string): string[] {
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  return HELP.map((h) => ({ h, n: h.split(/\s+/).filter((w) => words.has(w)).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => x.h);
}

const tool = (intent: string, input: Record<string, unknown>, understood: string[]): Parsed => ({
  intent,
  call: { tool: intent, input },
  understood: `I understood: ${understood.join(" · ")}`,
});

export function parse(raw: string, last: AssistantContext | null, customers: CustomerRef[], now = new Date()): Parsed {
  const text = raw.trim().replace(/\s+/g, " ");
  const t = text.toLowerCase();
  const oid = ORDER_ID.exec(text);
  const orderId = oid ? `NC-${oid[1] ?? oid[2]}` : null;

  if (/^(help|\?|what can you do)/.test(t)) return { intent: "help", understood: "I understood: a request for help", suggestions: HELP };

  // Actions: proposals only (a Confirm button does the real request).
  if (orderId && /\bcancel\b/.test(t) && !/\bwho\b/.test(t)) return tool("propose_cancel", { order_id: orderId }, [`cancel order ${orderId} (needs your confirmation)`]);
  if (orderId && /\b(refund)\b/.test(t) && !/\bwho\b|\bstatus\b|\binvestigate\b/.test(t)) {
    const rest = text.replace(oid![0], " ");
    const amt = new RegExp(String.raw`(?:of|for|amount)?\s*(?:rs\.?|₹|inr)\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|lakhs?|l)?\b`, "i").exec(rest);
    const amountMinor = amt ? amountToPaise(amt[1], amt[2]) : null;
    return tool("propose_refund", amountMinor ? { order_id: orderId, amount_minor: amountMinor } : { order_id: orderId }, [
      `refund for ${orderId}`,
      amountMinor ? formatMoney(amountMinor) : "full refundable amount",
      "needs your confirmation, then Manager approval",
    ]);
  }
  if (orderId && /\b(ticket)\b/.test(t) && /\b(create|open|raise|file|make|new|add)\b/.test(t)) {
    const reason = /(?:because|reason:?|saying|:)\s*(.{3,})$/i.exec(text)?.[1]?.trim();
    return tool("propose_ticket", { order_id: orderId, reason: (reason ?? `Follow-up on ${orderId} (raised from the assistant)`).slice(0, 200) }, [
      `support ticket for ${orderId}`,
      "needs your confirmation",
    ]);
  }

  // Audit: "who cancelled NC-1004", "who approved refunds", "audit for NC-1002".
  if (/\bwho\b|\bby whom\b|\baudit\b|\bhistory of\b/.test(t)) {
    const action = /\bapprov/.test(t)
      ? "refund.approve"
      : /\breject/.test(t)
        ? "refund.reject"
        : /\brefund/.test(t)
          ? "refund.request"
          : /\bcancel/.test(t)
            ? "order.cancel"
            : /\bticket/.test(t)
              ? "ticket.create"
              : /\bworkflow/.test(t)
                ? "workflow.update"
                : undefined;
    const input: Record<string, unknown> = {};
    if (action) input.action = action;
    if (orderId) input.target = orderId;
    return tool("search_audit", input, ["audit log", action ? `action ${action}` : "any action", orderId ? `on ${orderId}` : "any target"]);
  }

  if (/\b(health|down|outage|unreachable|services?|apis?|sync|synced|syncing|up\b)/.test(t) && !orderId && !/\borders?\b/.test(t))
    return tool("health_and_sync", {}, ["service health and last sync"]);
  if (/\bat risk\b|\bowed\b|\bmoney\b/.test(t) && !/\borders?\b.*\b(over|under|between)\b/.test(t)) return tool("money_at_risk", {}, ["money at risk (owed refunds + unpaid orders)"]);
  if (/\bapprov|\bwaiting\b|\bpending refunds?\b/.test(t)) {
    const status = /\bapproved\b/.test(t) ? "approved" : /\brejected\b/.test(t) ? "rejected" : "pending";
    return tool("list_approvals", { status }, [`refund approvals · ${status}`]);
  }
  if (/\btickets?\b/.test(t)) {
    const input: Record<string, unknown> = {};
    if (/\bopen\b/.test(t)) input.status = "open";
    else if (/\bclosed\b/.test(t)) input.status = "closed";
    if (orderId) input.order_id = orderId;
    return tool("list_tickets", input, ["tickets", (input.status as string) ?? "any status", orderId ? `for ${orderId}` : "all orders"]);
  }
  const queue = /\b(operations|ops|finance|support)\b/.exec(t);
  if (/\bqueues?\b|\bwork ?list\b|\bteam\b/.test(t) || (queue && /\b(team|queue|work)\b/.test(t))) {
    const q = queue ? (queue[1] === "ops" ? "operations" : queue[1]) : undefined;
    return tool("team_queues", q ? { queue: q } : {}, [`team queues · ${q ?? "all teams"}`]);
  }
  if (/\bworkflows?\b|\bautomations?\b|\bruns?\b/.test(t)) {
    const outcome = /\bfail/.test(t) ? "failed" : /\bskip/.test(t) ? "skipped" : /\bsucce/.test(t) ? "succeeded" : undefined;
    return tool("workflow_runs", outcome ? { outcome } : {}, ["workflow runs", outcome ?? "any outcome"]);
  }
  if (orderId) return tool("investigate_order", { order_id: orderId }, [`investigate order ${orderId}`]);

  // Orders, with any filter mix, a customer, or a follow-up on the last list.
  const st = statuses(t);
  if (st.conflict) {
    return {
      intent: "ambiguous",
      understood: `I understood: orders, but with more than one order status (${st.conflict.join(", ")})`,
      question: "Which order status do you mean?",
      suggestions: st.conflict.map((s) => `${s} orders`),
    };
  }
  const amt = amounts(t);
  const dt = dates(t, now);
  const found = customerMatches(t, customers);
  if (found.length > 1) {
    return {
      intent: "ambiguous",
      understood: `I understood: a customer, but ${found.length} customers match`,
      question: "Which customer do you mean?",
      suggestions: found.slice(0, 5).map((c) => `orders for ${c.name}`),
    };
  }
  const customer = found[0];
  const counting = /\bhow many\b|\bcount\b|\bnumber of\b|\btotal\b/.test(t);
  const filters: OrderFilters = { ...st.filters, ...amt };
  if (dt.from) filters.createdFrom = dt.from;
  if (dt.to) filters.createdTo = dt.to;
  if (customer) filters.customerId = customer.id;
  const parts = [...st.parts];
  if (amt.minAmountMinor !== undefined) parts.push(`amount over ${formatMoney(amt.minAmountMinor)}`);
  if (amt.maxAmountMinor !== undefined) parts.push(`amount under ${formatMoney(amt.maxAmountMinor)}`);
  if (dt.label) parts.push(`placed ${dt.label}`);
  if (customer) parts.push(`customer ${customer.name} (${customer.id})`);

  const isOrderList = last && (last.intent === "find_orders" || last.intent === "count_orders");
  const refersBack = isOrderList && FOLLOW_UP_REF.test(t);
  const continues = isOrderList && !refersBack && FOLLOW_UP_START.test(t) && Object.keys(filters).length > 0;
  if (refersBack || continues) {
    const merged = { ...last!.filters, ...filters };
    const input: Record<string, unknown> = { ...merged };
    if (refersBack) input.order_ids = last!.resultIds ?? [];
    const intent = counting ? "count_orders" : "find_orders";
    return tool(intent, input, [intent === "count_orders" ? "count orders" : "orders", ...(parts.length ? parts : ["same filters"]), refersBack ? "within your previous result" : "added to your previous filters"]);
  }

  const mentionsOrders = /\b(orders?|shipments?|payments?|purchases?)\b/.test(t);
  if (customer && !mentionsOrders && parts.length === 1 && !counting) return tool("get_customer", { customer_id: customer.id }, [`customer view for ${customer.name} (${customer.id})`]);
  if (parts.length > 0 || mentionsOrders) {
    const intent = counting ? "count_orders" : "find_orders";
    return tool(intent, { ...filters }, [intent === "count_orders" ? "count orders" : "orders", ...(parts.length ? parts : ["no filter"])]);
  }
  return {
    intent: "no_match",
    understood: "I understood: nothing I can look up",
    question: "I didn't understand that. Try one of these:",
    suggestions: suggest(t),
  };
}
