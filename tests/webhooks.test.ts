import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as webhook } from "@/app/api/webhooks/route";
import type { Db } from "@/server/db";
import { auditLog, orders, shipments, webhookEvents } from "@/server/db/schema";
import { syncAll } from "@/server/services/sync";
import { onWebhookEvent } from "@/server/services/workflows";
import { clearData, setupTestDb } from "./helpers/db";
import { server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));
const hook = vi.mocked(onWebhookEvent);

const SECRET = process.env.WEBHOOK_SECRET!;
let db: Db;
beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" });
});
afterAll(() => server.close());
beforeEach(async () => {
  clearData();
  await syncAll(); // import the seed data through MSW
  hook.mockClear();
});

function send(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Webhook-Secret"] = secret;
  return webhook(
    new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
const evt = (over: Record<string, unknown> = {}) => ({
  event_id: "evt-001",
  type: "shipment.updated",
  occurred_at: "2026-11-22T10:00:00Z",
  order_id: "NC-1001",
  data: { status: "delayed" },
  ...over,
});
const shipment = (orderId: string) => db.select().from(shipments).where(eq(shipments.orderId, orderId)).get()!;
const eventRow = (id: string) => db.select().from(webhookEvents).where(eq(webhookEvents.eventId, id)).get();

describe("POST /api/webhooks: secret", () => {
  it.each([
    ["missing", null],
    ["wrong", "not-the-secret"],
  ])("rejects a %s secret with 401, logs it, stores nothing", async (_label, secret) => {
    const res = await send(evt(), secret);
    expect(res.status).toBe(401);
    expect(eventRow("evt-001")).toBeUndefined();
    const log = db.select().from(auditLog).where(eq(auditLog.action, "webhook.rejected")).all();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorLabel: "webhook", outcome: "denied" });
    expect(shipment("NC-1001").status).toBe("shipped");
  });
});

describe("POST /api/webhooks: validation", () => {
  it.each([
    ["invalid JSON", "{not json"],
    ["missing event_id", { ...evt(), event_id: undefined }],
    ["bad occurred_at", evt({ occurred_at: "yesterday" })],
    ["array order_id", evt({ order_id: ["NC-1001"] })],
    ["status not allowed for the type", evt({ data: { status: "teleported" } })],
    ["order.cancelled with another status", evt({ type: "order.cancelled", data: { status: "processing" } })],
  ])("returns 400 for %s and stores nothing", async (_label, body) => {
    expect((await send(body)).status).toBe(400);
    expect(db.select().from(webhookEvents).all()).toHaveLength(0);
  });

  it("stores an unknown type as ignored and returns 200", async () => {
    const res = await send(evt({ event_id: "evt-x1", type: "order.refunded", data: { anything: 1 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event_id: "evt-x1", status: "ignored" });
    expect(eventRow("evt-x1")?.status).toBe("ignored");
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks: apply", () => {
  it("applies evt-001 and calls the workflow hook once", async () => {
    const res = await send(evt());
    expect(await res.json()).toEqual({ event_id: "evt-001", status: "applied" });
    expect(shipment("NC-1001")).toMatchObject({ status: "delayed", updatedAt: "2026-11-22T10:00:00Z" });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-001", orderId: "NC-1001" }));
  });

  it("a duplicate event_id returns 200 and changes nothing", async () => {
    await send(evt());
    db.update(shipments).set({ status: "delivered" }).where(eq(shipments.orderId, "NC-1001")).run(); // moved on since
    const res = await send(evt());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event_id: "evt-001", status: "duplicate" });
    expect(shipment("NC-1001").status).toBe("delivered");
    expect(eventRow("evt-001")?.status).toBe("applied");
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("stores a shipment event older than the row's updated_at as stale and does not apply it", async () => {
    // Seed: NC-1001 shipment updated_at 2026-11-21T09:00:00Z
    const res = await send(evt({ event_id: "evt-old", occurred_at: "2026-11-21T08:59:59Z" }));
    expect(await res.json()).toEqual({ event_id: "evt-old", status: "stale" });
    expect(shipment("NC-1001")).toMatchObject({ status: "shipped", updatedAt: "2026-11-21T09:00:00Z" });
    expect(hook).not.toHaveBeenCalled();
  });

  it("applies a shipment event with exactly the row's updated_at", async () => {
    const res = await send(evt({ event_id: "evt-eq", occurred_at: "2026-11-21T09:00:00Z" }));
    expect(await res.json()).toEqual({ event_id: "evt-eq", status: "applied" });
    expect(shipment("NC-1001").status).toBe("delayed");
  });

  it("evt-002 marks NC-1007's payment failed, evt-003 cancels NC-1004 locally", async () => {
    await send(evt({ event_id: "evt-002", type: "payment.failed", order_id: "NC-1007", data: { status: "failed" } }));
    await send(evt({ event_id: "evt-003", type: "order.cancelled", order_id: "NC-1004", occurred_at: "2026-11-22T10:10:00Z", data: { status: "cancelled" } }));
    const order = db.select().from(orders).where(eq(orders.id, "NC-1004")).get()!;
    expect(order).toMatchObject({ status: "cancelled", upstreamStatus: "processing", localEventAt: "2026-11-22T10:10:00Z" });
    expect(hook).toHaveBeenCalledTimes(2);
  });
});
