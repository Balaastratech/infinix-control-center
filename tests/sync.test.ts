import { and, eq, sql, type SQL } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import type { Db } from "@/server/db";
import { orders, payments, refunds, shipments, syncRuns, webhookEvents } from "@/server/db/schema";
import { mergeStatus, syncAll, upstreamShipmentWins } from "@/server/services/sync";
import { receiveWebhook, type WebhookEvent } from "@/server/services/webhooks";
import { onWebhookEvent } from "@/server/services/workflows";
import { clearData, setupTestDb } from "./helpers/db";
import { BASE, businessData, server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));
const hook = vi.mocked(onWebhookEvent);

let db: Db;
beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  clearData();
  hook.mockClear();
});

const count = (table: typeof orders | typeof payments | typeof shipments, where?: SQL) =>
  db.select({ n: sql<number>`count(*)` }).from(table).where(where).get()!.n;
const order = (id: string) => db.select().from(orders).where(eq(orders.id, id)).get()!;
// Upstream orders with some statuses replaced (the mock agreeing with a cancel, or upstream moving on).
const ordersWith = (overrides: Record<string, string>) =>
  http.get(`${BASE}/commerce/orders`, () =>
    HttpResponse.json(businessData.orders.map((o) => ({ ...o, status: overrides[o.id as string] ?? o.status }))),
  );
const evt3: WebhookEvent = {
  event_id: "evt-003",
  type: "order.cancelled",
  occurred_at: "2026-11-22T10:10:00Z",
  order_id: "NC-1004",
  data: { status: "cancelled" },
};

describe("sync", () => {
  it("first sync imports everything: 60 orders, 52 captured payments, 6 delayed shipments", async () => {
    const report = await syncAll();
    expect(report.services.map((s) => s.status)).toEqual(["ok", "ok", "ok"]);
    expect(count(orders)).toBe(60);
    expect(count(payments, eq(payments.status, "captured"))).toBe(52);
    expect(count(shipments, eq(shipments.status, "delayed"))).toBe(6);
    expect(order("NC-1004")).toMatchObject({ status: "processing", upstreamStatus: "processing", localEventAt: null });
    expect(db.select().from(syncRuns).all().map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(hook).not.toHaveBeenCalled(); // sync never fires workflows
  });

  it("Payment API down: Commerce and Shipping still sync, payments run failed, health shows it", async () => {
    server.use(http.get(`${BASE}/payments/*`, () => HttpResponse.error()));
    const report = await syncAll();

    expect(Object.fromEntries(report.services.map((s) => [s.service, s.status]))).toEqual({
      commerce: "ok",
      payments: "failed",
      shipping: "ok",
    });
    expect(count(orders)).toBe(60);
    expect(count(shipments)).toBe(60);
    expect(count(payments)).toBe(0);
    const run = db.select().from(syncRuns).where(eq(syncRuns.service, "payments")).get()!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/API is unreachable/);

    const body = await (await health()).json();
    const byService = Object.fromEntries(body.services.map((s: { service: string }) => [s.service, s]));
    expect(byService.payments).toMatchObject({ status: "down", lastSyncStatus: "failed" });
    expect(byService.payments.lastError).toMatch(/Payment API is unreachable/);
    expect(byService.commerce).toMatchObject({ status: "ok", lastSyncStatus: "ok" });
    expect(byService.commerce.lastSyncAt).toBeTruthy();
  });

  it("a bad reply shape fails that service only", async () => {
    server.use(http.get(`${BASE}/shipping/shipments`, () => HttpResponse.json([{ id: "S-001" }])));
    const report = await syncAll();
    expect(report.services.find((s) => s.service === "shipping")).toMatchObject({ status: "failed" });
    expect(count(orders)).toBe(60);
  });

  it("evt-003 cancels NC-1004 locally; a later sync keeps it cancelled with upstream_status processing", async () => {
    await syncAll();
    expect((await receiveWebhook(evt3)).status).toBe("applied");
    await syncAll();
    expect(order("NC-1004")).toMatchObject({
      status: "cancelled",
      upstreamStatus: "processing",
      localEventAt: "2026-11-22T10:10:00Z",
    });
  });

  it("an app-cancelled order survives a mock restart: stays cancelled, upstream_status processing", async () => {
    await syncAll();
    // What Block 3's successful cancel will do: local_event_at = now plus a source=app event.
    const now = new Date().toISOString();
    db.update(orders).set({ status: "cancelled", localEventAt: now }).where(eq(orders.id, "NC-1004")).run();
    db.insert(webhookEvents)
      .values({
        eventId: "app-1",
        source: "app",
        type: "order.cancelled",
        orderId: "NC-1004",
        occurredAt: now,
        payload: "{}",
        status: "applied",
      })
      .run();

    server.use(ordersWith({ "NC-1004": "cancelled" })); // upstream agrees...
    await syncAll();
    expect(order("NC-1004")).toMatchObject({ status: "cancelled", upstreamStatus: "cancelled", localEventAt: now });

    server.resetHandlers(); // ...then the mock restarts and forgets the cancel
    await syncAll();
    expect(order("NC-1004")).toMatchObject({ status: "cancelled", upstreamStatus: "processing", localEventAt: now });
  });

  it("an order not set locally follows upstream", async () => {
    await syncAll();
    server.use(ordersWith({ "NC-1005": "shipped" }));
    await syncAll();
    expect(order("NC-1005")).toMatchObject({ status: "shipped", upstreamStatus: "shipped" });
  });

  it("an event for an unknown order is pending, then applied after the next sync (and fires the hook)", async () => {
    expect((await receiveWebhook(evt3)).status).toBe("pending"); // nothing synced yet
    expect(hook).not.toHaveBeenCalled();

    const report = await syncAll();
    expect(report.pendingApplied).toBe(1);
    expect(db.select().from(webhookEvents).where(eq(webhookEvents.eventId, "evt-003")).get()!.status).toBe("applied");
    expect(order("NC-1004")).toMatchObject({ status: "cancelled", upstreamStatus: "processing" });
    expect(hook).toHaveBeenCalledTimes(1);

    await syncAll(); // already applied: not replayed
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("a shipment set by a webhook keeps its status unless upstream is strictly newer", async () => {
    await syncAll();
    await receiveWebhook({
      event_id: "evt-001",
      type: "shipment.updated",
      order_id: "NC-1001",
      occurred_at: "2026-11-22T10:00:00Z",
      data: { status: "delayed" },
    });
    await syncAll();
    expect(db.select().from(shipments).where(eq(shipments.orderId, "NC-1001")).get()).toMatchObject({
      status: "delayed",
      updatedAt: "2026-11-22T10:00:00Z",
      upstreamStatus: "shipped",
      upstreamUpdatedAt: "2026-11-21T09:00:00Z",
    });
  });

  it("refunds missing upstream after a restart are flagged, not deleted", async () => {
    const refund = { id: "R-1", order_id: "NC-1003", amount_minor: 5000, currency: "INR", status: "succeeded" };
    server.use(http.get(`${BASE}/payments/refunds`, () => HttpResponse.json([refund])));
    await syncAll();
    server.resetHandlers();
    await syncAll();
    expect(db.select().from(refunds).where(and(eq(refunds.id, "R-1"), eq(refunds.missingUpstream, true))).get()).toBeTruthy();
  });
});

describe("merge rules", () => {
  it("mergeStatus keeps a locally set status and follows upstream otherwise", () => {
    expect(mergeStatus({ status: "cancelled", localEventAt: "2026-11-22T10:10:00Z" }, "processing")).toBe("cancelled");
    expect(mergeStatus({ status: "processing", localEventAt: null }, "shipped")).toBe("shipped");
  });

  it("upstreamShipmentWins only when strictly newer", () => {
    expect(upstreamShipmentWins("2026-11-22T10:00:00Z", "2026-11-22T10:00:01Z")).toBe(true);
    expect(upstreamShipmentWins("2026-11-22T10:00:00Z", "2026-11-22T10:00:00.000Z")).toBe(false);
    expect(upstreamShipmentWins("2026-11-22T10:00:00Z", "2026-11-21T09:00:00Z")).toBe(false);
  });
});
