import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as assistantRoute } from "@/app/api/assistant/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { approvals, auditLog, operations, orders, shipments, users } from "@/server/db/schema";
import { syncAll } from "@/server/services/sync";
import { clearData, setupTestDb } from "./helpers/db";
import { server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));

let db: Db;
beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" }); // any Payment API call from the assistant would fail the test
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(async () => {
  clearData();
  await syncAll();
});

async function ask(text: string, as: string | null = "operator@nova.test") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (as) {
    const user = db.select().from(users).where(eq(users.email, as)).get()!;
    headers.cookie = (await createSessionCookie(user.id)).split(";")[0];
  }
  const res = await assistantRoute(new Request("http://localhost/api/assistant", { method: "POST", headers, body: JSON.stringify({ text }) }));
  return { status: res.status, body: await res.json() };
}
const refundOps = (orderId: string) => db.select().from(operations).where(eq(operations.orderId, orderId)).all();
const textOf = (body: { title: string; items: { text: string }[] }) => [body.title, ...body.items.map((i) => i.text)].join("\n");

describe("assistant: access", () => {
  it("needs a login (401)", async () => {
    expect((await ask("money at risk", null)).status).toBe(401);
  });
  it("rejects an empty question (400)", async () => {
    expect((await ask("   ")).status).toBe(400);
  });
});

describe("assistant: refund requests", () => {
  it("refuses a Viewer (403), creates nothing, audits the attempt", async () => {
    const r = await ask("request a refund for order NC-1002", "viewer@nova.test");
    expect(r.status).toBe(403);
    expect(refundOps("NC-1002")).toHaveLength(0);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "refund.request")).all()[0]).toMatchObject({ outcome: "forbidden", role: "viewer" });
  });

  it("refuses NC-1005 (processing) with the reason and creates nothing", async () => {
    const r = await ask("request a refund for order NC-1005");
    expect(r.status).toBe(409);
    expect(r.body.title).toContain("order is processing, not cancelled or delivered");
    expect(refundOps("NC-1005")).toHaveLength(0);
  });

  it("NC-1002 creates a pending approval through requestRefund, no Payment API call", async () => {
    const r = await ask("request a refund for order NC-1002");
    expect(r.status).toBe(200);
    const [op] = refundOps("NC-1002");
    expect(op).toMatchObject({ type: "refund", status: "pending_approval", amountMinor: 175000, requestedByLabel: "operator@nova.test" });
    expect(db.select().from(approvals).where(eq(approvals.operationId, op.id)).get()).toMatchObject({ status: "pending" });
    // and it now shows in the pending list
    expect(textOf((await ask("refunds waiting for approval")).body)).toContain("NC-1002");
  });

  it("a second request for the same order is refused (amount already reserved)", async () => {
    await ask("request a refund for order NC-1002");
    expect((await ask("refund NC-1002")).status).toBe(409);
    expect(refundOps("NC-1002")).toHaveLength(1);
  });

  it("an unknown order id gives a clear 404 message", async () => {
    const r = await ask("request a refund for order NC-9999");
    expect(r.status).toBe(404);
    expect(r.body.title).toContain("can't find order NC-9999");
  });
});

describe("assistant: investigate", () => {
  it("NC-1004 after evt-003 (cancelled by webhook, upstream processing) shows local ahead and the next step", async () => {
    db.update(orders).set({ status: "cancelled", localEventAt: "2026-11-22T10:10:00Z" }).where(eq(orders.id, "NC-1004")).run();
    const r = await ask("investigate order NC-1004");
    expect(r.status).toBe(200);
    const text = textOf(r.body);
    expect(text).toContain("LOCAL AHEAD: order is cancelled locally but processing upstream");
    expect(text).toContain("Next: push the cancel upstream");
    expect(r.body.items.some((i: { href?: string }) => i.href === "/orders/NC-1004")).toBe(true);
  });

  it("a normal order says local data agrees; an order id alone also investigates", async () => {
    expect(textOf((await ask("NC-1002")).body)).toContain("Local data agrees with upstream.");
  });

  it("an unknown order id gives a clear 404 message", async () => {
    const r = await ask("investigate order NC-9999");
    expect(r.status).toBe(404);
    expect(r.body.title).toContain("can't find order NC-9999");
  });
});

describe("assistant: lists", () => {
  it("delayed shipments lists the delayed ones with links", async () => {
    const before = (await ask("show delayed shipments")).body.items.length;
    db.update(shipments).set({ status: "delayed" }).where(eq(shipments.orderId, "NC-1004")).run();
    const r = await ask("show delayed shipments");
    expect(r.body.items.length).toBe(before + 1);
    expect(r.body.items.map((i: { href?: string }) => i.href)).toContain("/orders/NC-1004");
  });

  it("money at risk shows both lists with the CLAUDE.md totals (11 owed ₹1,37,750; 4 unpaid ₹51,250)", async () => {
    const text = textOf((await ask("money at risk")).body);
    expect(text).toContain("Owed refunds: 11 cancelled orders, ₹1,37,750.00");
    expect(text).toContain("Unpaid: 4 shipped or delivered orders with a failed payment, ₹51,250.00");
  });

  it("unknown text says what it can do", async () => {
    const r = await ask("what is the weather");
    expect(r.status).toBe(200);
    expect(r.body.intent).toBe("help");
    expect(textOf(r.body)).toContain("investigate order NC-1004");
  });
});
