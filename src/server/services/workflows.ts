// Workflow engine + CRUD. A workflow = trigger + conditions (all must hold) + one action.
// The engine is called once per applied event (webhooks, late pending events, our own successful cancel), always
// after the event's DB transaction has committed. Never from sync. Rules: CLAUDE.md, PLAN.md block 5.
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { BACKOFF_MS, isValidId, request, type ApiResult } from "@/server/clients/mock";
import { getDb } from "@/server/db";
import {
  ORDER_STATUSES,
  orders,
  PAYMENT_STATUSES,
  payments,
  SHIPMENT_STATUSES,
  shipments,
  tickets,
  workflowExecutions,
  workflows,
  WORKFLOW_TRIGGERS,
} from "@/server/db/schema";
import seed from "@/server/db/seed-workflows.json";
import { formatMoney } from "@/lib/format";
import { audit, type Actor } from "./audit";
import { recordHealth, recordNetworkFailure } from "./health";
import { requestRefund } from "./refunds";

export interface WorkflowEvent {
  eventId: string;
  type: string;
  orderId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

// ---------- definition (validated at every create/edit) ----------

const STATUS_VALUES = { order_status: ORDER_STATUSES, payment_status: PAYMENT_STATUSES, shipment_status: SHIPMENT_STATUSES } as const;
export const FIELDS = ["amount_minor", "order_status", "payment_status", "shipment_status"] as const;
export const OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
export const PLACEHOLDERS = ["order_id", "amount", "order_status", "payment_status", "shipment_status", "event_type"] as const;

const conditionSchema = z
  .object({ field: z.enum(FIELDS), op: z.enum(OPS), value: z.union([z.number(), z.string()]) })
  .superRefine((c, ctx) => {
    if (c.field === "amount_minor") {
      if (!Number.isSafeInteger(c.value) || (c.value as number) < 0) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "amount_minor needs a whole number of paise >= 0" });
      }
      return;
    }
    if (c.op !== "eq" && c.op !== "neq") ctx.addIssue({ code: "custom", path: ["op"], message: `${c.field} supports eq and neq only` });
    const allowed: readonly string[] = STATUS_VALUES[c.field];
    if (typeof c.value !== "string" || !allowed.includes(c.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `${c.field} must be one of: ${allowed.join(", ")}` });
    }
  });
export type Condition = z.infer<typeof conditionSchema>;

const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((r) => [...r.matchAll(/\{(\w*)\}/g)].every((m) => (PLACEHOLDERS as readonly string[]).includes(m[1])), {
    message: `unknown placeholder; allowed: ${PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}`,
  });

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_ticket"), reason: reasonSchema }),
  z.object({ type: z.literal("request_refund"), amount_minor: z.number().int().positive().optional() }), // omitted = full
]);
export type WorkflowAction = z.infer<typeof actionSchema>;

export const workflowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  trigger: z.enum(WORKFLOW_TRIGGERS),
  conditions: z.array(conditionSchema).min(1).max(10),
  action: actionSchema,
  enabled: z.boolean().default(true),
});
export type WorkflowInput = z.infer<typeof workflowSchema>;
export const workflowPatchSchema = workflowSchema.partial();

type Row = typeof workflows.$inferSelect;
export interface Workflow extends WorkflowInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

const toDb = (w: WorkflowInput) => {
  const { type, ...params } = w.action;
  return { name: w.name, trigger: w.trigger, conditions: JSON.stringify(w.conditions), action: type, actionParams: JSON.stringify(params), enabled: w.enabled };
};
const fromDb = (r: Row): Workflow => ({
  id: r.id,
  name: r.name,
  trigger: r.trigger,
  conditions: JSON.parse(r.conditions) as Condition[],
  action: { type: r.action, ...JSON.parse(r.actionParams) } as WorkflowAction,
  enabled: r.enabled,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

// ---------- CRUD ----------

export const workflowId = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export function listWorkflows(): Workflow[] {
  return getDb().select().from(workflows).orderBy(workflows.id).all().map(fromDb);
}

export function listExecutions(workflowId: number) {
  return getDb()
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.workflowId, workflowId))
    .orderBy(desc(workflowExecutions.id))
    .limit(100)
    .all();
}

export type SaveResult = { ok: true; workflow: Workflow } | { ok: false; code: "not_found" | "conflict"; reason: string };

const nameTaken = (name: string, exceptId?: number) => {
  const row = getDb().select({ id: workflows.id }).from(workflows).where(eq(workflows.name, name)).get();
  return row !== undefined && row.id !== exceptId;
};

export function createWorkflow(input: WorkflowInput, actor: Actor): SaveResult {
  if (nameTaken(input.name)) return { ok: false, code: "conflict", reason: "a workflow with this name exists" };
  const [row] = getDb().insert(workflows).values({ ...toDb(input), createdByUserId: actor.userId }).returning().all();
  log(actor, "workflow.create", row, input);
  return { ok: true, workflow: fromDb(row) };
}

// Partial edit: merged with the stored workflow, then the whole result is validated again.
export type UpdateResult = SaveResult | { ok: false; code: "invalid"; issues: { path: PropertyKey[]; message: string }[] };

export function updateWorkflow(id: number, patch: z.infer<typeof workflowPatchSchema>, actor: Actor): UpdateResult {
  const db = getDb();
  const row = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!row) return { ok: false, code: "not_found", reason: "unknown workflow" };
  const merged = workflowSchema.safeParse({ ...fromDb(row), ...patch });
  if (!merged.success) return { ok: false, code: "invalid", issues: merged.error.issues.map((i) => ({ path: i.path, message: i.message })) };
  if (nameTaken(merged.data.name, id)) return { ok: false, code: "conflict", reason: "a workflow with this name exists" };
  const [updated] = db
    .update(workflows)
    .set({ ...toDb(merged.data), updatedAt: new Date().toISOString() })
    .where(eq(workflows.id, id))
    .returning()
    .all();
  const onlyToggle = Object.keys(patch).length === 1 && patch.enabled !== undefined;
  log(actor, onlyToggle ? (patch.enabled ? "workflow.enable" : "workflow.disable") : "workflow.update", updated, patch);
  return { ok: true, workflow: fromDb(updated) };
}

function log(actor: Actor, action: string, row: Row, detail: unknown) {
  audit({ userId: actor.userId, actorLabel: actor.label, role: actor.role, action, target: `workflow ${row.id} ${row.name}`, outcome: "ok", detail });
}

// The seeded rules, inserted only when there are no workflows at all (setup.mjs does the same from the JSON).
export function seedWorkflows(): void {
  const db = getDb();
  if (db.select({ n: sql<number>`count(*)` }).from(workflows).get()!.n > 0) return;
  for (const w of seed) db.insert(workflows).values(toDb(workflowSchema.parse(w))).run();
}

// ---------- engine ----------

type Facts = Record<(typeof FIELDS)[number], number | string | null>;

// Conditions are checked against stored data, never the event body.
function loadFacts(orderId: string): Facts {
  const db = getDb();
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  return {
    amount_minor: order?.amountMinor ?? null,
    order_status: order?.status ?? null,
    payment_status: db.select().from(payments).where(eq(payments.orderId, orderId)).get()?.status ?? null,
    shipment_status: db.select().from(shipments).where(eq(shipments.orderId, orderId)).get()?.status ?? null,
  };
}

const COMPARE: Record<(typeof OPS)[number], (a: number | string, b: number | string) => boolean> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
};

// The first condition that fails, as a readable reason, or null when all hold.
export function failedCondition(conditions: Condition[], facts: Facts): string | null {
  for (const c of conditions) {
    const actual = facts[c.field];
    if (actual === null) return `${c.field} is missing`;
    if (!COMPARE[c.op](actual, c.value)) return `${c.field} ${actual} is not ${c.op} ${c.value}`;
  }
  return null;
}

// Never throws: a failing workflow is recorded, and the caller (webhook reply, cancel reply) is never affected.
export async function onWebhookEvent(event: WorkflowEvent): Promise<void> {
  if (!(WORKFLOW_TRIGGERS as readonly string[]).includes(event.type)) return;
  let list: Workflow[] = [];
  try {
    list = listWorkflows().filter((w) => w.enabled && w.trigger === event.type);
  } catch (e) {
    systemError(event, e);
  }
  for (const wf of list) {
    try {
      await runWorkflow(wf, event);
    } catch (e) {
      systemError(event, e, wf);
    }
  }
}

async function runWorkflow(wf: Workflow, event: WorkflowEvent): Promise<void> {
  const db = getDb();
  const facts = loadFacts(event.orderId);
  const skipReason = failedCondition(wf.conditions, facts);
  // Claim: the unique (workflow_id, event_id) index means each workflow runs at most once per event.
  // A matched run starts as "failed / no result" so a crash mid-action leaves an honest row, then gets its real outcome.
  const [claimed] = db
    .insert(workflowExecutions)
    .values({
      workflowId: wf.id,
      eventId: event.eventId,
      orderId: event.orderId,
      matched: skipReason === null,
      outcome: skipReason === null ? "failed" : "skipped",
      result: skipReason,
      error: skipReason === null ? "started; no result recorded" : null,
    })
    .onConflictDoNothing()
    .returning({ id: workflowExecutions.id })
    .all();
  if (!claimed || skipReason !== null) return;

  const actor: Actor = { userId: null, label: `workflow:${wf.name}`, role: null };
  const outcome =
    wf.action.type === "create_ticket"
      ? await createTicket(wf.action.reason, facts, event, claimed.id, actor)
      : refundAction(wf.action.amount_minor, event.orderId, actor);
  db.update(workflowExecutions)
    .set(outcome.ok ? { outcome: "succeeded", result: JSON.stringify(outcome.result), error: null } : { outcome: "failed", error: outcome.error })
    .where(eq(workflowExecutions.id, claimed.id))
    .run();
}

function systemError(event: WorkflowEvent, e: unknown, wf?: Workflow) {
  const error = e instanceof Error ? e.message : String(e);
  try {
    if (wf) {
      getDb()
        .update(workflowExecutions)
        .set({ outcome: "failed", error })
        .where(sql`${workflowExecutions.workflowId} = ${wf.id} AND ${workflowExecutions.eventId} = ${event.eventId}`)
        .run();
    }
    audit({ actorLabel: wf ? `workflow:${wf.name}` : "system", action: "workflow.error", target: event.orderId, outcome: "failed", detail: { eventId: event.eventId, error } });
  } catch {
    // NOTE: DB itself is failing; nothing more we can record. The caller's reply must still go out.
  }
}

type ActionOutcome = { ok: true; result: unknown } | { ok: false; error: string };

// ---------- action: request_refund ----------

// Creates a pending approval only. The Payment API is called later, on Manager approval.
function refundAction(amountMinor: number | undefined, orderId: string, actor: Actor): ActionOutcome {
  const r = requestRefund(orderId, amountMinor, actor);
  return r.ok ? { ok: true, result: { operationId: r.operationId, approvalId: r.approvalId, amountMinor: r.amountMinor } } : { ok: false, error: r.reason };
}

// ---------- action: create_ticket ----------

const ticketReply = z.object({ id: z.string(), order_id: z.string(), reason: z.string(), status: z.string() });
type UpstreamTicket = z.infer<typeof ticketReply>;
const MAX_ATTEMPTS = 3;
const unreachable = (res: ApiResult<unknown>) => !res.ok && (res.status === null || res.status === 503);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function renderReason(template: string, facts: Facts, event: WorkflowEvent): string {
  const values: Record<string, string> = {
    order_id: event.orderId,
    amount: typeof facts.amount_minor === "number" ? formatMoney(facts.amount_minor) : "-",
    order_status: String(facts.order_status ?? "-"),
    payment_status: String(facts.payment_status ?? "-"),
    shipment_status: String(facts.shipment_status ?? "-"),
    event_type: event.type,
  };
  return template.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
}

// POST /commerce/tickets has no idempotency key: before any retry, look for the ticket a lost reply may have created.
async function createTicket(template: string, facts: Facts, event: WorkflowEvent, executionId: number, actor: Actor): Promise<ActionOutcome> {
  if (!isValidId(event.orderId)) return { ok: false, error: "invalid order id" };
  const reason = renderReason(template, facts, event);
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(BACKOFF_MS[attempt - 2]);
      const existing = await findLostTicket(event.orderId, reason);
      if (existing === "unavailable") return { ok: false, error: `${lastError}; could not verify whether the ticket exists (Commerce API unreachable)` };
      if (existing) return saveTicket(existing, executionId, actor, "adopted after a lost reply");
    }
    const res = await request<unknown>("POST", "/commerce/tickets", { order_id: event.orderId, reason }, false);
    recordNetworkFailure("commerce", res);
    if (res.ok) {
      const t = ticketReply.safeParse(res.data);
      if (!t.success || t.data.order_id !== event.orderId) return { ok: false, error: `unexpected ticket reply: ${JSON.stringify(res.data).slice(0, 200)}` };
      return saveTicket(t.data, executionId, actor, "created");
    }
    lastError = res.error;
    if (!unreachable(res)) break; // 400/404 etc: final
  }
  audit({ actorLabel: actor.label, action: "workflow.create_ticket", target: event.orderId, outcome: "failed", detail: { executionId, error: lastError } });
  return { ok: false, error: lastError };
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

function saveTicket(t: UpstreamTicket, executionId: number, actor: Actor, how: string): ActionOutcome {
  getDb()
    .insert(tickets)
    .values({ id: t.id, orderId: t.order_id, reason: t.reason, status: t.status, workflowExecutionId: executionId, createdByLabel: actor.label })
    .onConflictDoUpdate({ target: tickets.id, set: { workflowExecutionId: executionId, createdByLabel: actor.label, missingUpstream: false } })
    .run();
  audit({ actorLabel: actor.label, action: "workflow.create_ticket", target: t.order_id, outcome: "succeeded", detail: { executionId, ticketId: t.id, how } });
  return { ok: true, result: { ticketId: t.id } };
}
