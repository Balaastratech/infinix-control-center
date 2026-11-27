// Support tickets: one safe path to POST /commerce/tickets for both workflows and people, plus the local list.
// POST has no idempotency key: before any retry we look for the ticket a lost reply may have created (CLAUDE.md).
import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { BACKOFF_MS, isValidId, request, type ApiResult } from "@/server/clients/mock";
import { getDb } from "@/server/db";
import { customers, orders, tickets } from "@/server/db/schema";
import { audit, type Actor } from "./audit";
import { recordHealth, recordNetworkFailure } from "./health";

const ticketReply = z.object({ id: z.string(), order_id: z.string(), reason: z.string(), status: z.string() });
type UpstreamTicket = z.infer<typeof ticketReply>;
const MAX_ATTEMPTS = 3;
const unreachable = (res: ApiResult<unknown>) => !res.ok && (res.status === null || res.status === 503);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const ticketReasonSchema = z.string().trim().min(1, "reason is required").max(500);

export type TicketResult = { ok: true; ticketId: string; how: string } | { ok: false; code: "not_found" | "upstream"; reason: string };

interface TicketOpts {
  auditAction: string; // "ticket.create" (person) or "workflow.create_ticket"
  workflowExecutionId?: number;
}

// Creates the ticket upstream, saves the local copy, audits. Never throws for API failures.
export async function submitTicket(orderId: string, reason: string, actor: Actor, opts: TicketOpts): Promise<TicketResult> {
  const log = (outcome: string, detail: Record<string, unknown>) =>
    audit({ userId: actor.userId, actorLabel: actor.label, role: actor.role, action: opts.auditAction, target: orderId, outcome, detail: { executionId: opts.workflowExecutionId, ...detail } });
  if (!isValidId(orderId) || !getDb().select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get()) {
    return { ok: false, code: "not_found", reason: "unknown order" };
  }
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(BACKOFF_MS[attempt - 2]);
      const existing = await findLostTicket(orderId, reason);
      if (existing === "unavailable") {
        const error = `${lastError}; could not verify whether the ticket exists`;
        log("failed", { error });
        return { ok: false, code: "upstream", reason: error };
      }
      if (existing) return save(existing, actor, opts, "adopted after a lost reply", log);
    }
    const res = await request<unknown>("POST", "/commerce/tickets", { order_id: orderId, reason }, false);
    recordNetworkFailure("commerce", res);
    if (res.ok) {
      const t = ticketReply.safeParse(res.data);
      if (!t.success || t.data.order_id !== orderId) {
        const error = `unexpected ticket reply: ${JSON.stringify(res.data).slice(0, 200)}`;
        log("failed", { error });
        return { ok: false, code: "upstream", reason: error };
      }
      return save(t.data, actor, opts, "created", log);
    }
    lastError = res.error;
    if (!unreachable(res)) break; // 400/404 etc: final
  }
  log("failed", { error: lastError });
  return { ok: false, code: "upstream", reason: lastError };
}

// An upstream ticket for this order and reason that we don't already have locally = the one our lost POST created.
async function findLostTicket(orderId: string, reason: string): Promise<UpstreamTicket | null | "unavailable"> {
  const res = await request<unknown>("GET", "/commerce/tickets");
  if (res.ok) recordHealth("commerce", true);
  else recordNetworkFailure("commerce", res);
  const list = res.ok ? z.array(ticketReply).safeParse(res.data) : null;
  if (!list?.success) return "unavailable";
  const known = new Set(getDb().select({ id: tickets.id }).from(tickets).where(eq(tickets.orderId, orderId)).all().map((t) => t.id));
  return list.data.find((t) => t.order_id === orderId && t.reason === reason && !known.has(t.id)) ?? null;
}

function save(t: UpstreamTicket, actor: Actor, opts: TicketOpts, how: string, log: (o: string, d: Record<string, unknown>) => void): TicketResult {
  const executionId = opts.workflowExecutionId ?? null;
  getDb()
    .insert(tickets)
    .values({ id: t.id, orderId: t.order_id, reason: t.reason, status: t.status, workflowExecutionId: executionId, createdByLabel: actor.label })
    .onConflictDoUpdate({ target: tickets.id, set: { workflowExecutionId: executionId, createdByLabel: actor.label, missingUpstream: false } })
    .run();
  log("succeeded", { ticketId: t.id, how });
  return { ok: true, ticketId: t.id, how };
}

// ---------- list ----------

export interface TicketQuery {
  status?: string;
  orderId?: string;
  customerId?: string;
}

export function listTickets(q: TicketQuery = {}) {
  const db = getDb();
  const where: SQL[] = [];
  if (q.status) where.push(eq(tickets.status, q.status));
  if (q.orderId) where.push(eq(tickets.orderId, q.orderId));
  if (q.customerId) where.push(eq(orders.customerId, q.customerId));
  const items = db
    .select({
      id: tickets.id,
      orderId: tickets.orderId,
      reason: tickets.reason,
      status: tickets.status,
      createdByLabel: tickets.createdByLabel,
      fromWorkflow: tickets.workflowExecutionId,
      missingUpstream: tickets.missingUpstream,
      createdAt: tickets.createdAt,
      customerId: customers.id,
      customerName: customers.name,
    })
    .from(tickets)
    .leftJoin(orders, eq(orders.id, tickets.orderId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(tickets.createdAt), desc(tickets.id))
    .all()
    .map((t) => ({ ...t, fromWorkflow: t.fromWorkflow !== null }));
  const statuses = db.selectDistinct({ s: tickets.status }).from(tickets).orderBy(tickets.status).all().map((r) => r.s);
  return { items, statuses };
}
