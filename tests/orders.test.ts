import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute } from "@/app/api/orders/route";
import { GET as detailRoute } from "@/app/api/orders/[id]/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { POST as reconcileRoute } from "@/app/api/orders/[id]/reconcile-cancel/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { POST as refundRoute } from "@/app/api/orders/[id]/refund-requests/route";
import { POST as bulkRoute } from "@/app/api/refund-requests/bulk/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { approvals, auditLog, operations, orders, shipments, users, webhookEvents } from "@/server/db/schema";
import { syncAll } from "@/server/services/sync";
import { onWebhookEvent } from "@/server/services/workflows";
import { formatMoney, parseRupees } from "@/lib/format";
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
beforeEach(async () => {
  clearData();
  await syncAll();
  hook.mockClear();
});

async function cookieFor(email: string): Promise<string> {
  const user = db.select().from(users).where(eq(users.email, email)).get()!;
  return (await createSessionCookie(user.id)).split(";")[0];
}
const OPERATOR = "operator@nova.test";
const VIEWER = "viewer@nova.test";

async function call(
  handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  url: string,
  opts: { id?: string; method?: string; body?: unknown; as?: string } = {},
) {
  const req = new Request(`http://localhost${url}`, {
    method: opts.method ?? "POST",
    headers: { "Content-Type": "application/json", cookie: await cookieFor(opts.as ?? OPERATOR) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve({ id: opts.id ?? "" }) });
  return { status: res.status, body: await res.json() };
}
const cancel = (id: string, as?: string) => call(cancelRoute, `/api/orders/${id}/cancel`, { id, as });
const pushCancel = (id: string, as?: string) => call(reconcileRoute, `/api/orders/${id}/reconcile-cancel`, { id, as });
const refund = (id: string, body: unknown = {}, as?: string) =>
  call(refundRoute, `/api/orders/${id}/refund-requests`, { id, body, as });
const bulk = (as?: string) => call((req) => bulkRoute(req), "/api/refund-requests/bulk", { as });
const detail = (id: string) => call(detailRoute, `/api/orders/${id}`, { id, method: "GET" });
const list = (qs: string) => call((req) => listRoute(req), `/api/orders${qs}`, { method: "GET" });

const shippingHealth = async () =>
  ((await (await healthRoute()).json()).services as { service: string; status: string }[]).find((x) => x.service === "shipping");
// evt-003: NC-1004 cancelled by webhook; upstream still says processing.
const cancelLocallyByWebhook = (id: string) =>
  db.update(orders).set({ status: "cancelled", localEventAt: "2026-11-22T10:10:00Z" }).where(eq(orders.id, id)).run();
const order = (id: string) => db.select().from(orders).where(eq(orders.id, id)).get()!;
const opsFor = (id: string) => db.select().from(operations).where(eq(operations.orderId, id)).all();

// Counts calls to the Commerce cancel endpoint and answers with `reply`.
function mockCancel(reply: (id: string) => Response) {
  const calls: string[] = [];
  server.use(
    http.post(`${BASE}/commerce/orders/:id/cancel`, ({ params }) => {
      calls.push(params.id as string);
      return reply(params.id as string);
    }),
  );
  return calls;
}
const cancelledOrder = (id: string) => HttpResponse.json({ ...businessData.orders.find((o) => o.id === id), status: "cancelled" });

describe("POST /api/orders/[id]/cancel", () => {
  it("NC-1001 (shipped) is refused locally with no API call", async () => {
    const calls = mockCancel(cancelledOrder);
    const res = await cancel("NC-1001");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order is shipped");
    expect(calls).toHaveLength(0);
    expect(opsFor("NC-1001")).toHaveLength(0);
    expect(order("NC-1001").status).toBe("shipped");
    const log = db.select().from(auditLog).where(eq(auditLog.action, "order.cancel")).get()!;
    expect(log).toMatchObject({ actorLabel: OPERATOR, role: "operator", target: "NC-1001", outcome: "refused" });
  });

  it("refuses a delayed shipment even when the order is processing", async () => {
    const calls = mockCancel(cancelledOrder);
    db.update(shipments).set({ status: "delayed" }).where(eq(shipments.orderId, "NC-1004")).run();
    const res = await cancel("NC-1004");
    expect(res).toMatchObject({ status: 409, body: { error: "shipment is delayed" } });
    expect(calls).toHaveLength(0);
  });

  it("NC-1004 cancels through the API, records an app event and calls the hook once", async () => {
    const calls = mockCancel(cancelledOrder);
    const res = await cancel("NC-1004");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["NC-1004"]);
    expect(order("NC-1004")).toMatchObject({ status: "cancelled", upstreamStatus: "cancelled" });
    expect(order("NC-1004").localEventAt).toBeTruthy();
    expect(opsFor("NC-1004")).toEqual([expect.objectContaining({ type: "cancel", status: "succeeded", requestedByLabel: OPERATOR })]);
    const event = db.select().from(webhookEvents).where(eq(webhookEvents.orderId, "NC-1004")).get()!;
    expect(event).toMatchObject({ source: "app", type: "order.cancelled", status: "applied" });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ eventId: event.eventId, type: "order.cancelled", orderId: "NC-1004" }));

    // A second cancel is refused locally: no second API call, no second workflow run.
    expect((await cancel("NC-1004")).status).toBe(409);
    expect(calls).toHaveLength(1);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("a mock 409 is saved as failed with its message; the order is unchanged", async () => {
    mockCancel(() => HttpResponse.json({ error: "already shipped" }, { status: 409 }));
    const res = await cancel("NC-1004");
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "already shipped", upstreamStatus: 409 });
    expect(opsFor("NC-1004")).toEqual([expect.objectContaining({ status: "failed", error: "already shipped" })]);
    expect(order("NC-1004")).toMatchObject({ status: "processing", localEventAt: null });
    expect(hook).not.toHaveBeenCalled();
    expect(db.select().from(auditLog).where(eq(auditLog.action, "order.cancel")).get()?.outcome).toBe("failed");
  });

  it("mock down: saved as failed with the error, order unchanged", async () => {
    const calls = mockCancel(() => HttpResponse.error());
    const res = await cancel("NC-1004");
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(3); // network errors are retried
    const [op] = opsFor("NC-1004");
    expect(op.status).toBe("failed");
    expect(op.error).toMatch(/network error/);
    expect(order("NC-1004")).toMatchObject({ status: "processing", upstreamStatus: "processing", localEventAt: null });
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("POST /api/orders/[id]/reconcile-cancel (Push cancel upstream)", () => {
  it("NC-1004 after evt-003: a repeat cancel is refused, the push makes upstream agree without firing workflows", async () => {
    cancelLocallyByWebhook("NC-1004");
    const calls = mockCancel(cancelledOrder);
    expect((await list("?localAhead=true")).body.total).toBe(1);

    const repeat = await cancel("NC-1004");
    expect(repeat).toMatchObject({ status: 409, body: { error: "order is already cancelled locally; use Push cancel upstream" } });
    expect(calls).toHaveLength(0);

    const res = await pushCancel("NC-1004");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["NC-1004"]);
    expect(order("NC-1004")).toMatchObject({ status: "cancelled", upstreamStatus: "cancelled", localEventAt: "2026-11-22T10:10:00Z" });
    expect(opsFor("NC-1004")).toEqual([expect.objectContaining({ type: "reconcile", status: "succeeded", requestedByLabel: OPERATOR })]);
    expect(db.select().from(webhookEvents).all()).toHaveLength(0); // no app event
    expect(hook).not.toHaveBeenCalled();
    const log = db.select().from(auditLog).where(eq(auditLog.action, "order.reconcile_cancel")).all();
    expect(log).toEqual([expect.objectContaining({ actorLabel: OPERATOR, role: "operator", target: "NC-1004", outcome: "succeeded" })]);
    expect((await list("?localAhead=true")).body.total).toBe(0);

    // Done: a second push is refused locally.
    expect((await pushCancel("NC-1004")).body.error).toBe("upstream order is cancelled, not processing");
    expect(calls).toHaveLength(1);
  });

  it("is refused for an order not cancelled locally (NC-1005), with no API call", async () => {
    const calls = mockCancel(cancelledOrder);
    const res = await pushCancel("NC-1005");
    expect(res).toMatchObject({ status: 409, body: { error: "order is processing locally, not cancelled" } });
    expect(calls).toHaveLength(0);
    expect(opsFor("NC-1005")).toHaveLength(0);
  });

  it("a mock 409 is saved as a failed reconcile; the order stays local ahead", async () => {
    cancelLocallyByWebhook("NC-1004");
    mockCancel(() => HttpResponse.json({ error: "already shipped" }, { status: 409 }));
    const res = await pushCancel("NC-1004");
    expect(res.status).toBe(502);
    expect(opsFor("NC-1004")).toEqual([expect.objectContaining({ type: "reconcile", status: "failed", error: "already shipped" })]);
    expect(order("NC-1004")).toMatchObject({ status: "cancelled", upstreamStatus: "processing" });
  });

  it("a Viewer gets 403", async () => {
    cancelLocallyByWebhook("NC-1004");
    const calls = mockCancel(cancelledOrder);
    expect((await pushCancel("NC-1004", VIEWER)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/orders/[id]/refund-requests", () => {
  it("NC-1005 (processing) is refused", async () => {
    const res = await refund("NC-1005");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/order is processing/);
    expect(opsFor("NC-1005")).toHaveLength(0);
  });

  it("NC-1028 (payment failed) is refused", async () => {
    const res = await refund("NC-1028");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/payment is failed/);
    expect(opsFor("NC-1028")).toHaveLength(0);
  });

  it.each([0, -100, 150.5, "1000"])("rejects amount_minor %s with 400", async (amount) => {
    const res = await refund("NC-1002", { amount_minor: amount });
    expect(res.status).toBe(400);
    expect(opsFor("NC-1002")).toHaveLength(0);
  });

  it("refuses an amount over the cap (NC-1002 captured 175000)", async () => {
    const res = await refund("NC-1002", { amount_minor: 175001 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/exceeds the refundable 175000/);
  });

  it("defaults to the full refundable amount and creates a pending approval, no Payment API call", async () => {
    let paymentCalls = 0;
    server.use(http.post(`${BASE}/payments/refunds`, () => {
      paymentCalls++;
      return HttpResponse.json({}, { status: 201 });
    }));
    const res = await refund("NC-1002");
    expect(paymentCalls).toBe(0);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, amountMinor: 175000 });
    const [op] = opsFor("NC-1002");
    expect(op).toMatchObject({ type: "refund", status: "pending_approval", amountMinor: 175000, requestedByLabel: OPERATOR });
    const approval = db.select().from(approvals).where(eq(approvals.operationId, op.id)).get()!;
    expect(approval).toMatchObject({ status: "pending", requestedByUserId: op.requestedByUserId });
  });

  it("a second request over the cap is refused, counting the first (still pending)", async () => {
    expect((await refund("NC-1002", { amount_minor: 100000 })).status).toBe(201);
    const over = await refund("NC-1002", { amount_minor: 75001 });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/exceeds the refundable 75000/);
    expect((await refund("NC-1002", { amount_minor: 75000 })).status).toBe(201);
    expect((await refund("NC-1002")).body.error).toBe("nothing left to refund");
  });
});

describe("POST /api/refund-requests/bulk", () => {
  it("creates 11 pending approvals (₹1,37,750 owed) the first time and 0 the second", async () => {
    const first = await bulk();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: 11, skipped: 0 });
    const ops = db.select().from(operations).where(eq(operations.type, "refund")).all();
    expect(ops).toHaveLength(11);
    expect(ops.reduce((sum, o) => sum + (o.amountMinor ?? 0), 0)).toBe(13775000);
    expect(db.select().from(approvals).all()).toHaveLength(11);

    const second = await bulk();
    expect(second.body).toMatchObject({ created: 0, skipped: 11 });
    expect(db.select().from(operations).all()).toHaveLength(11);
  });
});

describe("GET /api/orders/[id]", () => {
  it("NC-1012: the shipping lookup 503 returns the stored shipment plus the error", async () => {
    server.use(
      http.get(`${BASE}/shipping/shipments/:id`, () => HttpResponse.json({ error: "carrier temporarily unavailable" }, { status: 503 })),
    );
    const res = await detail("NC-1012");
    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe("NC-1012");
    expect(res.body.shipment).toMatchObject({ orderId: "NC-1012", status: "delivered" });
    expect(res.body.shippingError).toMatch(/^Shipping lookup failed: carrier temporarily unavailable, showing data from .+ IST$/);
    expect(res.body.payment).toMatchObject({ status: "captured" });
    expect(res.body.refundPosition).toMatchObject({ capturedMinor: res.body.payment.amountMinor, refundedMinor: 0 });
  });

  it("opening NC-1012 (lookup 503) leaves Shipping ok: that error belongs to the order", async () => {
    server.use(
      http.get(`${BASE}/shipping/shipments/:id`, () => HttpResponse.json({ error: "carrier temporarily unavailable" }, { status: 503 })),
    );
    expect(await shippingHealth()).toMatchObject({ status: "ok" });
    expect((await detail("NC-1012")).body.shippingError).toMatch(/carrier temporarily unavailable/);
    expect(await shippingHealth()).toMatchObject({ status: "ok" });
  });

  it("a network failure on the lookup does mark Shipping down", async () => {
    server.use(http.get(`${BASE}/shipping/shipments/:id`, () => HttpResponse.error()));
    expect((await detail("NC-1004")).body.shippingError).toMatch(/^Shipping lookup failed: network error/);
    expect(await shippingHealth()).toMatchObject({ status: "down" });
  });

  it("refreshes the shipment from a successful live lookup", async () => {
    server.use(
      http.get(`${BASE}/shipping/shipments/:id`, () =>
        HttpResponse.json({ id: "S-004", order_id: "NC-1004", status: "delayed", updated_at: "2026-11-25T09:00:00Z" }),
      ),
    );
    const res = await detail("NC-1004");
    expect(res.body.shippingError).toBeNull();
    expect(res.body.shipment).toMatchObject({ status: "delayed", updatedAt: "2026-11-25T09:00:00Z" });
  });

  it("404 for an unknown order", async () => {
    expect((await detail("NC-9999")).status).toBe(404);
  });

  it("returns the allowed actions from the server's rules: NC-1001 cannot cancel, NC-1005 cannot refund", async () => {
    server.use(http.get(`${BASE}/shipping/shipments/:id`, () => HttpResponse.json({ error: "not found" }, { status: 404 })));
    const shipped = (await detail("NC-1001")).body.actions;
    expect(shipped.cancel).toEqual({ allowed: false, reason: "order is shipped" });

    const processing = (await detail("NC-1005")).body.actions;
    expect(processing.refund).toEqual({ allowed: false, reason: "order is processing, not cancelled or delivered" });
    expect(processing.cancel).toEqual({ allowed: true, reason: null });
    expect(processing.reconcile.allowed).toBe(false);

    expect((await detail("NC-1002")).body.actions.refund).toEqual({ allowed: true, reason: null }); // delivered + captured
  });
});

describe("GET /api/orders", () => {
  it("searches, filters and paginates", async () => {
    const all = await list("?pageSize=10&page=2");
    expect(all.body).toMatchObject({ total: 60, page: 2, pageSize: 10 });
    expect(all.body.items).toHaveLength(10);

    const byEmail = await list("?q=customer1@example.test");
    expect(byEmail.body.items.map((o: { id: string }) => o.id)).toContain("NC-1001");

    const cancelled = businessData.orders.filter((o) => o.status === "cancelled").length;
    expect((await list("?orderStatus=cancelled&paymentStatus=captured")).body.total).toBe(11);
    expect((await list("?orderStatus=cancelled")).body.total).toBe(cancelled);
  });

  it("filters local-ahead orders", async () => {
    cancelLocallyByWebhook("NC-1004");
    const res = await list("?localAhead=true");
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ id: "NC-1004", status: "cancelled", upstreamStatus: "processing", localAhead: true });
  });

  it.each(["?pageSize=101", "?page=0", "?orderStatus=lost"])("rejects %s with 400", async (qs) => {
    expect((await list(qs)).status).toBe(400);
  });
});

describe("roles", () => {
  it("a Viewer gets 403 on every write route and nothing is written", async () => {
    const calls = mockCancel(cancelledOrder);
    expect((await cancel("NC-1004", VIEWER)).status).toBe(403);
    expect((await refund("NC-1002", {}, VIEWER)).status).toBe(403);
    expect((await bulk(VIEWER)).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(db.select().from(operations).all()).toHaveLength(0);
  });

  it("a Viewer can read", async () => {
    expect((await call((req) => listRoute(req), "/api/orders", { method: "GET", as: VIEWER })).status).toBe(200);
  });
});

describe("format helpers", () => {
  it("formats paise as rupees and parses rupees without floats", () => {
    expect(formatMoney(13775000)).toBe("₹1,37,750.00");
    expect(formatMoney(5)).toBe("₹0.05");
    expect(parseRupees("1375.5")).toBe(137550);
    expect(parseRupees("0.29")).toBe(29);
    for (const bad of ["0", "-1", "1.234", "abc", ""]) expect(parseRupees(bad)).toBeNull();
  });
});
