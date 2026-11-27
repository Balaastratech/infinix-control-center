// Built-in assistant parser (always on, no key). Pure: text + last context + customer list -> intent, tool input and an
// "I understood: …" line. No DB access, so the phrasing table in tests/assistant-parser.test.ts runs instantly.
// docs/assistant-design.md section 3.
import { formatMoney } from "@/lib/format";

export interface OrderFilters {
  q?: string;
  orderStatus?: string;
  orderStatuses?: string[];
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
  notice?: string; // a quiet note shown with the answer ("one request at a time", "approve on the Approvals page")
}

export const HELP_INTRO =
  "I can help with orders, customers, money at risk, refunds and approvals, tickets, team queues, workflow runs, service health and the audit log. Try one of these:";

export const HELP = [
  "what needs attention",
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

// The amount in a refund request: "Rs 500", "500 rupees", "500 rs", or a bare number right after "refund"
// ("refund 500 for NC-1002"). The order id is already removed from the text. null = the full amount.
const NUM = String.raw`(\d[\d,]*(?:\.\d{1,2})?)\s*(k|lakhs?|l)?`;
const REFUND_AMOUNT = [
  new RegExp(String.raw`(?:rs\.?|₹|inr)\s*${NUM}\b`, "i"),
  new RegExp(String.raw`${NUM}\s*(?:rupees?|rs\.?|inr)(?![a-z])`, "i"),
  new RegExp(String.raw`\brefund\s+(?:of\s+)?${NUM}\b`, "i"),
];
function refundAmount(text: string): number | null {
  for (const re of REFUND_AMOUNT) {
    const m = re.exec(text);
    if (m) return amountToPaise(m[1], m[2]);
  }
  return null;
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

// ---------- typo tolerance (known keywords only) ----------

// Words the parser keys on. A word of 5+ letters not in this list that is 1 edit away (2 for 7+ letters) from exactly
// one of them is read as it; anything else is left alone, so names, ids and amounts are never "corrected".
const VOCAB = [
  "late", "stuck", "delayed", "unpaid", "captured", "cancelled", "canceled", "shipped", "delivered", "processing",
  "order", "orders", "shipment", "shipments", "payment", "payments", "purchases", "refund", "refunds", "ticket", "tickets",
  "approval", "approvals", "approved", "approve", "rejected", "pending", "waiting", "workflow", "workflows", "automation",
  "automations", "queue", "queues", "finance", "support", "operations", "health", "service", "services", "outage",
  "integration", "integrations", "errors", "customer", "customers", "money", "audit", "history", "cancel", "investigate",
  "today", "yesterday", "between", "above", "below", "under", "unreachable", "mismatch", "failed", "succeeded", "skipped",
  // known words that are not keywords, so they are never "corrected" into one
  "delivery", "refunded", "shipping", "cancelling", "cancellation", "approver", "stock",
];
const VOCAB_SET = new Set(VOCAB);

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export function fixTypos(t: string): string {
  return t.replace(/[a-z]{5,}/g, (w) => {
    if (VOCAB_SET.has(w)) return w;
    const max = w.length >= 7 ? 2 : 1;
    const scored = VOCAB.filter((v) => Math.abs(v.length - w.length) <= max).map((v) => ({ v, d: editDistance(w, v) })).filter((x) => x.d <= max);
    if (scored.length === 0) return w;
    const best = Math.min(...scored.map((x) => x.d));
    const top = scored.filter((x) => x.d === best);
    return top.length === 1 ? top[0].v : w; // a tie is a guess: leave it
  });
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

// Two requests in one message ("cancel NC-1001 and refund NC-1002", "late orders; open tickets"): answer the first only.
const SPLIT = /\s*(?:;|\?\s+(?=\S)|\s(?:and then|then|also)\s|\s+and\s+(?=(?:cancel|refund|show|list|create|open|raise|investigate|who|how many|what|which|approve|reject|count|find)\b))\s*/i;

export function parse(raw: string, last: AssistantContext | null, customers: CustomerRef[], now = new Date()): Parsed {
  const parts = raw.split(SPLIT).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    const second = parseOne(parts.slice(1).join(" "), null, customers, now);
    if (second.call || second.intent === "ambiguous") {
      const first = parseOne(parts[0], last, customers, now);
      return { ...first, notice: "One request at a time: I answered the first one. Ask the next one on its own." };
    }
  }
  return parseOne(raw, last, customers, now);
}

function parseOne(raw: string, last: AssistantContext | null, customers: CustomerRef[], now: Date): Parsed {
  const text = raw.trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  const t = fixTypos(lower);
  const oid = ORDER_ID.exec(text);
  const orderId = oid ? `NC-${oid[1] ?? oid[2]}` : null;

  if (/^(help|\?|what can you do)/.test(t)) return { intent: "help", understood: "I understood: a request for help", suggestions: HELP };

  // Open questions -> a ranked briefing ("what's our biggest problem", "how are we doing", "summary of today").
  if (!orderId && /\b(biggest (problem|issue|risk)s?|how are (we|things) doing|how's (it|business) going|needs? (my |our )?attention|what should (i|we) (do|look at|focus on|worry about)|anything urgent|summary|overview|briefing|brief me|status report|state of things)\b/.test(t))
    return tool("briefing", {}, ["a briefing: open issues ranked by urgency and money"]);

  const asksWho = /\bwho\b|\bby whom\b/.test(t);

  // Approving or rejecting is never done here: point to the Approvals queue (Managers decide there), no new proposal.
  if (!asksWho && /\b(approve|reject|deny|decline)\b/.test(t) && (orderId || /\brefunds?\b/.test(t))) {
    return {
      ...tool("list_approvals", { status: "pending" }, ["approving or rejecting a refund happens on the Approvals page, by a Manager", "showing pending requests"]),
      notice: "Refunds are approved or rejected on the Approvals page by a Manager who did not request them. The assistant can't approve.",
    };
  }

  // "who is the customer for NC-1003" / "customer of NC-1003": the customer, not the audit log.
  if (orderId && /\bcustomer\b/.test(t) && !/\b(cancel|refund|approv|reject|ticket|audit)/.test(t)) {
    return tool("get_customer", { order_id: orderId }, [`the customer of order ${orderId}`]);
  }

  // Negation: "don't cancel NC-1002, just show it" -> the negated action words don't count as a request.
  const ta = t.replace(/\b(?:don'?t|do not|never|no need to|not)\s+(?:\w+\s+){0,2}?(?:cancel|refund|create|open|raise)\w*/g, " ");

  // Actions: proposals only (a Confirm button does the real request).
  if (orderId && /\bcancel\b/.test(ta) && !/\bwho\b/.test(t)) return tool("propose_cancel", { order_id: orderId }, [`cancel order ${orderId} (needs your confirmation)`]);
  if (orderId && /\b(refund)\b/.test(ta) && !/\bwho\b|\bstatus\b|\binvestigate\b/.test(t)) {
    const rest = text.replace(oid![0], " ");
    const amountMinor = refundAmount(rest);
    return tool("propose_refund", amountMinor ? { order_id: orderId, amount_minor: amountMinor } : { order_id: orderId }, [
      `refund for ${orderId}`,
      amountMinor ? formatMoney(amountMinor) : "full refundable amount",
      "needs your confirmation, then Manager approval",
    ]);
  }
  if (orderId && /\b(ticket)\b/.test(ta) && /\b(create|open|raise|file|make|new|add)\b/.test(ta)) {
    const reason = /(?:because|reason:?|saying|:)\s*(.{3,})$/i.exec(text)?.[1]?.trim();
    return tool("propose_ticket", { order_id: orderId, reason: (reason ?? `Follow-up on ${orderId} (raised from the assistant)`).slice(0, 200) }, [
      `support ticket for ${orderId}`,
      "needs your confirmation",
    ]);
  }

  // Audit: "who cancelled NC-1004", "who approved refunds", "audit for NC-1002".
  if (asksWho || /\baudit\b|\bhistory of\b/.test(t)) {
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
    if (asksWho && !action && !orderId && !/\baudit\b/.test(t)) return noMatch(t); // "who won the world cup"
    const input: Record<string, unknown> = {};
    if (action) input.action = action;
    if (orderId) input.target = orderId;
    return tool("search_audit", input, ["audit log", action ? `action ${action}` : "any action", orderId ? `on ${orderId}` : "any target"]);
  }

  if (/\b(health|down|outage|unreachable|services?|apis?|sync|synced|syncing|integrations?|errors?|failing|up\b)/.test(t) && !orderId && !/\borders?\b|\bworkflows?\b|\bautomations?\b/.test(t))
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
    const when = dates(t, now);
    const input: Record<string, unknown> = {};
    if (outcome) input.outcome = outcome;
    if (when.from) input.ran_from = when.from;
    if (when.to) input.ran_to = when.to;
    return tool("workflow_runs", input, ["workflow runs", outcome ?? "any outcome", when.label ? `ran ${when.label}` : "any time"]);
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
  const found = customerMatches(lower, customers);
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
  // "shipped but not paid" means the order left the warehouse: shipped or delivered (as on the dashboard).
  if (filters.orderStatus === "shipped" && filters.paymentStatus === "failed") {
    delete filters.orderStatus;
    filters.orderStatuses = ["shipped", "delivered"];
    st.parts[st.parts.indexOf("order shipped")] = "order shipped or delivered";
  }
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
    return tool(intent, input, [intent === "count_orders" ? "count orders" : "orders", ...describe(merged), refersBack ? "within your previous result" : "added to your previous filters"]);
  }

  const mentionsOrders = /\b(orders?|shipments?|payments?|purchases?)\b/.test(t);
  if (customer && !mentionsOrders && parts.length === 1 && !counting) return tool("get_customer", { customer_id: customer.id }, [`customer view for ${customer.name} (${customer.id})`]);
  if (parts.length > 0 || mentionsOrders) {
    const intent = counting ? "count_orders" : "find_orders";
    return tool(intent, { ...filters }, [intent === "count_orders" ? "count orders" : "orders", ...(parts.length ? parts : ["no filter"])]);
  }
  return noMatch(t);
}

// Readable filter list for the "I understood" line (used for follow-ups, where filters carry over).
function describe(f: OrderFilters): string[] {
  const out: string[] = [];
  if (f.shipmentStatus) out.push(`shipment ${f.shipmentStatus}`);
  if (f.paymentStatus) out.push(`payment ${f.paymentStatus}`);
  if (f.localAhead) out.push("local ahead");
  if (f.orderStatus) out.push(`order ${f.orderStatus}`);
  if (f.orderStatuses) out.push(`order ${f.orderStatuses.join(" or ")}`);
  if (f.minAmountMinor !== undefined) out.push(`amount over ${formatMoney(f.minAmountMinor)}`);
  if (f.maxAmountMinor !== undefined) out.push(`amount under ${formatMoney(f.maxAmountMinor)}`);
  if (f.createdFrom) out.push(`placed from ${f.createdFrom.slice(0, 16)} UTC`);
  if (f.createdTo) out.push(`placed before ${f.createdTo.slice(0, 16)} UTC`);
  if (f.customerId) out.push(`customer ${f.customerId}`);
  return out.length ? out : ["no filter"];
}

function noMatch(t: string): Parsed {
  return { intent: "no_match", understood: "I understood: nothing I can look up", question: HELP_INTRO, suggestions: suggest(t) };
}
