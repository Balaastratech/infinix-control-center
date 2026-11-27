// Pull customers, orders, tickets (commerce), payments, refunds (payments) and shipments (shipping) into the local copy.
// Each service: fetch everything, validate, write in ONE transaction, record a sync_runs row and service health.
// One service failing never stops the others. Sync itself never fires workflows; pending webhook events it unblocks do.
import { eq, notInArray } from "drizzle-orm";
import { SERVICE_LABELS } from "@/lib/labels";
import { z } from "zod";
import { request } from "@/server/clients/mock";
import { getDb } from "@/server/db";
import { customers, orders, payments, refunds, shipments, syncRuns, tickets } from "@/server/db/schema";
import { recordHealth, type Service } from "./health";
import { applyPendingEvents } from "./webhooks";

const paise = z.number().int().nonnegative();
const customerRow = z.object({ id: z.string(), name: z.string(), email: z.string() });
const orderRow = z.object({
  id: z.string(),
  customer_id: z.string(),
  status: z.string(),
  amount_minor: paise,
  currency: z.string(),
  created_at: z.string(),
  channel: z.string().nullish(),
});
const ticketRow = z.object({ id: z.string(), order_id: z.string(), reason: z.string(), status: z.string() });
const paymentRow = z.object({ id: z.string(), order_id: z.string(), status: z.string(), amount_minor: paise, currency: z.string() });
export const refundRow = z.object({
  id: z.string(),
  order_id: z.string(),
  amount_minor: z.number().int().positive(),
  currency: z.string(),
  status: z.string(),
});
export const shipmentRow = z.object({ id: z.string(), order_id: z.string(), status: z.string(), updated_at: z.string() });

class SyncError extends Error {}

async function fetchList<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>[]> {
  const res = await request<unknown>("GET", path);
  if (!res.ok) throw new SyncError(res.status === null ? res.error : `${SERVICE_LABELS[path.split("/")[1]] ?? "Upstream"} replied: ${res.error}`);
  const parsed = z.array(schema).safeParse(res.data);
  if (!parsed.success) throw new SyncError(`GET ${path}: unexpected reply shape (${parsed.error.issues[0]?.message})`);
  return parsed.data;
}

// ---------- merge rules (pure) ----------

// Orders and payments have no upstream timestamps. local_event_at != null means a webhook or our own in-app change set
// `status`: keep it, record upstream's value, and never clear the mark (a mock restart must not silently revert us).
export function mergeStatus(local: { status: string; localEventAt: string | null }, upstream: string): string {
  return local.localEventAt === null ? upstream : local.status;
}

// Shipments: take upstream only when its updated_at is strictly newer than ours.
export function upstreamShipmentWins(localUpdatedAt: string, upstreamUpdatedAt: string): boolean {
  return Date.parse(upstreamUpdatedAt) > Date.parse(localUpdatedAt);
}

// ---------- per-service writers (run inside one transaction) ----------

type Counts = Record<string, number>;

async function syncCommerce(at: string): Promise<Counts> {
  const [cs, os, ts] = await Promise.all([
    fetchList("/commerce/customers", customerRow),
    fetchList("/commerce/orders", orderRow),
    fetchList("/commerce/tickets", ticketRow),
  ]);
  const db = getDb();
  db.transaction(() => {
    for (const c of cs) {
      db.insert(customers)
        .values({ ...c, syncedAt: at })
        .onConflictDoUpdate({ target: customers.id, set: { name: c.name, email: c.email, syncedAt: at } })
        .run();
    }
    for (const o of os) {
      const upstream = {
        customerId: o.customer_id,
        amountMinor: o.amount_minor,
        currency: o.currency,
        createdAt: o.created_at,
        channel: o.channel ?? null,
        upstreamStatus: o.status,
        syncedAt: at,
      };
      const local = db.select().from(orders).where(eq(orders.id, o.id)).get();
      if (!local) {
        db.insert(orders).values({ id: o.id, status: o.status, ...upstream }).run();
      } else {
        db.update(orders).set({ ...upstream, status: mergeStatus(local, o.status) }).where(eq(orders.id, o.id)).run();
      }
    }
    upsertWithMissing(tickets, ts.map((t) => ({ id: t.id, orderId: t.order_id, reason: t.reason, status: t.status })), at);
  });
  return { customers: cs.length, orders: os.length, tickets: ts.length };
}

async function syncPayments(at: string): Promise<Counts> {
  const [ps, rs] = await Promise.all([
    fetchList("/payments/transactions", paymentRow),
    fetchList("/payments/refunds", refundRow),
  ]);
  const db = getDb();
  db.transaction(() => {
    for (const p of ps) {
      const upstream = { orderId: p.order_id, amountMinor: p.amount_minor, currency: p.currency, upstreamStatus: p.status, syncedAt: at };
      const local = db.select().from(payments).where(eq(payments.id, p.id)).get();
      if (!local) {
        db.insert(payments).values({ id: p.id, status: p.status, ...upstream }).run();
      } else {
        db.update(payments).set({ ...upstream, status: mergeStatus(local, p.status) }).where(eq(payments.id, p.id)).run();
      }
    }
    upsertWithMissing(
      refunds,
      rs.map((r) => ({ id: r.id, orderId: r.order_id, amountMinor: r.amount_minor, currency: r.currency, status: r.status })),
      at,
    );
  });
  return { payments: ps.length, refunds: rs.length };
}

async function syncShipping(at: string): Promise<Counts> {
  const ss = await fetchList("/shipping/shipments", shipmentRow);
  getDb().transaction(() => ss.forEach((s) => upsertShipment(s, at)));
  return { shipments: ss.length };
}

// One upstream shipment into the local copy (sync, and the live lookup on order detail).
export function upsertShipment(s: z.infer<typeof shipmentRow>, at: string): void {
  const db = getDb();
  const local = db.select().from(shipments).where(eq(shipments.id, s.id)).get();
  const upstream = { orderId: s.order_id, upstreamStatus: s.status, upstreamUpdatedAt: s.updated_at, syncedAt: at };
  if (!local) {
    db.insert(shipments).values({ id: s.id, status: s.status, updatedAt: s.updated_at, ...upstream }).run();
  } else {
    const wins = upstreamShipmentWins(local.updatedAt, s.updated_at);
    db.update(shipments)
      .set(wins ? { ...upstream, status: s.status, updatedAt: s.updated_at } : upstream)
      .where(eq(shipments.id, s.id))
      .run();
  }
}

// Refunds and tickets: upstream copy by id. Rows we have that upstream no longer lists (mock restarted) are flagged.
function upsertWithMissing(table: typeof refunds | typeof tickets, rows: { id: string }[], at: string): void {
  const db = getDb();
  for (const row of rows) {
    db.insert(table)
      .values({ ...row, missingUpstream: false, syncedAt: at } as never)
      .onConflictDoUpdate({ target: table.id, set: { ...row, missingUpstream: false, syncedAt: at } as never })
      .run();
  }
  const ids = rows.map((r) => r.id);
  db.update(table)
    .set({ missingUpstream: true })
    .where(ids.length ? notInArray(table.id, ids) : undefined)
    .run();
}

// ---------- orchestration ----------

export interface ServiceSyncResult {
  service: Service;
  status: "ok" | "failed";
  counts?: Counts;
  error?: string;
}
export interface SyncReport {
  services: ServiceSyncResult[];
  pendingApplied: number;
}

const RUNNERS: Record<Service, (at: string) => Promise<Counts>> = {
  commerce: syncCommerce,
  payments: syncPayments,
  shipping: syncShipping,
};

async function runService(service: Service): Promise<ServiceSyncResult> {
  const db = getDb();
  const [run] = db.insert(syncRuns).values({ service }).returning({ id: syncRuns.id }).all();
  const finish = (set: Partial<typeof syncRuns.$inferInsert>) =>
    db.update(syncRuns).set({ ...set, finishedAt: new Date().toISOString() }).where(eq(syncRuns.id, run.id)).run();
  try {
    const counts = await RUNNERS[service](new Date().toISOString());
    finish({ status: "ok", counts: JSON.stringify(counts) });
    recordHealth(service, true);
    return { service, status: "ok", counts };
  } catch (e) {
    const error = e instanceof SyncError ? e.message : `unexpected: ${(e as Error).message}`;
    finish({ status: "failed", error });
    recordHealth(service, false, error);
    return { service, status: "failed", error };
  }
}

export async function syncAll(): Promise<SyncReport> {
  const services = await Promise.all((Object.keys(RUNNERS) as Service[]).map(runService));
  const pendingApplied = await applyPendingEvents();
  return { services, pendingApplied };
}
