// Router (deterministic, no AI): simple lookups go to the parser; judgement questions (why, should, compare, which ...
// most, priorities, totals over a time range) go to the AI with ONLY the tools of 1-2 domains picked from the words.
import type { Role } from "@/server/db/schema";
import type { ToolName } from "./assistant-tools";

export type Domain = "money" | "customers" | "orders" | "operations" | "support" | "audit";

export const DOMAIN_TOOLS: Record<Domain, ToolName[]> = {
  money: ["money_at_risk", "customers_at_risk", "refunds_summary", "list_approvals"],
  customers: ["get_customer", "customers_at_risk"],
  orders: ["find_orders", "count_orders", "investigate_order"],
  operations: ["team_queues", "health_and_sync", "workflow_runs", "briefing"],
  support: ["list_tickets", "get_customer"],
  audit: ["search_audit"],
};
const FALLBACK_TOOLS: ToolName[] = ["briefing", "find_orders", "get_customer"];
export const MAX_TOOLS = 6;

const DOMAIN_WORDS: Record<Domain, RegExp> = {
  money: /\b(money|refunds?|refunded|owed|owe|paid|unpaid|stuck|at risk|approv\w*|revenue|went out|hurts?|cost|loss|captured|payments?)\b/g,
  customers: /\b(customers?|clients?|buyers?|c-\d+)\b/g,
  orders: /\b(orders?|shipments?|shipped|delayed|late|delivered|cancel\w*|nc-?\d+)\b/g,
  operations: /\b(operations|ops|teams?|queues?|end of day|eod|priorit\w*|health|services?|sync|workflows?|automations?|today'?s work|focus)\b/g,
  support: /\b(tickets?|support|complain\w*|escalat\w*)\b/g,
  audit: /\b(who|audit|history|changed)\b/g,
};

// Questions that need judgement, not a lookup.
const JUDGEMENT = [
  /\b(why|should|recommend\w*|suggest\w*|advise|compare|comparison|vs\.?|versus|explain|prioriti[sz]e|priorities|end of day|before eod|worth it)\b/,
  /\bwhich (customers?|orders?|teams?|shipments?|one)\b.*\b(most|first|best|worst|biggest|largest|least|more|hurts?)\b/,
  /\b(hurts? more|matters? more|more urgent|worse)\b/,
  /\bhow much\b.*\b(today|yesterday|this week|this month|last \d+ days|went out|in total)\b/,
  /\bhow many\b.*\band how much\b/,
];

const ACTION = /^(?:please\s+|can you\s+|could you\s+)?(cancel|refund|request|create|open|raise|file)\b/;

export interface Route {
  ai: boolean;
  why: string; // what made it a judgement question (or why the parser keeps it)
  domains: Domain[];
  tools: ToolName[];
}

export function pickDomains(t: string): Domain[] {
  const scored = (Object.keys(DOMAIN_WORDS) as Domain[])
    .map((d) => ({ d, n: (t.match(DOMAIN_WORDS[d]) ?? []).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  return scored.slice(0, 2).map((x) => x.d);
}

export function toolsFor(t: string, domains: Domain[], role: Role): ToolName[] {
  const base = domains.length ? domains.flatMap((d) => DOMAIN_TOOLS[d]) : FALLBACK_TOOLS;
  const action = ACTION.exec(t)?.[1];
  const propose: ToolName[] = [];
  if (action && role !== "viewer") {
    if (action === "cancel") propose.push("propose_cancel");
    else if (action === "refund" || action === "request") propose.push("propose_refund");
    else propose.push("propose_ticket");
  }
  const unique = [...new Set(base)].slice(0, MAX_TOOLS - propose.length);
  return [...unique, ...propose];
}

export function route(raw: string, parserIntent: string, role: Role): Route {
  const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
  const domains = pickDomains(t);
  const tools = toolsFor(t, domains, role);
  const hit = JUDGEMENT.find((re) => re.test(t));
  if (hit) return { ai: true, why: "a judgement question (compare, recommend, rank or total)", domains, tools };
  if (parserIntent === "no_match") return { ai: true, why: "a question the built-in parser can't place", domains, tools };
  return { ai: false, why: "a simple lookup", domains, tools };
}
