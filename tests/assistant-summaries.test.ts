// Plain-language answers: every tool's headline is a sentence built from the same rows as its tables. These tests check
// the numbers in the sentence against the data (the CLAUDE.md sample: 11 owed = Rs 1,37,750; 4 unpaid = Rs 51,250).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as resumeRoute } from "@/app/api/assistant/resume/route";
import { createSessionCookie } from "@/server/auth/session";
import type { AuthUser } from "@/server/auth/require-role";
import type { Db } from "@/server/db";
import { assistantAiState, auditLog, operations, orders, shipments, users } from "@/server/db/schema";
import { recordAiFailure } from "@/server/services/assistant-breaker";
import { runTool } from "@/server/services/assistant-tools";
import { briefingText, collectIssues } from "@/server/services/briefing";
import { recordHealth } from "@/server/services/health";
import { syncAll } from "@/server/services/sync";
import { clearData, setupTestDb } from "./helpers/db";
import { server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));

let db: Db;
let viewer: AuthUser;
beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" });
  viewer = db.select().from(users).where(eq(users.email, "viewer@nova.test")).get()! as AuthUser;
});
afterAll(() => server.close());
beforeEach(async () => {
  clearData();
  db.run("DELETE FROM assistant_ai_state" as never);
  await syncAll();
});

const say = (tool: string, input: Record<string, unknown> = {}) => runTool(tool, input, viewer).title;
const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

describe("plain-language summaries match the data", () => {
  it("money at risk: owed and unpaid totals, and the biggest order", () => {
    expect(say("money_at_risk")).toBe(
      "11 cancelled orders still hold ₹1,37,750.00 that hasn't been refunded, and 4 shipped or delivered orders worth ₹51,250.00 were never paid. The biggest is NC-1058 (₹22,750.00).",
    );
  });

  it("investigate: status, payment, shipment and what you can do", () => {
    const o = db.select().from(orders).where(eq(orders.id, "NC-1004")).get()!;
    const s = db.select().from(shipments).where(eq(shipments.orderId, "NC-1004")).get()!;
    expect(say("investigate_order", { order_id: "NC-1004" })).toBe(`NC-1004 is ${o.status} and paid; the shipment is ${s.status}. You can cancel it.`);
  });

  it("count: delayed shipments and how many are over Rs 5,000", () => {
    const delayed = db.select({ a: orders.amountMinor }).from(orders).innerJoin(shipments, eq(shipments.orderId, orders.id)).where(eq(shipments.status, "delayed")).all();
    const high = delayed.filter((d) => d.a > 500000).length;
    const total = delayed.reduce((s, d) => s + d.a, 0);
    expect(say("count_orders", { shipmentStatus: "delayed" })).toMatch(
      new RegExp(`^There are ${delayed.length} orders with a delayed shipment, worth ${money(total).replace(/[.]/g, "\\.")} in total; ${high} are over ₹5,000\\.00\\. The biggest is NC-\\d+`),
    );
  });

  it("no match says so plainly", () => {
    expect(say("find_orders", { orderStatus: "cancelled", minAmountMinor: 9_000_000_000 })).toBe("There are no cancelled orders over ₹9,00,00,000.00.");
  });

  it("customer, queues, approvals, tickets, health, audit, workflow runs each answer in a sentence", () => {
    expect(say("get_customer", { customer_id: "C-008" })).toBe(
      "Demo Customer 8 (C-008) has 6 orders and has spent ₹68,750.00 net. ₹68,750.00 is at risk (₹68,750.00 owed in refunds). No open tickets.",
    );
    expect(say("team_queues")).toMatch(/^Operations has 6 items, Finance has 15 items, Support has 20 items\. First in support: /);
    expect(say("list_approvals")).toBe("There are no pending refund requests.");
    expect(say("list_tickets", { status: "open" })).toBe("There are no open tickets.");
    expect(say("health_and_sync")).toMatch(/^All 3 services are up\. The last sync was .*IST\.$/);
    expect(say("search_audit", { action: "order.cancel" })).toBe("No audit entries match.");
    expect(say("workflow_runs")).toBe("No workflow runs match.");
  });
});

describe("briefing", () => {
  it("ranks urgent money first: owed refunds, then unpaid, then delayed high-value shipments", () => {
    const keys = collectIssues().map((i) => i.key);
    expect(keys.slice(0, 3)).toEqual(["owed_refunds", "unpaid_shipped", "delayed_high_value"]);
    const text = briefingText(collectIssues());
    expect(text).toMatch(/^The biggest issue: 11 cancelled orders still hold ₹1,37,750\.00 that hasn't been refunded\. Next, 4 shipped or delivered orders worth ₹51,250\.00 were never paid\. Also, /);
    expect(text.split(/(?<=\.) /).length).toBeLessThanOrEqual(4);
  });

  it("a service down outranks money; failed refunds and pending approvals are listed", () => {
    recordHealth("payments", false, "unreachable");
    db.insert(operations).values({ orderId: "NC-1002", type: "refund", status: "failed", amountMinor: 50000, requestedByLabel: "manager@nova.test" } as never).run();
    const issues = collectIssues();
    expect(issues[0]).toMatchObject({ key: "services_down", href: "/integrations" });
    expect(issues.map((i) => i.key)).toContain("failed_refunds");
    expect(briefingText(issues)).toMatch(/^The biggest issue: Payment API is unreachable/);
  });

  it("the briefing tool gives the sentences plus a ranked list with links", () => {
    const r = runTool("briefing", {}, viewer);
    expect(r.title).toBe(briefingText(collectIssues()));
    const list = r.blocks[0] as { kind: "list"; items: { text: string; href?: string }[] };
    expect(list.items[0]).toMatchObject({ text: expect.stringMatching(/^11 cancelled orders/), href: "/queues?tab=finance" });
  });

  it("nothing open -> says so", () => expect(briefingText([])).toMatch(/^Nothing needs attention right now/));
});

describe("resume smart answers", () => {
  const post = async (email: string | null) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (email) {
      const u = db.select().from(users).where(eq(users.email, email)).get()!;
      headers.cookie = (await createSessionCookie(u.id)).split(";")[0];
    }
    return resumeRoute(new Request("http://localhost/api/assistant/resume", { method: "POST", headers, body: "{}" }));
  };

  it("viewer and operator get 403, no session 401; the pause stays", async () => {
    recordAiFailure({ category: "usage_limit", reason: "usage_limit", until: "2099-01-01T00:00:00.000Z" });
    expect((await post(null)).status).toBe(401);
    expect((await post("viewer@nova.test")).status).toBe(403);
    expect((await post("operator@nova.test")).status).toBe(403);
    expect(db.select().from(assistantAiState).get()!.status).toBe("paused");
  });

  it("a manager clears the pause; audited as that manager", async () => {
    recordAiFailure({ category: "usage_limit", reason: "usage_limit", until: "2099-01-01T00:00:00.000Z" });
    const res = await post("manager@nova.test");
    expect(res.status).toBe(200);
    expect((await res.json()).status).not.toBe("paused"); // "off" here: tests run without a key
    expect(db.select().from(assistantAiState).get()).toMatchObject({ status: "available", pausedUntil: null });
    expect(db.select().from(auditLog).where(eq(auditLog.action, "assistant.ai_resume")).all()).toEqual([
      expect.objectContaining({ actorLabel: "manager@nova.test", role: "manager", outcome: "available" }),
    ]);
  });
});
