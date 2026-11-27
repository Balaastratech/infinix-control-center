import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as webhook } from "@/app/api/webhooks/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/workflows/route";
import { PATCH as patchRoute } from "@/app/api/workflows/[id]/route";
import { GET as executionsRoute } from "@/app/api/workflows/[id]/executions/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { approvals, operations, orders, tickets, users, workflowExecutions, workflows } from "@/server/db/schema";
import { requestRefund } from "@/server/services/refunds";
import { syncAll } from "@/server/services/sync";
import { seedWorkflows } from "@/server/services/workflows";
import { clearData, setupTestDb } from "./helpers/db";
import { BASE, businessData, server } from "./helpers/mock-server";

const SECRET = process.env.WEBHOOK_SECRET!;
const VIEWER = "viewer@nova.test";
const OPERATOR = "operator@nova.test";
const MANAGER = "manager@nova.test";
const DELAYED_RULE = "Delayed high-value shipment";
const REFUND_RULE = "Refund cancelled paid orders";

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
  seedWorkflows();
});

// ---------- helpers ----------

async function send(event: Record<string, unknown>) {
  const res = await webhook(
    new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": SECRET },
      body: JSON.stringify(event),
    }),
  );
  return { status: res.status, body: await res.json() };
}
const delayed = (orderId: string, eventId = `evt-delay-${orderId}`) => ({
  event_id: eventId,
  type: "shipment.updated",
  occurred_at: "2026-11-22T10:00:00Z",
  order_id: orderId,
  data: { status: "delayed" },
});
const EVT_003 = { event_id: "evt-003", type: "order.cancelled", occurred_at: "2026-11-22T10:10:00Z", order_id: "NC-1004", data: { status: "cancelled" } };

async function cookieFor(email: string) {
  const user = db.select().from(users).where(eq(users.email, email)).get()!;
  return (await createSessionCookie(user.id)).split(";")[0];
}
async function call(
  handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  opts: { as: string; method?: string; id?: string | number; body?: unknown },
) {
  const req = new Request("http://localhost/api/workflows", {
    method: opts.method ?? "POST",
    headers: { "Content-Type": "application/json", cookie: await cookieFor(opts.as) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve({ id: String(opts.id ?? "") }) });
  return { status: res.status, body: await res.json() };
}

const wf = (name: string) => db.select().from(workflows).where(eq(workflows.name, name)).get()!;
const runs = (name: string) => db.select().from(workflowExecutions).where(eq(workflowExecutions.workflowId, wf(name).id)).all();

// Fake Commerce tickets API. "down": every call is a network error. "lostReply": the first POST creates the
// ticket but the reply never arrives (looks like a network error).
function fakeTickets(mode: "ok" | "down" | "lostReply" = "ok") {
  const state = { rows: [] as Record<string, unknown>[], posts: 0, mode };
  server.use(
    http.get(`${BASE}/commerce/tickets`, () => (state.mode === "down" ? HttpResponse.error() : HttpResponse.json(state.rows))),
    http.post(`${BASE}/commerce/tickets`, async ({ request }) => {
      state.posts++;
      if (state.mode === "down") return HttpResponse.error();
      const body = (await request.json()) as { order_id: string; reason: string };
      const t = { id: `T-${state.rows.length + 1}`, order_id: body.order_id, reason: body.reason, status: "open" };
      state.rows.push(t);
      if (state.mode === "lostReply") {
        state.mode = "ok";
        return HttpResponse.error();
      }
      return HttpResponse.json(t, { status: 201 });
    }),
  );
  return state;
}
function countRefundPosts() {
  const state = { posts: 0 };
  server.use(
    http.post(`${BASE}/payments/refunds`, () => {
      state.posts++;
      return HttpResponse.json({ error: "should not be called" }, { status: 500 });
    }),
  );
  return state;
}

// ---------- create_ticket ----------

describe("Delayed high-value shipment -> create_ticket", () => {
  it("a delayed event for NC-1016 (Rs 7,000) creates one ticket and records it", async () => {
    const api = fakeTickets();
    expect((await send(delayed("NC-1016"))).body.status).toBe("applied");
    expect(api.posts).toBe(1);
    const [run] = runs(DELAYED_RULE);
    expect(run).toMatchObject({ eventId: "evt-delay-NC-1016", orderId: "NC-1016", matched: true, outcome: "succeeded", error: null });
    expect(JSON.parse(run.result!)).toEqual({ ticketId: "T-1" });
    const ticket = db.select().from(tickets).where(eq(tickets.id, "T-1")).get()!;
    expect(ticket).toMatchObject({ orderId: "NC-1016", workflowExecutionId: run.id, createdByLabel: `workflow:${DELAYED_RULE}` });
    expect(ticket.reason).toBe("Delayed shipment on high-value order NC-1016 (₹7,000.00)");
  });

  it("NC-1006 (Rs 3,250) is skipped with the failing condition, no API call", async () => {
    const api = fakeTickets();
    await send(delayed("NC-1006"));
    expect(api.posts).toBe(0);
    expect(runs(DELAYED_RULE)).toEqual([
      expect.objectContaining({ matched: false, outcome: "skipped", result: "amount_minor 325000 is not gt 500000" }),
    ]);
  });

  it("the same event again is a duplicate: no second ticket or execution", async () => {
    const api = fakeTickets();
    await send(delayed("NC-1016"));
    const again = await send(delayed("NC-1016"));
    expect(again).toEqual({ status: 200, body: { event_id: "evt-delay-NC-1016", status: "duplicate" } });
    expect(api.posts).toBe(1);
    expect(runs(DELAYED_RULE)).toHaveLength(1);
    expect(db.select().from(tickets).all()).toHaveLength(1);
  });

  it("Commerce API down: execution failed with the error, the webhook still answers 200", async () => {
    const api = fakeTickets("down");
    const res = await send(delayed("NC-1016"));
    expect(res).toEqual({ status: 200, body: { event_id: "evt-delay-NC-1016", status: "applied" } });
    expect(api.posts).toBe(1); // no blind retry: the check-first GET failed too
    const [run] = runs(DELAYED_RULE);
    expect(run).toMatchObject({ matched: true, outcome: "failed" });
    expect(run.error).toMatch(/network error.*could not verify whether the ticket exists/);
    expect(db.select().from(tickets).all()).toHaveLength(0);
  });

  it("a lost reply is not retried blindly: the ticket found upstream is adopted, POST runs once", async () => {
    const api = fakeTickets("lostReply");
    await send(delayed("NC-1016"));
    expect(api.posts).toBe(1);
    expect(api.rows).toHaveLength(1);
    expect(runs(DELAYED_RULE)[0]).toMatchObject({ outcome: "succeeded", result: JSON.stringify({ ticketId: "T-1" }) });
    expect(db.select().from(tickets).all()).toHaveLength(1);
  });

  it("a disabled workflow does not run", async () => {
    const api = fakeTickets();
    expect((await call(patchRoute, { as: MANAGER, method: "PATCH", id: wf(DELAYED_RULE).id, body: { enabled: false } })).status).toBe(200);
    await send(delayed("NC-1016"));
    expect(api.posts).toBe(0);
    expect(runs(DELAYED_RULE)).toHaveLength(0);
  });
});

// ---------- request_refund ----------

describe("Refund cancelled paid orders -> request_refund", () => {
  const refundOps = (orderId: string) => db.select().from(operations).where(eq(operations.orderId, orderId)).all().filter((o) => o.type === "refund");

  it("evt-003 creates a pending approval for NC-1004, not a refund", async () => {
    const payments = countRefundPosts();
    await send(EVT_003);
    const [op] = refundOps("NC-1004");
    expect(op).toMatchObject({ status: "pending_approval", amountMinor: 250000, requestedByUserId: null, requestedByLabel: `workflow:${REFUND_RULE}` });
    expect(db.select().from(approvals).where(eq(approvals.operationId, op.id)).get()).toMatchObject({ status: "pending", requestedByUserId: null });
    expect(runs(REFUND_RULE)[0]).toMatchObject({ matched: true, outcome: "succeeded" });
    expect(payments.posts).toBe(0);
  });

  it("an in-app cancel of NC-1005 creates a pending approval", async () => {
    server.use(
      http.post(`${BASE}/commerce/orders/:id/cancel`, ({ params }) =>
        HttpResponse.json({ ...businessData.orders.find((o) => o.id === params.id), status: "cancelled" }),
      ),
    );
    const payments = countRefundPosts();
    expect((await call(cancelRoute, { as: OPERATOR, id: "NC-1005" })).status).toBe(200);
    expect(refundOps("NC-1005")).toEqual([expect.objectContaining({ status: "pending_approval", amountMinor: 287500, requestedByLabel: `workflow:${REFUND_RULE}` })]);
    expect(payments.posts).toBe(0);
  });

  it("over the limit: an open full request already exists, so the run fails with the reason", async () => {
    db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, "NC-1004")).run();
    expect(requestRefund("NC-1004", undefined, { userId: null, label: "test", role: null }).ok).toBe(true);
    await send(EVT_003);
    expect(refundOps("NC-1004")).toHaveLength(1);
    expect(runs(REFUND_RULE)[0]).toMatchObject({ matched: true, outcome: "failed", error: "nothing left to refund" });
  });
});

// ---------- API ----------

const valid = {
  name: "Failed payment ticket",
  trigger: "payment.failed",
  conditions: [{ field: "payment_status", op: "eq", value: "failed" }],
  action: { type: "create_ticket", reason: "Payment failed for {order_id}" },
};

describe("workflow API", () => {
  it("only a Manager may create or edit (Operator/Viewer = 403, nothing changes)", async () => {
    const id = wf(DELAYED_RULE).id;
    expect((await call(patchRoute, { as: OPERATOR, method: "PATCH", id, body: { enabled: false } })).status).toBe(403);
    expect((await call(createRoute, { as: VIEWER, body: valid })).status).toBe(403);
    expect(wf(DELAYED_RULE).enabled).toBe(true);

    const created = await call(createRoute, { as: MANAGER, body: valid });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...valid, enabled: true });
    const list = await call((req) => listRoute(req), { as: VIEWER, method: "GET" });
    expect(list.body.items.map((w: { name: string }) => w.name)).toEqual([DELAYED_RULE, REFUND_RULE, valid.name]);
  });

  it("edits merge with the stored workflow; executions are listed per workflow", async () => {
    fakeTickets();
    const id = wf(DELAYED_RULE).id;
    const res = await call(patchRoute, { as: MANAGER, method: "PATCH", id, body: { conditions: [{ field: "amount_minor", op: "gte", value: 325000 }] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: DELAYED_RULE, action: { type: "create_ticket" } });
    await send(delayed("NC-1006"));
    const execs = await call(executionsRoute, { as: VIEWER, method: "GET", id });
    expect(execs.body.items).toEqual([expect.objectContaining({ orderId: "NC-1006", outcome: "succeeded" })]);
  });

  it.each([
    ["unknown field", { conditions: [{ field: "colour", op: "eq", value: "red" }] }],
    ["gt on a status", { conditions: [{ field: "payment_status", op: "gt", value: "captured" }] }],
    ["unknown status value", { conditions: [{ field: "shipment_status", op: "eq", value: "lost" }] }],
    ["non-integer amount", { conditions: [{ field: "amount_minor", op: "gt", value: 5000.5 }] }],
    ["no conditions", { conditions: [] }],
    ["unknown trigger", { trigger: "order.created" }],
    ["unknown placeholder", { action: { type: "create_ticket", reason: "Hi {customer}" } }],
    ["zero refund amount", { action: { type: "request_refund", amount_minor: 0 } }],
  ])("rejects %s with 400, on create and on edit", async (_label, change) => {
    const before = db.select().from(workflows).all();
    expect((await call(createRoute, { as: MANAGER, body: { ...valid, ...change } })).status).toBe(400);
    expect((await call(patchRoute, { as: MANAGER, method: "PATCH", id: wf(DELAYED_RULE).id, body: change })).status).toBe(400);
    expect(db.select().from(workflows).all()).toEqual(before);
  });

  it("a duplicate name = 409", async () => {
    expect((await call(createRoute, { as: MANAGER, body: { ...valid, name: DELAYED_RULE } })).status).toBe(409);
  });
});
