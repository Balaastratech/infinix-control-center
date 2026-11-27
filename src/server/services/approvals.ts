// Refund approvals: decide (one winner), then execute against the Payment API after re-checking upstream.
// Rules: CLAUDE.md "Business rules" + "Agreed decisions". Execution states of the operation:
//   approved -> submitted -> succeeded | failed        failed = a final answer (rule, 4xx, "failed" refund); Retry allowed
//   submitted -> approved (+error)                      "unsent": upstream unreachable, nothing confirmed; Retry allowed
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { orderPath, request, type ApiResult } from "@/server/clients/mock";
import { getDb } from "@/server/db";
import { approvals, operations, refunds, users } from "@/server/db/schema";
import { audit, type Actor } from "./audit";
import { recordHealth, recordNetworkFailure } from "./health";
import { RESERVING_STATUSES } from "./refunds";
import { refundRow } from "./sync";

export type DecisionResult =
  | { ok: true; approvalId: number; operationId: number; status: string; error?: string | null; externalId?: string | null }
  | { ok: false; code: "not_found" | "forbidden" | "conflict"; reason: string };

type UpstreamRefund = z.infer<typeof refundRow>;

const REFUNDABLE_ORDER_STATUSES = ["cancelled", "delivered"];
const RETRYABLE = ["approved", "failed"] as const;
const liveOrder = z.object({ id: z.string(), status: z.string() });
const livePayment = z.object({ order_id: z.string(), status: z.string(), amount_minor: z.number().int().nonnegative() });

// ---------- queue ----------

export function listApprovals() {
  const decider = alias(users, "decider");
  return getDb()
    .select({
      id: approvals.id,
      operationId: approvals.operationId,
      status: approvals.status,
      orderId: operations.orderId,
      amountMinor: operations.amountMinor,
      requestedByLabel: approvals.requestedByLabel,
      requestedByUserId: approvals.requestedByUserId,
      createdAt: approvals.createdAt,
      decidedAt: approvals.decidedAt,
      decidedBy: decider.email,
      note: approvals.note,
      operationStatus: operations.status,
      error: operations.error,
      externalId: operations.externalId,
    })
    .from(approvals)
    .innerJoin(operations, eq(operations.id, approvals.operationId))
    .leftJoin(decider, eq(decider.id, approvals.decidedByUserId))
    .orderBy(sql`${approvals.status} = 'pending' DESC`, desc(approvals.id))
    .all();
}

// ---------- decide ----------

function load(approvalId: number) {
  return getDb()
    .select({ approval: approvals, op: operations })
    .from(approvals)
    .innerJoin(operations, eq(operations.id, approvals.operationId))
    .where(eq(approvals.id, approvalId))
    .get();
}

const isOwn = (a: { requestedByUserId: number | null }, actor: Actor) =>
  a.requestedByUserId !== null && a.requestedByUserId === actor.userId;

function log(actor: Actor, action: string, target: string, outcome: string, detail?: unknown): void {
  audit({ userId: actor.userId, actorLabel: actor.label, role: actor.role, action, target, outcome, detail });
}

// The single place a decision is won: conditional UPDATE, then check the changed-row count.
function decide(approvalId: number, operationId: number, to: "approved" | "rejected", actor: Actor, note: string | null): boolean {
  const db = getDb();
  return db.transaction(() => {
    const won =
      db
        .update(approvals)
        .set({ status: to, decidedByUserId: actor.userId, decidedAt: new Date().toISOString(), note })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
        .run().changes === 1;
    if (won) {
      db.update(operations)
        .set({ status: to, updatedAt: new Date().toISOString() })
        .where(and(eq(operations.id, operationId), eq(operations.status, "pending_approval")))
        .run();
    }
    return won;
  });
}

type Guard = { fail: DecisionResult } | { fail?: undefined; found: NonNullable<ReturnType<typeof load>> };

function guard(approvalId: number, actor: Actor, action: string): Guard {
  const found = load(approvalId);
  if (!found) return { fail: { ok: false, code: "not_found", reason: "unknown approval" } };
  if (isOwn(found.approval, actor)) {
    log(actor, action, found.op.orderId, "refused", { approvalId, reason: "own request" });
    return { fail: { ok: false, code: "forbidden", reason: "you cannot decide your own request" } };
  }
  return { found };
}

export async function approveRefund(approvalId: number, actor: Actor): Promise<DecisionResult> {
  const g = guard(approvalId, actor, "refund.approve");
  if (g.fail) return g.fail;
  const { op } = g.found;
  if (!decide(approvalId, op.id, "approved", actor, null)) {
    log(actor, "refund.approve", op.orderId, "conflict", { approvalId });
    return { ok: false, code: "conflict", reason: "already decided" };
  }
  log(actor, "refund.approve", op.orderId, "approved", { approvalId, operationId: op.id, amountMinor: op.amountMinor });
  return execute(approvalId, op.id, actor, false);
}

export function rejectRefund(approvalId: number, note: string, actor: Actor): DecisionResult {
  const g = guard(approvalId, actor, "refund.reject");
  if (g.fail) return g.fail;
  const { op } = g.found;
  if (!decide(approvalId, op.id, "rejected", actor, note)) {
    log(actor, "refund.reject", op.orderId, "conflict", { approvalId });
    return { ok: false, code: "conflict", reason: "already decided" };
  }
  log(actor, "refund.reject", op.orderId, "rejected", { approvalId, operationId: op.id, note });
  return { ok: true, approvalId, operationId: op.id, status: "rejected" };
}

// Any manager may retry an approved refund that failed or was never sent.
export async function retryRefund(approvalId: number, actor: Actor): Promise<DecisionResult> {
  const found = load(approvalId);
  if (!found) return { ok: false, code: "not_found", reason: "unknown approval" };
  const { approval, op } = found;
  if (approval.status !== "approved" || !(RETRYABLE as readonly string[]).includes(op.status)) {
    return { ok: false, code: "conflict", reason: `refund is ${approval.status === "approved" ? op.status : approval.status}, nothing to retry` };
  }
  return execute(approvalId, op.id, actor, true);
}

// ---------- execute ----------

// Network failure or 5xx (after the client's own retries): upstream gave no answer we can trust.
const unreachable = (res: ApiResult<unknown>): boolean => !res.ok && (res.status === null || res.status >= 500);

async function execute(approvalId: number, operationId: number, actor: Actor, isRetry: boolean): Promise<DecisionResult> {
  const db = getDb();
  const action = isRetry ? "refund.retry" : "refund.execute";
  // Claim: only one caller can move approved/failed -> submitted, so two retries can never both POST.
  const claimed =
    db
      .update(operations)
      .set({ status: "submitted", error: null, updatedAt: new Date().toISOString() })
      .where(and(eq(operations.id, operationId), inArray(operations.status, RETRYABLE)))
      .run().changes === 1;
  const op = db.select().from(operations).where(eq(operations.id, operationId)).get()!;
  if (!claimed) return { ok: false, code: "conflict", reason: `refund is ${op.status}` };
  const amount = op.amountMinor!;

  const end = (status: "succeeded" | "failed" | "approved", error: string | null, refund?: UpstreamRefund): DecisionResult => {
    db.transaction(() => {
      if (refund) saveRefund(refund, operationId);
      db.update(operations)
        .set({ status, error, ...(refund ? { externalId: refund.id } : {}), updatedAt: new Date().toISOString() })
        .where(eq(operations.id, operationId))
        .run();
    });
    const externalId = refund?.id ?? op.externalId;
    log(actor, action, op.orderId, status === "approved" ? "unsent" : status, { approvalId, operationId, amountMinor: amount, externalId, error });
    return { ok: true, approvalId, operationId, status, error, externalId };
  };
  const unsent = (why: string) => end("approved", `${why}; not confirmed, use Retry`);

  if (isRetry) {
    // No idempotency key upstream: a refund of ours may already exist (e.g. timeout after the mock processed it).
    const existing = await findExistingRefund(op.orderId, amount, operationId);
    if (existing === "unavailable") return unsent("could not check existing refunds (Payment API unreachable)");
    if (existing) return end("succeeded", null, existing);
  }

  const checked = await recheckUpstream(op.orderId, amount, operationId);
  if (checked.kind === "unreachable") return unsent(checked.reason);
  if (checked.kind === "refused") return end("failed", checked.reason);

  const res = await request<unknown>("POST", "/payments/refunds", { order_id: op.orderId, amount_minor: amount }, false); // never blindly retried
  recordNetworkFailure("payments", res);
  if (!res.ok) return unreachable(res) ? unsent(`Payment API unreachable: ${res.error}`) : end("failed", res.error);

  const reply = refundRow.safeParse(res.data);
  if (!reply.success || reply.data.order_id !== op.orderId || reply.data.amount_minor !== amount) {
    return end("failed", `unexpected refund reply: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  // HTTP 201 is not success: only a body that says "succeeded" is.
  if (reply.data.status !== "succeeded") {
    return end("failed", `Payment API reported refund ${reply.data.id} as ${reply.data.status}`, reply.data);
  }
  return end("succeeded", null, reply.data);
}

function saveRefund(r: UpstreamRefund, operationId: number): void {
  getDb()
    .insert(refunds)
    .values({ id: r.id, orderId: r.order_id, amountMinor: r.amount_minor, currency: r.currency, status: r.status, operationId })
    .onConflictDoUpdate({
      target: refunds.id,
      set: { status: r.status, amountMinor: r.amount_minor, currency: r.currency, operationId, missingUpstream: false },
    })
    .run();
}

// A non-failed upstream refund with our order and amount that no other operation already owns.
async function findExistingRefund(orderId: string, amount: number, operationId: number): Promise<UpstreamRefund | null | "unavailable"> {
  const res = await request<unknown>("GET", "/payments/refunds");
  // A list call records health both ways, like sync.
  if (res.ok) recordHealth("payments", true);
  else if (unreachable(res)) recordHealth("payments", false, res.error);
  const parsed = res.ok ? z.array(refundRow).safeParse(res.data) : null;
  if (!parsed?.success) return "unavailable";
  const db = getDb();
  const owned = new Set<string>([
    ...db
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(sql`${refunds.operationId} IS NOT NULL`, ne(refunds.operationId, operationId)))
      .all()
      .map((r) => r.id),
    ...db
      .select({ id: operations.externalId })
      .from(operations)
      .where(and(sql`${operations.externalId} IS NOT NULL`, ne(operations.id, operationId)))
      .all()
      .flatMap((r) => (r.id ? [r.id] : [])),
  ]);
  return parsed.data.find((r) => r.order_id === orderId && r.amount_minor === amount && r.status !== "failed" && !owned.has(r.id)) ?? null;
}

type Recheck = { kind: "ok" } | { kind: "refused" | "unreachable"; reason: string };

// Re-read order and payment upstream and re-apply the refund rule and the cap against THEM, not local data.
async function recheckUpstream(orderId: string, amount: number, operationId: number): Promise<Recheck> {
  const orderUrl = orderPath("/commerce/orders/", orderId);
  const payUrl = orderPath("/payments/transactions/", orderId);
  if (!orderUrl || !payUrl) return { kind: "refused", reason: "invalid order id" };
  const [o, p] = await Promise.all([request<unknown>("GET", orderUrl), request<unknown>("GET", payUrl)]);
  recordNetworkFailure("commerce", o);
  recordNetworkFailure("payments", p);
  if (!o.ok && unreachable(o)) return { kind: "unreachable", reason: `Commerce API unreachable: ${o.error}` };
  if (!p.ok && unreachable(p)) return { kind: "unreachable", reason: `Payment API unreachable: ${p.error}` };
  if (!o.ok) return { kind: "refused", reason: `upstream order lookup failed: ${o.error}` };
  if (!p.ok) return { kind: "refused", reason: `upstream payment lookup failed: ${p.error}` };
  const order = liveOrder.safeParse(o.data);
  const pay = livePayment.safeParse(p.data);
  if (!order.success || !pay.success) return { kind: "refused", reason: "unexpected upstream reply shape" };

  const status = order.data.status;
  if (!REFUNDABLE_ORDER_STATUSES.includes(status)) {
    const hint = status === "processing" ? "push cancel upstream first" : "order must be cancelled or delivered";
    return { kind: "refused", reason: `upstream says ${status}; ${hint}` };
  }
  if (pay.data.status !== "captured") return { kind: "refused", reason: `upstream says payment is ${pay.data.status}, not captured` };

  const db = getDb();
  const refunded = db
    .select({ n: sql<number>`coalesce(sum(${refunds.amountMinor}), 0)` })
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), ne(refunds.status, "failed")))
    .get()!.n;
  const reservedByOthers = db
    .select({ n: sql<number>`coalesce(sum(${operations.amountMinor}), 0)` })
    .from(operations)
    .where(
      and(
        eq(operations.orderId, orderId),
        eq(operations.type, "refund"),
        inArray(operations.status, RESERVING_STATUSES),
        ne(operations.id, operationId),
      ),
    )
    .get()!.n;
  const cap = Math.max(0, pay.data.amount_minor - refunded - reservedByOthers);
  if (amount > cap) return { kind: "refused", reason: `amount ${amount} exceeds the refundable ${cap} upstream` };
  return { kind: "ok" };
}
