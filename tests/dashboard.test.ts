import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as dashboardRoute } from "@/app/api/dashboard/route";
import { GET as integrationsRoute } from "@/app/api/integrations/route";
import { GET as detailRoute } from "@/app/api/orders/[id]/route";
import { POST as bulkRoute } from "@/app/api/refund-requests/bulk/route";
import { POST as syncRoute } from "@/app/api/sync/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { operations, refunds, users } from "@/server/db/schema";
import type { Dashboard } from "@/server/services/dashboard";
import { syncAll } from "@/server/services/sync";
import { receiveWebhook } from "@/server/services/webhooks";
import { verifyWebhookSecret } from "@/server/services/webhooks";
import { clearData, setupTestDb } from "./helpers/db";
import { BASE, server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));

let db: Db;
beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => clearData());

async function cookieFor(email: string): Promise<string> {
  const user = db.select().from(users).where(eq(users.email, email)).get()!;
  return (await createSessionCookie(user.id)).split(";")[0];
}
async function call(handler: (req: Request) => Promise<Response>, url: string, method = "GET", as = "viewer@nova.test") {
  const req = new Request(`http://localhost${url}`, { method, headers: { cookie: await cookieFor(as) } });
  const res = await handler(req);
  return { status: res.status, body: await res.json() };
}
const dashboard = async () => (await call(dashboardRoute, "/api/dashboard")).body as Dashboard;

describe("GET /api/dashboard", () => {
  it("after syncing the sample data: order counts, issues and money at risk match the data", async () => {
    await syncAll();
    const d = await dashboard();

    expect(d.orders.total).toBe(60);
    expect(d.orders.byStatus).toEqual({ processing: 23, delivered: 13, shipped: 12, cancelled: 12 });
    expect(d.paymentIssues.failedPayments).toBe(8);
    expect(d.shipmentIssues.delayed).toBe(6);

    expect(d.moneyAtRisk.owedRefunds.count).toBe(11);
    expect(d.moneyAtRisk.owedRefunds.totalMinor).toBe(13775000); // ₹1,37,750.00
    expect(d.moneyAtRisk.unpaidShipped.count).toBe(4);
    expect(d.moneyAtRisk.unpaidShipped.totalMinor).toBe(5125000); // ₹51,250.00
    expect(d.moneyAtRisk.owedRefunds.orders.every((o) => !o.pendingApproval)).toBe(true);
    expect(d.pendingApprovals.count).toBe(0);
    expect(d.health.map((h) => h.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("after the bulk refund request, the 11 owed orders show as pending approval", async () => {
    await syncAll();
    const bulk = await call(bulkRoute, "/api/refund-requests/bulk", "POST", "operator@nova.test");
    expect(bulk.body).toMatchObject({ created: 11, skipped: 0 });

    const d = await dashboard();
    expect(d.moneyAtRisk.owedRefunds.count).toBe(11); // still owed until the money is back
    expect(d.moneyAtRisk.owedRefunds.orders.every((o) => o.pendingApproval)).toBe(true);
    expect(d.pendingApprovals.count).toBe(11);
    expect(d.recentOperations).toHaveLength(10);
    expect(d.recentAudit[0]).toMatchObject({ action: "refund.bulk_request", actorLabel: "operator@nova.test" });
  });

  it("NC-1003 partly refunded (Rs 1,000 of Rs 2,125): still listed owing Rs 1,125; bulk requests Rs 1,125", async () => {
    await syncAll();
    db.insert(refunds).values({ id: "R-P1", orderId: "NC-1003", amountMinor: 100000, currency: "INR", status: "succeeded" }).run();
    const d = await dashboard();
    expect(d.moneyAtRisk.owedRefunds.orders.find((o) => o.orderId === "NC-1003")).toMatchObject({ amountMinor: 112500 });
    expect(d.moneyAtRisk.owedRefunds.totalMinor).toBe(13775000 - 100000);

    await call(bulkRoute, "/api/refund-requests/bulk", "POST", "operator@nova.test");
    const op = db.select().from(operations).where(eq(operations.orderId, "NC-1003")).get()!;
    expect(op).toMatchObject({ type: "refund", status: "pending_approval", amountMinor: 112500 });
  });

  it("a fully refunded cancelled order leaves the list", async () => {
    await syncAll();
    db.insert(refunds).values({ id: "R-P2", orderId: "NC-1003", amountMinor: 212500, currency: "INR", status: "succeeded" }).run();
    const d = await dashboard();
    expect(d.moneyAtRisk.owedRefunds.orders.map((o) => o.orderId)).not.toContain("NC-1003");
    expect(d.moneyAtRisk.owedRefunds.count).toBe(10);
  });

  it("works with every upstream call failing: local data, health shows each service down", async () => {
    await syncAll();
    server.use(http.all(`${BASE}/*`, () => HttpResponse.error()));
    const sync = await call(syncRoute, "/api/sync", "POST", "operator@nova.test");
    expect(sync.body.services.map((s: { status: string }) => s.status)).toEqual(["failed", "failed", "failed"]);

    const res = await call(dashboardRoute, "/api/dashboard");
    expect(res.status).toBe(200);
    const d = res.body as Dashboard;
    expect(d.orders.total).toBe(60);
    expect(d.moneyAtRisk.owedRefunds.count).toBe(11);
    for (const h of d.health) {
      expect(h).toMatchObject({ status: "down", lastSyncStatus: "failed" });
      expect(h.lastOkAt).not.toBeNull(); // "unreachable, data from <time>"
      expect(h.lastError).toBeTruthy();
    }
  });

  it("an empty DB gives zeros, not errors", async () => {
    const d = await dashboard();
    expect(d.orders).toEqual({ total: 0, byStatus: {} });
    expect(d.moneyAtRisk.owedRefunds).toEqual({ count: 0, totalMinor: 0, orders: [] });
    expect(d.health.map((h) => h.status)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("a failed single-shipment lookup (NC-1012) shows under shipment issues", async () => {
    await syncAll();
    server.use(http.get(`${BASE}/shipping/shipments/:id`, () => HttpResponse.json({ error: "carrier temporarily unavailable" }, { status: 503 })));
    const req = new Request("http://localhost/api/orders/NC-1012", { headers: { cookie: await cookieFor("viewer@nova.test") } });
    await detailRoute(req, { params: Promise.resolve({ id: "NC-1012" }) });

    const d = await dashboard();
    expect(d.shipmentIssues.lookupErrors.count).toBe(1);
    expect(d.shipmentIssues.lookupErrors.items[0].orderId).toBe("NC-1012");
  });

  it("401 without a session", async () => {
    const res = await dashboardRoute(new Request("http://localhost/api/dashboard"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/integrations", () => {
  it("lists sync runs and webhook events, filtered by status, including rejected ones", async () => {
    await syncAll();
    await receiveWebhook({ event_id: "evt-a", type: "shipment.updated", occurred_at: "2030-01-01T00:00:00Z", order_id: "NC-1001", data: { status: "delayed" } });
    await receiveWebhook({ event_id: "evt-b", type: "something.else", occurred_at: "2030-01-01T00:00:00Z", order_id: "NC-1001", data: {} });
    verifyWebhookSecret("wrong");

    const all = await call(integrationsRoute, "/api/integrations");
    expect(all.status).toBe(200);
    expect(all.body.syncRuns).toHaveLength(3);
    expect(all.body.events.map((e: { status: string }) => e.status).sort()).toEqual(["applied", "ignored", "rejected"]);

    const ignored = await call(integrationsRoute, "/api/integrations?status=ignored");
    expect(ignored.body.events.map((e: { id: string }) => e.id)).toEqual(["evt-b"]);
    const rejected = await call(integrationsRoute, "/api/integrations?status=rejected");
    expect(rejected.body.events).toHaveLength(1);
    expect((await call(integrationsRoute, "/api/integrations?status=bogus")).status).toBe(400);
  });
});
