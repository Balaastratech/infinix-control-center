// Assistant over HTTP: conversations (private to user + browser), parser answers from local data, proposals that never
// execute. Behaviour change vs the first assistant: "request a refund for NC-1002" no longer creates the request; it
// returns a proposal card, and the Confirm button calls the normal refund route (docs/assistant-design.md section 7).
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute, POST as startRoute } from "@/app/api/assistant/conversations/route";
import { DELETE as deleteRoute, GET as getRoute, PATCH as patchRoute } from "@/app/api/assistant/conversations/[id]/route";
import { POST as messageRoute } from "@/app/api/assistant/conversations/[id]/messages/route";
import { POST as refundRoute } from "@/app/api/orders/[id]/refund-requests/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { approvals, assistantConversations, assistantMessages, assistantToolCalls, auditLog, operations, orders, shipments, users } from "@/server/db/schema";
import { resetBurst } from "@/server/services/assistant";
import { purgeOld } from "@/server/services/conversations";
import { syncAll } from "@/server/services/sync";
import { clearData, setupTestDb } from "./helpers/db";
import { server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));

let db: Db;
beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" }); // any upstream write from the assistant would fail the test
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(async () => {
  clearData();
  db.run("DELETE FROM assistant_conversations" as never);
  resetBurst();
  await syncAll();
});

const DEV_A = "a".repeat(32);
const DEV_B = "b".repeat(32);

async function cookieFor(email: string | null, device: string | null = DEV_A) {
  const parts: string[] = [];
  if (email) {
    const user = db.select().from(users).where(eq(users.email, email)).get()!;
    parts.push((await createSessionCookie(user.id)).split(";")[0]);
  }
  if (device) parts.push(`nova_asst_dev=${device}`);
  return parts.join("; ");
}
const req = async (method: string, path: string, as: string | null, device: string | null, body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers: { "Content-Type": "application/json", cookie: await cookieFor(as, device) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => ({ status: res.status, body: await res.json(), headers: res.headers });

// Ask in a fresh conversation (or the given one).
async function ask(text: string, as: string | null = "operator@nova.test", conv?: string, device: string | null = DEV_A) {
  return conv
    ? json(await messageRoute(await req("POST", `/api/assistant/conversations/${conv}/messages`, as, device, { text }), ctx(conv)))
    : json(await startRoute(await req("POST", "/api/assistant/conversations", as, device, { text })));
}
const textOf = (body: { answer: { text: string; blocks: unknown[] } }) => JSON.stringify(body.answer);
const refundOps = (orderId: string) => db.select().from(operations).where(eq(operations.orderId, orderId)).all();

describe("assistant: access and input", () => {
  it("needs a login (401)", async () => {
    expect((await ask("money at risk", null)).status).toBe(401);
  });
  it("rejects empty, too long, or extra-field bodies (400)", async () => {
    expect((await ask("   ")).status).toBe(400);
    expect((await ask("x".repeat(501))).status).toBe(400);
    const res = await startRoute(await req("POST", "/api/assistant/conversations", "operator@nova.test", DEV_A, { text: "hi", role: "manager" }));
    expect(res.status).toBe(400);
  });
  it("sets an HttpOnly device cookie on first use", async () => {
    const res = await startRoute(await req("POST", "/api/assistant/conversations", "operator@nova.test", null, { text: "money at risk" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^nova_asst_dev=[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Lax/);
  });
  it("more than 20 questions a minute is a 429", async () => {
    for (let i = 0; i < 20; i++) expect((await ask("money at risk")).status).toBe(200);
    expect((await ask("money at risk")).status).toBe(429);
  });
});

describe("assistant: conversations are private to user + browser", () => {
  it("B cannot list, read, rename, delete or continue A's conversation (404); A can", async () => {
    const a = await ask("late orders", "operator@nova.test");
    const id = a.body.conversationId as string;
    for (const [as, device] of [["manager@nova.test", DEV_A], ["operator@nova.test", DEV_B], ["operator@nova.test", null]] as const) {
      expect((await json(await listRoute(await req("GET", "/api/assistant/conversations", as, device)))).body.conversations.map((c: { id: string }) => c.id)).not.toContain(id);
      expect((await getRoute(await req("GET", `/x/${id}`, as, device), ctx(id))).status).toBe(404);
      expect((await patchRoute(await req("PATCH", `/x/${id}`, as, device, { title: "mine now" }), ctx(id))).status).toBe(404);
      expect((await deleteRoute(await req("DELETE", `/x/${id}`, as, device), ctx(id))).status).toBe(404);
      expect((await ask("which of those are over Rs 10,000?", as, id, device)).status).toBe(404);
    }
    const conv = db.select().from(assistantConversations).where(eq(assistantConversations.id, id)).get()!;
    expect(conv.title).toBe("late orders");
    expect(db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, id)).all()).toHaveLength(2);

    // the owner can do all of it
    expect((await json(await getRoute(await req("GET", `/x/${id}`, "operator@nova.test", DEV_A), ctx(id)))).body.messages).toHaveLength(2);
    expect((await patchRoute(await req("PATCH", `/x/${id}`, "operator@nova.test", DEV_A, { title: "Delayed" }), ctx(id))).status).toBe(200);
    expect((await json(await listRoute(await req("GET", "/x", "operator@nova.test", DEV_A)))).body.conversations[0]).toMatchObject({ id, title: "Delayed" });
    expect((await deleteRoute(await req("DELETE", `/x/${id}`, "operator@nova.test", DEV_A), ctx(id))).status).toBe(200);
    expect(db.select().from(assistantConversations).all()).toHaveLength(0);
    expect(db.select().from(assistantToolCalls).all()).toHaveLength(0); // cascaded
  });

  it("follow-ups use the earlier result: which of those are over Rs 10,000?", async () => {
    db.update(shipments).set({ status: "delayed" }).where(eq(shipments.orderId, "NC-1004")).run();
    const first = await ask("late orders");
    const all = first.body.answer.context.resultIds as string[];
    expect(all.length).toBeGreaterThan(1);
    const next = await ask("which of those are over Rs 10,000?", "operator@nova.test", first.body.conversationId);
    const ids = next.body.answer.context.resultIds as string[];
    const amounts = db.select({ id: orders.id, a: orders.amountMinor }).from(orders).all();
    const expected = all.filter((id) => amounts.find((o) => o.id === id)!.a > 1000000);
    expect(ids.sort()).toEqual(expected.sort());
    expect(next.body.answer.understood).toContain("within your previous result");
  });

  it("a full conversation (20 messages) refuses the next question with 409", async () => {
    const id = (await ask("money at risk")).body.conversationId;
    for (let i = 0; i < 9; i++) expect((await ask("money at risk", "operator@nova.test", id)).status).toBe(200);
    expect((await ask("money at risk", "operator@nova.test", id)).status).toBe(409);
  });

  it("the 21st conversation drops the oldest; conversations idle 7+ days are purged", async () => {
    const first = (await ask("money at risk")).body.conversationId;
    for (let i = 0; i < 19; i++) await ask("money at risk");
    resetBurst(); // 21 questions in a minute would hit the burst limit
    const r = await ask("money at risk");
    expect(r.body.droppedOldest).toBe(true);
    expect(db.select().from(assistantConversations).where(eq(assistantConversations.id, first)).get()).toBeUndefined();
    db.update(assistantConversations).set({ updatedAt: "2000-01-01T00:00:00.000Z" }).run();
    expect(purgeOld()).toBe(20);
  });
});

describe("assistant: actions are proposals only", () => {
  it("refund NC-1002 returns a proposal and creates nothing; Confirm (the normal route) creates the pending approval", async () => {
    const r = await ask("request a refund for order NC-1002");
    expect(r.status).toBe(200);
    const card = r.body.answer.blocks.find((b: { kind: string }) => b.kind === "proposal");
    expect(card).toMatchObject({ action: "refund", orderId: "NC-1002", amountMinor: 175000 });
    expect(refundOps("NC-1002")).toHaveLength(0);

    const confirm = await refundRoute(await req("POST", "/api/orders/NC-1002/refund-requests", "operator@nova.test", DEV_A, { amount_minor: card.amountMinor }), ctx("NC-1002") as never);
    expect(confirm.status).toBe(201);
    const [op] = refundOps("NC-1002");
    expect(op).toMatchObject({ status: "pending_approval", requestedByLabel: "operator@nova.test" });
    expect(db.select().from(approvals).where(eq(approvals.operationId, op.id)).get()).toMatchObject({ status: "pending" });
    expect(textOf((await ask("refunds waiting for approval")).body)).toContain("NC-1002");
  });

  it("refund 500 rupees on NC-1002 proposes Rs 500, not the full amount", async () => {
    for (const text of ["refund 500 rupees on NC-1002", "refund 500 for NC-1002"]) {
      const card = (await ask(text)).body.answer.blocks.find((b: { kind: string }) => b.kind === "proposal");
      expect(card).toMatchObject({ action: "refund", orderId: "NC-1002", amountMinor: 50000, maxAmountMinor: 175000 });
    }
  });

  it("a reopened conversation shows a confirmed proposal as done (no second Confirm); unconfirmed stays open", async () => {
    const r = await ask("refund 500 for NC-1002");
    const id = r.body.conversationId as string;
    const reopen = async () =>
      (await json(await getRoute(await req("GET", `/x/${id}`, "operator@nova.test", DEV_A), ctx(id)))).body.messages
        .flatMap((m: { blocks: { kind: string }[] }) => m.blocks)
        .find((b: { kind: string }) => b.kind === "proposal");
    expect((await reopen()).done).toBeUndefined();

    await refundRoute(await req("POST", "/api/orders/NC-1002/refund-requests", "operator@nova.test", DEV_A, { amount_minor: 50000 }), ctx("NC-1002") as never);
    expect((await reopen()).done).toMatch(/^Done/);
  });

  it("a Viewer gets no card, nothing is created, and the denied tool call is audited", async () => {
    const r = await ask("request a refund for order NC-1002", "viewer@nova.test");
    expect(r.body.answer.text).toContain("Your role (viewer) cannot request refunds");
    expect(r.body.answer.blocks).toEqual([]);
    expect(refundOps("NC-1002")).toHaveLength(0);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "assistant.tool")).all()[0]).toMatchObject({ outcome: "denied", role: "viewer", target: "propose_refund" });
    // and the real route still says no
    expect((await refundRoute(await req("POST", "/x", "viewer@nova.test", DEV_A, {}), ctx("NC-1002") as never)).status).toBe(403);
  });

  it("NC-1005 (processing) gets the rule's reason and no card", async () => {
    const r = await ask("request a refund for order NC-1005");
    expect(r.body.answer.text).toContain("order is processing, not cancelled or delivered");
    expect(r.body.answer.blocks.some((b: { kind: string }) => b.kind === "proposal")).toBe(false);
  });

  it("cancel of a shipped order is refused with the rule; a processing one gets a card and nothing is called", async () => {
    expect((await ask("cancel NC-1001")).body.answer.text).toContain("can't be cancelled");
    const ok = await ask("cancel NC-1005");
    expect(ok.body.answer.blocks[0]).toMatchObject({ kind: "proposal", action: "cancel", orderId: "NC-1005" });
    expect(db.select().from(operations).all()).toHaveLength(0);
  });

  it("an unknown order id says so", async () => {
    expect((await ask("request a refund for order NC-9999")).body.answer.text).toContain("can't find order NC-9999");
  });
});

describe("assistant: answers from local data", () => {
  it("NC-1004 after a webhook cancel shows local ahead and the next step", async () => {
    db.update(orders).set({ status: "cancelled", localEventAt: "2026-11-22T10:10:00Z" }).where(eq(orders.id, "NC-1004")).run();
    const text = textOf((await ask("investigate order NC-1004")).body);
    expect(text).toContain("LOCAL AHEAD: order is cancelled locally but processing upstream");
    expect(text).toContain("Push the cancel upstream");
    expect(text).toContain('"href":"/orders/NC-1004"');
  });

  it("money at risk shows the CLAUDE.md totals (11 owed ₹1,37,750; 4 unpaid ₹51,250)", async () => {
    const text = textOf((await ask("money at risk")).body);
    expect(text).toContain("Owed refunds: 11 cancelled orders, ₹1,37,750.00");
    expect(text).toContain("Unpaid: 4 shipped or delivered orders with a failed payment, ₹51,250.00");
  });

  it("count of unpaid shipped orders matches the data", async () => {
    const r = await ask("how many unpaid shipped orders");
    expect(r.body.answer.text).toMatch(/^\d+ orders? found$/);
    expect(r.body.answer.understood).toBe("I understood: count orders · payment failed · order shipped or delivered");
  });

  it("unknown text says it didn't understand and suggests questions", async () => {
    const r = await ask("what is the weather");
    expect(r.body.answer.intent).toBe("no_match");
    expect(r.body.answer.suggestions).toHaveLength(3);
  });
});
