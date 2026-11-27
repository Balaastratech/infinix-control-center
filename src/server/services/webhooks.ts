// Incoming webhooks: verify, validate, dedupe on event_id, apply to the local projection, then call the workflow hook.
// Rules: CLAUDE.md "Integration rules" and "Agreed decisions".
import crypto from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { isValidId } from "@/server/clients/mock";
import { config } from "@/server/config";
import { getDb } from "@/server/db";
import { orders, payments, SHIPMENT_STATUSES, shipments, webhookEvents, WEBHOOK_STATUSES } from "@/server/db/schema";
import { audit } from "./audit";
import { onWebhookEvent } from "./workflows";

export { SHIPMENT_STATUSES };

// Allowed data.status per known event type. Any other type is stored as "ignored".
const KNOWN_TYPES: Record<string, readonly string[]> = {
  "shipment.updated": SHIPMENT_STATUSES,
  "payment.failed": ["failed"],
  "order.cancelled": ["cancelled"],
};

export const eventSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    occurred_at: z.iso.datetime({ offset: true }),
    order_id: z.string().refine(isValidId, "invalid order id"),
    data: z.record(z.string(), z.unknown()),
  })
  .superRefine((e, ctx) => {
    const allowed = KNOWN_TYPES[e.type];
    if (allowed && !allowed.includes(e.data.status as string)) {
      ctx.addIssue({ code: "custom", path: ["data", "status"], message: `must be one of: ${allowed.join(", ")}` });
    }
  });

export type WebhookEvent = z.infer<typeof eventSchema>;
export type EventStatus = (typeof WEBHOOK_STATUSES)[number];
export type ReceiveResult = { status: EventStatus | "duplicate" };

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();

// Constant-time compare. A missing or wrong secret is logged to audit_log.
export function verifyWebhookSecret(header: string | null): boolean {
  if (header && crypto.timingSafeEqual(digest(header), digest(config.webhookSecret))) return true;
  audit({
    actorLabel: "webhook",
    action: "webhook.rejected",
    outcome: "denied",
    detail: header ? "wrong X-Webhook-Secret" : "missing X-Webhook-Secret",
  });
  return false;
}

export async function receiveWebhook(event: WebhookEvent): Promise<ReceiveResult> {
  const db = getDb();
  const status = db.transaction(() => {
    const inserted = db
      .insert(webhookEvents)
      .values({
        eventId: event.event_id,
        type: event.type,
        orderId: event.order_id,
        occurredAt: event.occurred_at,
        payload: JSON.stringify(event),
        status: "pending",
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return "duplicate" as const; // seen before: nothing changes, no workflow run
    return applyAndRecord(event);
  });
  if (status === "applied") await fireHook(event);
  return { status };
}

// Pending events (order unknown when they arrived) are retried after each sync, oldest first.
export async function applyPendingEvents(): Promise<number> {
  const db = getDb();
  const pending = db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.status, "pending"))
    .orderBy(asc(webhookEvents.occurredAt))
    .all();
  let applied = 0;
  for (const row of pending) {
    const event = JSON.parse(row.payload) as WebhookEvent;
    const status = db.transaction(() => applyAndRecord(event));
    if (status === "applied") {
      applied++;
      await fireHook(event); // a late event is still a real event
    }
  }
  return applied;
}

function applyAndRecord(event: WebhookEvent): EventStatus {
  const { status, note } = applyEvent(event);
  getDb()
    .update(webhookEvents)
    .set({ status, note: note ?? null })
    .where(eq(webhookEvents.eventId, event.event_id))
    .run();
  return status;
}

const isOlder = (a: string, b: string | null) => b !== null && Date.parse(a) < Date.parse(b);

function applyEvent(event: WebhookEvent): { status: EventStatus; note?: string } {
  const db = getDb();
  const newStatus = event.data.status as string;
  const at = event.occurred_at;

  switch (event.type) {
    case "shipment.updated": {
      const row = db.select().from(shipments).where(eq(shipments.orderId, event.order_id)).get();
      if (!row) return { status: "pending", note: "no shipment for this order yet" };
      // Strictly older than the row = stale; equal or newer = apply.
      if (isOlder(at, row.updatedAt)) return { status: "stale", note: `row updated_at ${row.updatedAt}` };
      db.update(shipments).set({ status: newStatus, updatedAt: at }).where(eq(shipments.id, row.id)).run();
      return { status: "applied" };
    }
    case "order.cancelled": {
      const row = db.select().from(orders).where(eq(orders.id, event.order_id)).get();
      if (!row) return { status: "pending", note: "unknown order" };
      if (isOlder(at, row.localEventAt)) return { status: "stale", note: `row local_event_at ${row.localEventAt}` };
      db.update(orders)
        .set({ status: newStatus, localEventAt: at, localUpdatedAt: new Date().toISOString() })
        .where(eq(orders.id, row.id))
        .run();
      return { status: "applied" };
    }
    case "payment.failed": {
      const row = db.select().from(payments).where(eq(payments.orderId, event.order_id)).get();
      if (!row) return { status: "pending", note: "no payment for this order yet" };
      if (isOlder(at, row.localEventAt)) return { status: "stale", note: `row local_event_at ${row.localEventAt}` };
      db.update(payments).set({ status: newStatus, localEventAt: at }).where(eq(payments.id, row.id)).run();
      return { status: "applied" };
    }
    default:
      return { status: "ignored", note: "unknown event type" };
  }
}

function fireHook(event: WebhookEvent): Promise<void> {
  return onWebhookEvent({
    eventId: event.event_id,
    type: event.type,
    orderId: event.order_id,
    occurredAt: event.occurred_at,
    data: event.data,
  });
}
