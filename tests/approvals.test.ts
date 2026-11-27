import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as approvalsRoute } from "@/app/api/approvals/route";
import { POST as approveRoute } from "@/app/api/approvals/[id]/approve/route";
import { POST as rejectRoute } from "@/app/api/approvals/[id]/reject/route";
import { POST as retryRoute } from "@/app/api/approvals/[id]/retry/route";
import { GET as auditRoute } from "@/app/api/audit/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { POST as refundRoute } from "@/app/api/orders/[id]/refund-requests/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { approvals, auditLog, operations, orders, refunds, users } from "@/server/db/schema";
import { requestRefund } from "@/server/services/refunds";
import { syncAll } from "@/server/services/sync";
import { clearData, setupTestDb } from "./helpers/db";
import { BASE, businessData, server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));

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

const OPERATOR = "operator@nova.test";
const MANAGER = "manager@nova.test";
const MANAGER2 = "manager2@nova.test";
const VIEWER = "viewer@nova.test";

async function cookieFor(email: string): Promise<string> {
  const user = db.select().from(users).where(eq(users.email, email)).get()!;
  return (await createSessionCookie(user.id)).split(";")[0];
}
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(handler: Handler, url: string, opts: { id?: string; method?: string; body?: unknown; as: string }) {
  const req = new Request(`http://localhost${url}`, {
    method: opts.method ?? "POST",
    headers: { "Content-Type": "application/json", cookie: await cookieFor(opts.as) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve({ id: opts.id ?? "" }) });
  return { status: res.status, body: await res.json() };
}
const requestAs = async (as: string, orderId: string, amount?: number) =>
  (await call(refundRoute, `/api/orders/${orderId}/refund-requests`, { id: orderId, as, body: amount ? { amount_minor: amount } : {} })).body
    .approvalId as number;
const approve = (id: number, as: string) => call(approveRoute, `/api/approvals/${id}/approve`, { id: String(id), as });
const reject = (id: number, as: string, body: unknown = { note: "no" }) => call(rejectRoute, `/api/approvals/${id}/reject`, { id: String(id), as, body });
const retry = (id: number, as: string) => call(retryRoute, `/api/approvals/${id}/retry`, { id: String(id), as });
const opOf = (approvalId: number) =>
  db.select().from(operations).where(eq(operations.id, db.select().from(approvals).where(eq(approvals.id, approvalId)).get()!.operationId)).get()!;
const approvalRow = (id: number) => db.select().from(approvals).where(eq(approvals.id, id)).get()!;
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action)).all();

// A tiny in-memory Payment API + live order/payment reads. `down` makes every Payment call a network error;
// `postMode` "timeout" processes the refund but never answers (the mock already refunded).
function fakeUpstream() {
  const state = { refunds: [] as Record<string, unknown>[], posts: 0, down: false, postMode: "ok" as "ok" | "timeout" };
  const find = <T extends { id?: string; order_id?: string }>(rows: T[], id: string) => rows.find((r) => (r.order_id ?? r.id) === id);
  server.use(
    http.get(`${BASE}/commerce/orders/:id`, ({ params }) => HttpResponse.json(find(businessData.orders as never[], params.id as string))),
    http.get(`${BASE}/payments/transactions/:id`, ({ params }) =>
      state.down ? HttpResponse.error() : HttpResponse.json(find(businessData.payments as never[], params.id as string)),
    ),
    http.get(`${BASE}/payments/refunds`, () => (state.down ? HttpResponse.error() : HttpResponse.json(state.refunds))),
    http.post(`${BASE}/payments/refunds`, async ({ request }) => {
      state.posts++;
      if (state.down) return HttpResponse.error();
      const body = (await request.json()) as { order_id: string; amount_minor: number };
      const r = {
        id: `R-${state.refunds.length + 1}`,
        order_id: body.order_id,
        amount_minor: body.amount_minor,
        currency: "INR",
        status: body.order_id === "NC-1010" ? "failed" : "succeeded",
      };
      state.refunds.push(r);
      return state.postMode === "timeout" ? HttpResponse.error() : HttpResponse.json(r, { status: 201 });
    }),
  );
  return state;
}

describe("who may decide", () => {
  it("an operator approving or rejecting = 403, nothing changes", async () => {
    const id = await requestAs(OPERATOR, "NC-1002");
    expect((await approve(id, OPERATOR)).status).toBe(403);
    expect((await reject(id, OPERATOR)).status).toBe(403);
    expect(approvalRow(id).status).toBe("pending");
  });

  it("a manager cannot approve or reject their own request (403), and it stays pending", async () => {
    const upstream = fakeUpstream();
    const id = await requestAs(MANAGER, "NC-1002");
    expect((await approve(id, MANAGER)).status).toBe(403);
    expect((await reject(id, MANAGER)).status).toBe(403);
    expect(approvalRow(id).status).toBe("pending");
    expect(upstream.posts).toBe(0);
    expect(audits("refund.approve")[0]).toMatchObject({ actorLabel: MANAGER, outcome: "refused" });
  });

  it("a viewer can list approvals but not decide", async () => {
    await requestAs(OPERATOR, "NC-1002");
    const list = await call(() => approvalsRoute(new Request("http://localhost/api/approvals", { headers: { cookie: "" } })), "/x", { as: VIEWER, method: "GET" });
    expect(list.status).toBe(401); // sanity: the list route needs a session
    const req = new Request("http://localhost/api/approvals", { headers: { cookie: await cookieFor(VIEWER) } });
    const res = await approvalsRoute(req);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
  });
});

describe("approve", () => {
  it("manager2 approves NC-1002: refund succeeds, row saved and linked, audited", async () => {
    const upstream = fakeUpstream();
    const id = await requestAs(OPERATOR, "NC-1002");
    const res = await approve(id, MANAGER2);
    expect(res).toMatchObject({ status: 200, body: { status: "succeeded", externalId: "R-1" } });
    expect(upstream.posts).toBe(1);
    expect(opOf(id)).toMatchObject({ status: "succeeded", externalId: "R-1", error: null });
    expect(approvalRow(id).status).toBe("approved");
    expect(db.select().from(refunds).where(eq(refunds.id, "R-1")).get()).toMatchObject({ status: "succeeded", operationId: opOf(id).id, amountMinor: 175000 });
    expect(audits("refund.approve")[0]).toMatchObject({ actorLabel: MANAGER2, role: "manager", target: "NC-1002", outcome: "approved" });
    expect(audits("refund.execute")[0]).toMatchObject({ actorLabel: MANAGER2, target: "NC-1002", outcome: "succeeded" });
  });

  it("a second approve, or any decision on a decided item = 409, with one upstream refund", async () => {
    const upstream = fakeUpstream();
    const id = await requestAs(OPERATOR, "NC-1002");
    expect((await approve(id, MANAGER)).status).toBe(200);
    expect((await approve(id, MANAGER2)).status).toBe(409);
    expect((await reject(id, MANAGER2)).status).toBe(409);
    expect(upstream.posts).toBe(1);
    expect(upstream.refunds).toHaveLength(1);
  });

  it("two approvals racing: exactly one wins and one refund is sent", async () => {
    const upstream = fakeUpstream();
    const id = await requestAs(OPERATOR, "NC-1002");
    const results = await Promise.all([approve(id, MANAGER), approve(id, MANAGER2)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(upstream.posts).toBe(1);
  });

  it("NC-1010: 201 with status failed ends failed with the reason", async () => {
    fakeUpstream();
    const id = await requestAs(OPERATOR, "NC-1010");
    const res = await approve(id, MANAGER);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(opOf(id)).toMatchObject({ status: "failed", externalId: "R-1" });
    expect(opOf(id).error).toContain("reported refund R-1 as failed");
    expect(db.select().from(refunds).where(eq(refunds.id, "R-1")).get()?.status).toBe("failed");
    expect(audits("refund.execute")[0].outcome).toBe("failed");
  });

  it("NC-1004 cancelled only locally: refused with 'push cancel upstream first', no refund call", async () => {
    const upstream = fakeUpstream();
    db.update(orders).set({ status: "cancelled", localEventAt: "2026-11-22T10:10:00Z" }).where(eq(orders.id, "NC-1004")).run();
    const id = await requestAs(OPERATOR, "NC-1004");
    const res = await approve(id, MANAGER);
    expect(res.body.status).toBe("failed");
    expect(opOf(id).error).toBe("upstream says processing; push cancel upstream first");
    expect(upstream.posts).toBe(0);
  });

  it("a workflow request (no user) can be approved by any manager", async () => {
    const upstream = fakeUpstream();
    const r = requestRefund("NC-1002", undefined, { userId: null, label: "workflow:delayed-high", role: null });
    expect(r.ok).toBe(true);
    const id = (r as { approvalId: number }).approvalId;
    expect((await approve(id, MANAGER)).body.status).toBe("succeeded");
    expect(upstream.posts).toBe(1);
    expect(approvalRow(id).requestedByLabel).toBe("workflow:delayed-high");
  });
});

describe("reject", () => {
  it("needs a note (400), then rejects and keeps the note; no refund call", async () => {
    const upstream = fakeUpstream();
    const id = await requestAs(OPERATOR, "NC-1002");
    expect((await reject(id, MANAGER, {})).status).toBe(400);
    expect((await reject(id, MANAGER, { note: "   " })).status).toBe(400);
    expect((await reject(id, MANAGER, { note: "duplicate request" })).status).toBe(200);
    expect(approvalRow(id)).toMatchObject({ status: "rejected", note: "duplicate request" });
    expect(opOf(id).status).toBe("rejected");
    expect(upstream.posts).toBe(0);
    expect(audits("refund.reject")[0]).toMatchObject({ actorLabel: MANAGER, outcome: "rejected" });
  });
});

describe("Payment API down and safe retry", () => {
  it("down: approved but not sent; the later retry sends exactly one refund", async () => {
    const upstream = fakeUpstream();
    upstream.down = true;
    const id = await requestAs(OPERATOR, "NC-1002");
    const res = await approve(id, MANAGER);
    expect(res.body.status).toBe("approved");
    expect(res.body.error).toContain("use Retry");
    expect(opOf(id).status).toBe("approved");
    expect(upstream.posts).toBe(0);
    const health = ((await (await healthRoute()).json()).services as { service: string; status: string }[]).find((s) => s.service === "payments");
    expect(health?.status).toBe("down");

    upstream.down = false;
    const again = await retry(id, MANAGER2);
    expect(again.body.status).toBe("succeeded");
    expect(upstream.refunds).toHaveLength(1);
    expect(opOf(id)).toMatchObject({ status: "succeeded", error: null });
    expect(audits("refund.retry")[0]).toMatchObject({ actorLabel: MANAGER2, outcome: "succeeded" });
    expect((await retry(id, MANAGER2)).status).toBe(409); // nothing left to retry
  });

  it("timeout after the mock already refunded: retry adopts that refund, no second one", async () => {
    const upstream = fakeUpstream();
    upstream.postMode = "timeout";
    const id = await requestAs(OPERATOR, "NC-1002");
    const first = await approve(id, MANAGER);
    expect(first.body.status).toBe("approved");
    expect(upstream.posts).toBe(1); // the POST itself is never retried blindly
    expect(upstream.refunds).toHaveLength(1);

    const again = await retry(id, MANAGER2);
    expect(again.body).toMatchObject({ status: "succeeded", externalId: "R-1" });
    expect(upstream.posts).toBe(1);
    expect(upstream.refunds).toHaveLength(1);
    expect(db.select().from(refunds).where(eq(refunds.id, "R-1")).get()?.operationId).toBe(opOf(id).id);
  });

  it("retry does not adopt a refund that belongs to another request", async () => {
    const upstream = fakeUpstream();
    const first = await requestAs(OPERATOR, "NC-1002", 50000);
    expect((await approve(first, MANAGER)).body.status).toBe("succeeded"); // R-1, 500.00
    const second = await requestAs(OPERATOR, "NC-1002", 50000);
    upstream.down = true;
    expect((await approve(second, MANAGER)).body.status).toBe("approved");
    upstream.down = false;
    const again = await retry(second, MANAGER2);
    expect(again.body).toMatchObject({ status: "succeeded", externalId: "R-2" });
    expect(upstream.refunds).toHaveLength(2);
  });

  it("a failed refund can be retried; the retry re-checks upstream first", async () => {
    const upstream = fakeUpstream();
    db.update(orders).set({ status: "cancelled", localEventAt: "2026-11-22T10:10:00Z" }).where(eq(orders.id, "NC-1004")).run();
    const id = await requestAs(OPERATOR, "NC-1004");
    expect((await approve(id, MANAGER)).body.status).toBe("failed");
    expect((await retry(id, MANAGER)).body.status).toBe("failed"); // upstream still says processing
    expect(upstream.posts).toBe(0);
  });
});

describe("audit log", () => {
  it("lists newest first and filters by action and by user", async () => {
    fakeUpstream();
    const id = await requestAs(OPERATOR, "NC-1002");
    await approve(id, MANAGER);
    const get = async (qs: string, as = VIEWER) => {
      const res = await auditRoute(new Request(`http://localhost/api/audit${qs}`, { headers: { cookie: await cookieFor(as) } }));
      return { status: res.status, body: await res.json() };
    };
    const all = await get("");
    expect(all.status).toBe(200);
    expect(all.body.items[0].id).toBeGreaterThan(all.body.items[1].id);
    expect(all.body.actions).toEqual(expect.arrayContaining(["refund.request", "refund.approve", "refund.execute"]));
    const byAction = await get("?action=refund.approve");
    expect(byAction.body.items.every((e: { action: string }) => e.action === "refund.approve")).toBe(true);
    expect(byAction.body.total).toBe(1);
    const byUser = await get(`?user=${OPERATOR}`);
    expect(byUser.body.items.every((e: { actorLabel: string }) => e.actorLabel === OPERATOR)).toBe(true);
    expect(byUser.body.total).toBeGreaterThan(0);
    expect((await get("?page=0")).status).toBe(400);
  });
});
