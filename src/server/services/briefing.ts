// Briefing: "what's our biggest problem", "how are we doing". Ranks open issues from local data by urgency, then money,
// and words the top ones as 2-4 plain sentences. Deterministic: every number and id comes from the rows below.
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { operations } from "@/server/db/schema";
import { formatMoney } from "@/lib/format";
import { listApprovals } from "./approvals";
import { owedRefunds, unpaidShipped } from "./dashboard";
import { getHealth } from "./health";
import { listOrders } from "./orders";

export const HIGH_VALUE_MINOR = 500000; // Rs 5,000: the delayed-shipment workflow's threshold
const SERVICE_NAMES = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" } as const;

export interface Issue {
  key: "services_down" | "owed_refunds" | "unpaid_shipped" | "delayed_high_value" | "failed_refunds" | "pending_approvals" | "local_ahead";
  urgent: boolean; // blocks work or loses money now: ranked above everything else
  moneyMinor: number;
  count: number;
  sentence: string; // one plain sentence, no trailing period
  href: string;
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const sum = (rows: { amountMinor: number | null }[]) => rows.reduce((s, r) => s + (r.amountMinor ?? 0), 0);

export function collectIssues(): Issue[] {
  const issues: Issue[] = [];
  const down = getHealth().filter((h) => h.status === "down");
  if (down.length) {
    issues.push({ key: "services_down", urgent: true, moneyMinor: 0, count: down.length, href: "/integrations", sentence: `${down.map((d) => SERVICE_NAMES[d.service]).join(" and ")} ${down.length === 1 ? "is" : "are"} unreachable, so actions that need ${down.length === 1 ? "it" : "them"} will fail until ${down.length === 1 ? "it is" : "they are"} back` });
  }
  const owed = owedRefunds();
  if (owed.count) {
    issues.push({ key: "owed_refunds", urgent: true, moneyMinor: owed.totalMinor, count: owed.count, href: "/queues?tab=finance", sentence: `${n(owed.count, "cancelled order")} still ${owed.count === 1 ? "holds" : "hold"} ${formatMoney(owed.totalMinor)} that hasn't been refunded` });
  }
  const unpaid = unpaidShipped();
  if (unpaid.count) {
    issues.push({ key: "unpaid_shipped", urgent: true, moneyMinor: unpaid.totalMinor, count: unpaid.count, href: "/queues?tab=finance", sentence: `${n(unpaid.count, "shipped or delivered order")} worth ${formatMoney(unpaid.totalMinor)} ${unpaid.count === 1 ? "was" : "were"} never paid` });
  }
  const delayed = listOrders({ shipmentStatus: "delayed", page: 1, pageSize: 500 }).items.filter((o) => o.amountMinor > HIGH_VALUE_MINOR);
  if (delayed.length) {
    issues.push({ key: "delayed_high_value", urgent: false, moneyMinor: sum(delayed), count: delayed.length, href: "/orders?shipmentStatus=delayed", sentence: `${n(delayed.length, "delayed shipment")} over ${formatMoney(HIGH_VALUE_MINOR)} ${delayed.length === 1 ? "is" : "are"} worth ${formatMoney(sum(delayed))}` });
  }
  const failed = getDb().select().from(operations).where(and(eq(operations.type, "refund"), eq(operations.status, "failed"))).all();
  if (failed.length) {
    issues.push({ key: "failed_refunds", urgent: false, moneyMinor: sum(failed), count: failed.length, href: "/approvals", sentence: `${n(failed.length, "approved refund")} worth ${formatMoney(sum(failed))} failed at the Payment API and can be retried` });
  }
  const pending = listApprovals().filter((a) => a.status === "pending");
  if (pending.length) {
    issues.push({ key: "pending_approvals", urgent: false, moneyMinor: sum(pending), count: pending.length, href: "/approvals", sentence: `${n(pending.length, "refund request")} worth ${formatMoney(sum(pending))} ${pending.length === 1 ? "is" : "are"} waiting for a Manager` });
  }
  const ahead = listOrders({ localAhead: true, page: 1, pageSize: 500 }).items;
  if (ahead.length) {
    issues.push({ key: "local_ahead", urgent: false, moneyMinor: 0, count: ahead.length, href: "/orders?localAhead=true", sentence: `${n(ahead.length, "order")} ${ahead.length === 1 ? "is" : "are"} ahead of upstream locally (a webhook the service doesn't know yet)` });
  }
  // A service down blocks everything, so it leads; then urgent money issues, then the rest; by money, then count.
  const rank = (i: Issue) => (i.key === "services_down" ? 2 : i.urgent ? 1 : 0);
  return issues.sort((a, b) => rank(b) - rank(a) || b.moneyMinor - a.moneyMinor || b.count - a.count);
}

export function briefingText(issues: Issue[]): string {
  if (issues.length === 0) return "Nothing needs attention right now: no money at risk, no pending approvals and every service is up.";
  const [first, ...rest] = issues;
  const parts = [`The biggest issue: ${first.sentence}.`];
  if (rest[0]) parts.push(`Next, ${rest[0].sentence}.`);
  if (rest[1]) parts.push(`Also, ${rest[1].sentence}.`);
  if (rest.length > 2) parts.push(`${n(rest.length - 2, "more item")} below.`);
  return parts.join(" ");
}
