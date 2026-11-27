// Tickets by hand, customer view, team work queues.
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as customerRoute } from "@/app/api/customers/[id]/route";
import { GET as customersRoute } from "@/app/api/customers/route";
import { GET as orderRoute } from "@/app/api/orders/[id]/route";
import { POST as ticketRoute } from "@/app/api/orders/[id]/tickets/route";
import { GET as queuesRoute } from "@/app/api/queues/route";
import { GET as ticketsRoute } from "@/app/api/tickets/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { auditLog, refunds, tickets, users } from "@/server/db/schema";
import type { getQueues } from "@/server/services/queues";
import { syncAll } from "@/server/services/sync";
import { clearData, setupTestDb } from "./helpers/db";
import { BASE, server } from "./helpers/mock-server";

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
});

async function cookieFor(email: string) {
  const user = db.select().from(users).where(eq(users.email, email)).get()!;
  return (await createSessionCookie(user.id)).split(";")[0];
}
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(handler: Handler, opts: { as: string; url?: string; id?: string; body?: unknown }) {
  const req = new Request(`http://localhost${opts.url ?? "/"}`, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", cookie: await cookieFor(opts.as) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve({ id: opts.id ?? "" }) });
  return { status: res.status, body: await res.json() };
}

// Fake Commerce tickets API (same shape as the workflow tests).
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
const REASON = { reason: "Payment failed after shipping; collect payment" };
const createTicket = (as: string, id = "NC-1021", body: unknown = REASON) => call(ticketRoute as Handler, { as, id, body });

describe("Create support ticket (POST /api/orders/[id]/tickets)", () => {
  it("operator creates a ticket: upstream POST once, saved locally, audited, listed", async () => {
    const api = fakeTickets();
    const res = await createTicket("operator@nova.test");
    expect(res).toEqual({ status: 201, body: { ok: true, ticketId: "T-1", how: "created" } });
    expect(api.posts).toBe(1);
    expect(db.select().from(tickets).where(eq(tickets.id, "T-1")).get()).toMatchObject({ orderId: "NC-1021", createdByLabel: "operator@nova.test", workflowExecutionId: null });
    expect(db.select().from(auditLog).where(eq(auditLog.action, "ticket.create")).all()).toEqual([
      expect.objectContaining({ actorLabel: "operator@nova.test", role: "operator", target: "NC-1021", outcome: "succeeded" }),
    ]);
    const list = await call(ticketsRoute as Handler, { as: "viewer@nova.test", url: "/api/tickets?orderId=NC-1021" });
    expect(list.body.items).toEqual([expect.objectContaining({ id: "T-1", customerId: "C-001", fromWorkflow: false })]);
  });

  it("viewer gets 403 and nothing is called; no login is 401", async () => {
    const api = fakeTickets();
    expect((await createTicket("viewer@nova.test")).status).toBe(403);
    const anon = await ticketRoute(new Request("http://localhost/", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "NC-1021" }) });
    expect(anon.status).toBe(401);
    expect(api.posts).toBe(0);
  });

  it("reason is required; unknown order is 404", async () => {
    fakeTickets();
    expect((await createTicket("operator@nova.test", "NC-1021", { reason: "   " })).status).toBe(400);
    expect((await createTicket("operator@nova.test", "NC-9999")).status).toBe(404);
  });

  it("Commerce down: 502 with a clear error, nothing saved, failure audited", async () => {
    fakeTickets("down");
    const res = await createTicket("manager@nova.test");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^Commerce API is unreachable; could not verify whether the ticket exists/);
    expect(db.select().from(tickets).all()).toHaveLength(0);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "ticket.create")).get()).toMatchObject({ outcome: "failed" });
  }, 10_000);

  it("a lost reply is not retried blindly: the upstream ticket is adopted, one POST, one ticket", async () => {
    const api = fakeTickets("lostReply");
    const res = await createTicket("operator@nova.test");
    expect(res.body).toEqual({ ok: true, ticketId: "T-1", how: "adopted after a lost reply" });
    expect(api.posts).toBe(1);
    expect(db.select().from(tickets).all()).toHaveLength(1);
  });

  it("the order page offers createTicket from the server", async () => {
    server.use(http.get(`${BASE}/shipping/shipments/:id`, () => HttpResponse.json({ error: "x" }, { status: 404 })));
    const res = await call(orderRoute as Handler, { as: "viewer@nova.test", id: "NC-1021" });
    expect(res.body.actions.createTicket).toEqual({ allowed: true, reason: null });
  });
});

describe("Customers", () => {
  it("search finds by name or email", async () => {
    const all = await call(customersRoute as Handler, { as: "viewer@nova.test", url: "/api/customers" });
    expect(all.body.items).toHaveLength(10);
    const c8 = all.body.items.find((c: { id: string }) => c.id === "C-008");
    const hit = await call(customersRoute as Handler, { as: "viewer@nova.test", url: `/api/customers?q=${encodeURIComponent(c8.email)}` });
    expect(hit.body.items.map((c: { id: string }) => c.id)).toEqual(["C-008"]);
  });

  it("C-008: 6 orders, spent and money at risk match the data; a refund and a ticket show up", async () => {
    // C-008 = NC-1008/1018/1038/1048/1058 cancelled + captured (owed), NC-1028 cancelled + failed.
    const captured = 400000 + 775000 + 1525000 + 1900000 + 2275000; // 68,750.00
    let d = (await call(customerRoute as Handler, { as: "viewer@nova.test", id: "C-008" })).body;
    expect(d.orders).toHaveLength(6);
    expect(d.spentMinor).toBe(captured);
    expect(d.moneyAtRisk).toMatchObject({ owedMinor: captured, unpaidMinor: 0, totalMinor: captured });
    expect(d.moneyAtRisk.owed).toHaveLength(5);

    db.insert(refunds).values({ id: "R-1", orderId: "NC-1008", amountMinor: 400000, currency: "INR", status: "succeeded" }).run();
    db.insert(tickets).values({ id: "T-9", orderId: "NC-1018", reason: "x", status: "open" }).run();
    d = (await call(customerRoute as Handler, { as: "viewer@nova.test", id: "C-008" })).body;
    expect(d.spentMinor).toBe(captured - 400000);
    expect(d.moneyAtRisk.owedMinor).toBe(captured - 400000);
    expect(d.openTickets.map((t: { id: string }) => t.id)).toEqual(["T-9"]);
  });

  it("unknown customer is 404", async () => {
    expect((await call(customerRoute as Handler, { as: "viewer@nova.test", id: "C-999" })).status).toBe(404);
  });
});

describe("Work queues on the sample data", () => {
  const queues = async () => (await call(queuesRoute as Handler, { as: "viewer@nova.test" })).body as ReturnType<typeof getQueues>;
  const kinds = (items: { kind: string }[]) => items.reduce<Record<string, number>>((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {});

  it("counts per tab and per kind", async () => {
    const q = await queues();
    expect(kinds(q.finance.items)).toEqual({ owed_refund: 11, unpaid_shipped: 4 });
    expect(q.finance.count).toBe(15);
    expect(kinds(q.operations.items)).toEqual({ delayed_shipment: 6 });
    expect(q.operations.count).toBe(6);
    // 11 owed + 4 unpaid + 6 delayed = 21 problem rows over 20 distinct orders (NC-1056 is unpaid and delayed); no tickets yet.
    expect(kinds(q.support.items)).toEqual({ customer_problem: 20 });
    expect(q.support.count).toBe(20);
    expect(q.finance.items.filter((i) => i.canCreateTicket)).toHaveLength(4);
  });

  it("an open ticket moves an unpaid order to 'waiting' and adds a support item", async () => {
    fakeTickets();
    await createTicket("operator@nova.test", "NC-1021");
    const q = await queues();
    const unpaid = q.finance.items.find((i) => i.key === "unpaid-NC-1021")!;
    expect(unpaid).toMatchObject({ canCreateTicket: false, nextAction: "Ticket open; waiting for payment", customerId: "C-001" });
    expect(q.finance.count).toBe(15); // stays on the list until upstream shows it paid
    expect(kinds(q.support.items).open_ticket).toBe(1);
  });
});
