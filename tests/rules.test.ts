// Gap tests found while mapping CLAUDE.md business rules to tests (see the table in the Block 7 report).
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "@/server/clients/mock";
import type { Db } from "@/server/db";
import { auditLog, operations, orders, payments, refunds, shipments } from "@/server/db/schema";
import { approveRefund } from "@/server/services/approvals";
import { unpaidShipped } from "@/server/services/dashboard";
import { cancelOrder } from "@/server/services/orders";
import { refundPosition, requestBulkRefunds, requestRefund } from "@/server/services/refunds";
import { syncAll } from "@/server/services/sync";
import { createWorkflow, updateWorkflow } from "@/server/services/workflows";
import { clearData, setupTestDb } from "./helpers/db";
import { BASE, server } from "./helpers/mock-server";

// Keep the real workflow service (create/update are audited there); only the webhook hook is silenced.
vi.mock("@/server/services/workflows", async (orig) => ({
  ...(await orig<typeof import("@/server/services/workflows")>()),
  onWebhookEvent: vi.fn(async () => {}),
}));

const OP = { userId: 3, label: "operator@nova.test", role: "operator" };
const MGR = { userId: 4, label: "manager@nova.test", role: "manager" };

let db: Db;
beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" }); // an unexpected upstream call fails the test
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(async () => {
  clearData();
  await syncAll();
});
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action)).all();

describe("rule: no cancel when order or shipment has moved on", () => {
  type Change = { order?: string; shipment?: string };
  it.each<[string, Change, string]>([
    ["order delivered", { order: "delivered" }, "order is delivered"],
    ["shipment shipped", { shipment: "shipped" }, "shipment is shipped"],
    ["shipment delivered", { shipment: "delivered" }, "shipment is delivered"],
  ])("%s is refused before any API call", async (_label, set, reason) => {
    if (set.order) db.update(orders).set({ status: "delivered" }).where(eq(orders.id, "NC-1004")).run();
    if (set.shipment) db.update(shipments).set({ status: set.shipment as "shipped" }).where(eq(shipments.orderId, "NC-1004")).run();
    expect(await cancelOrder("NC-1004", OP)).toMatchObject({ ok: false, code: "refused", reason });
  });
});

describe("rule: cancel state comes from the API's answer", () => {
  it("HTTP 200 whose body does not say cancelled is a failure; the order is unchanged", async () => {
    server.use(http.post(`${BASE}/commerce/orders/:id/cancel`, () => HttpResponse.json({ id: "NC-1004", status: "processing" })));
    expect(await cancelOrder("NC-1004", OP)).toMatchObject({ ok: false, code: "upstream" });
    expect(db.select().from(orders).where(eq(orders.id, "NC-1004")).get()).toMatchObject({ status: "processing", localEventAt: null });
    expect(audits("order.cancel")[0].outcome).toBe("failed");
  });

  it("a successful cancel is audited with who, role, target and outcome", async () => {
    server.use(http.post(`${BASE}/commerce/orders/:id/cancel`, () => HttpResponse.json({ id: "NC-1004", status: "cancelled" })));
    await cancelOrder("NC-1004", OP);
    expect(audits("order.cancel")[0]).toMatchObject({ actorLabel: OP.label, role: "operator", target: "NC-1004", outcome: "succeeded" });
  });
});

describe("rule: refund amount cap = captured - non-failed refunds - open requests", () => {
  const addRefund = (id: string, amountMinor: number, status: "succeeded" | "failed") =>
    db.insert(refunds).values({ id, orderId: "NC-1002", amountMinor, currency: "INR", status }).run();

  it("a partial refund is allowed and reserves only its amount", () => {
    expect(requestRefund("NC-1002", 50000, OP)).toMatchObject({ ok: true, amountMinor: 50000 });
    expect(refundPosition("NC-1002")).toMatchObject({ capturedMinor: 175000, reservedMinor: 50000, refundableMinor: 125000 });
  });

  it("a succeeded refund lowers the cap, a failed one does not", () => {
    addRefund("R-T1", 100000, "succeeded");
    addRefund("R-T2", 75000, "failed");
    expect(refundPosition("NC-1002").refundableMinor).toBe(75000);
    expect(requestRefund("NC-1002", 75001, OP)).toMatchObject({ ok: false, code: "refused" });
    expect(requestRefund("NC-1002", 75000, OP)).toMatchObject({ ok: true });
  });

  it("nothing is refundable once fully refunded", () => {
    addRefund("R-T1", 175000, "succeeded");
    expect(requestRefund("NC-1002", undefined, OP)).toMatchObject({ ok: false, reason: "nothing left to refund" });
  });

  it("refund requests and the bulk action are audited", () => {
    requestRefund("NC-1002", undefined, OP);
    requestRefund("NC-1005", undefined, OP); // refused: processing
    expect(audits("refund.request").map((a) => a.outcome)).toEqual(["pending_approval", "refused"]);
    requestBulkRefunds(OP);
    expect(audits("refund.bulk_request")[0]).toMatchObject({ actorLabel: OP.label, outcome: "ok" });
  });
});

describe("rule: approve re-reads upstream and re-checks before the Payment API is called", () => {
  function upstream(payment: Record<string, unknown>) {
    const posts = { n: 0 };
    server.use(
      http.get(`${BASE}/commerce/orders/:id`, () => HttpResponse.json({ id: "NC-1002", status: "delivered" })),
      http.get(`${BASE}/payments/transactions/:id`, () => HttpResponse.json({ order_id: "NC-1002", ...payment })),
      http.post(`${BASE}/payments/refunds`, () => {
        posts.n++;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    return posts;
  }
  const pending = () => {
    const r = requestRefund("NC-1002", undefined, OP);
    if (!r.ok) throw new Error(r.reason);
    return r.approvalId;
  };

  it("upstream payment no longer captured: refused with the reason, no refund call", async () => {
    const posts = upstream({ status: "failed", amount_minor: 175000 });
    expect(await approveRefund(pending(), MGR)).toMatchObject({ ok: true, status: "failed" });
    expect(db.select().from(operations).get()!.error).toBe("upstream says payment is failed, not captured");
    expect(posts.n).toBe(0);
  });

  it("upstream captured amount smaller than the request: refused, no refund call", async () => {
    const posts = upstream({ status: "captured", amount_minor: 100000 });
    expect(await approveRefund(pending(), MGR)).toMatchObject({ status: "failed" });
    expect(db.select().from(operations).get()!.error).toContain("exceeds the refundable ₹1,000.00 upstream");
    expect(posts.n).toBe(0);
  });
});

describe("rule: unpaid shipped/delivered orders stay at risk until upstream shows them paid", () => {
  it("leaves the list only when the payment becomes captured", () => {
    const before = unpaidShipped().orders.map((o) => o.orderId);
    expect(before.length).toBeGreaterThan(0);
    db.update(payments).set({ status: "captured" }).where(eq(payments.orderId, before[0])).run();
    expect(unpaidShipped().orders.map((o) => o.orderId)).toEqual(before.slice(1));
  });
});

describe("rule: workflow changes are audited", () => {
  it("create, disable and update write who and what", () => {
    const created = createWorkflow(
      {
        name: "T",
        trigger: "payment.failed",
        conditions: [{ field: "amount_minor", op: "gt", value: 1 }],
        action: { type: "create_ticket", reason: "x" },
        enabled: true,
      },
      MGR,
    );
    if (!created.ok) throw new Error("create failed");
    updateWorkflow(created.workflow.id, { enabled: false }, MGR);
    updateWorkflow(created.workflow.id, { name: "T2" }, MGR);
    expect(["workflow.create", "workflow.disable", "workflow.update"].map((a) => audits(a)[0]?.actorLabel)).toEqual([MGR.label, MGR.label, MGR.label]);
  });
});

describe("rule: 5 s timeout per attempt", () => {
  it("a reply that never comes ends as a timeout error", async () => {
    server.use(http.get(`${BASE}/commerce/customers`, () => new Promise<Response>(() => {})));
    const res = await request("GET", "/commerce/customers", undefined, false);
    expect(res).toMatchObject({ ok: false, error: "Commerce API did not answer in time" });
  }, 15000);
});
