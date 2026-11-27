// Router + domain tool sets + the two new read tools + collapsed details.
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerDetails } from "@/app/(app)/assistant/answer-details";
import { POST as startRoute } from "@/app/api/assistant/conversations/route";
import { createSessionCookie } from "@/server/auth/session";
import type { AuthUser } from "@/server/auth/require-role";
import type { Db } from "@/server/db";
import { assistantToolCalls, refunds, users, type Role } from "@/server/db/schema";
import { resetBurst } from "@/server/services/assistant";
import { setCreateMessageForTests, type CreateMessage } from "@/server/services/assistant-ai";
import { MAX_TOOLS, route, toolsFor } from "@/server/services/assistant-router";
import { runTool } from "@/server/services/assistant-tools";
import { syncAll } from "@/server/services/sync";
import { clearData, setupTestDb } from "./helpers/db";
import { server } from "./helpers/mock-server";

vi.mock("@/server/services/workflows", () => ({ onWebhookEvent: vi.fn(async () => {}) }));

let db: Db;
const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
const fake = vi.fn<CreateMessage>(async (body) => {
  bodies.push(body);
  return { id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "I don't have that.", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
});

beforeAll(() => {
  db = setupTestDb();
  server.listen({ onUnhandledFrame: "error" });
  setCreateMessageForTests(fake);
});
afterAll(() => {
  setCreateMessageForTests(null);
  server.close();
});
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  clearData();
  for (const t of ["assistant_conversations", "assistant_usage", "assistant_ai_state", "assistant_counters"]) db.run(`DELETE FROM ${t}` as never);
  resetBurst();
  bodies.length = 0;
  await syncAll();
});

// [question, expected domains (in order)]
const JUDGEMENT: [string, string[]][] = [
  ["Which customer has the most money stuck with us?", ["money", "customers"]],
  ["Compare delayed shipments with unpaid orders: which hurts more?", ["orders", "money"]],
  ["How many refunds did we approve today and how much money went out?", ["money"]],
  ["Which orders should I cancel today?", ["orders"]],
  ["What should operations do before end of day?", ["operations"]],
];

describe("router", () => {
  it.each(JUDGEMENT)("%s -> AI, domains %j", (q, domains) => {
    const r = route(q, "find_orders", "manager");
    expect(r.ai).toBe(true);
    expect(r.domains).toEqual(domains);
    expect(r.tools.length).toBeGreaterThanOrEqual(3);
    expect(r.tools.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it.each(["money at risk", "late orders over 5k", "investigate order NC-1004", "open tickets", "who cancelled NC-1004"])("simple lookup stays with the parser: %s", (q) => {
    expect(route(q, "find_orders", "operator").ai).toBe(false);
  });

  it("the money question gets the money tools (customers_at_risk, refunds_summary), never all tools", () => {
    expect(route(JUDGEMENT[0][0], "find_orders", "manager").tools).toEqual(["money_at_risk", "customers_at_risk", "refunds_summary", "list_approvals", "get_customer"]);
    expect(route("hmm, sort this out for me", "no_match", "manager").tools).toEqual(["briefing", "find_orders", "get_customer"]);
  });

  it("propose tools only for an action the role allows; never for a Viewer; always <= 6 tools", () => {
    const roles: Role[] = ["viewer", "operator", "manager"];
    for (const role of roles) {
      for (const q of ["cancel NC-1001 if it makes sense, should I?", "refund NC-1002 and explain why", "please open a ticket for NC-1007, why is it late", ...JUDGEMENT.map((j) => j[0])]) {
        const tools = toolsFor(q.toLowerCase(), route(q, "find_orders", role).domains, role);
        expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS);
        if (role === "viewer") expect(tools.some((t) => t.startsWith("propose_"))).toBe(false);
      }
    }
    expect(toolsFor("cancel nc-1001, should i?", ["orders"], "operator")).toContain("propose_cancel");
    expect(toolsFor("which orders should i cancel today?", ["orders"], "operator")).not.toContain("propose_cancel"); // a question, not an action
  });
});

describe("routed AI requests", () => {
  const ask = async (text: string, email: string) => {
    const u = db.select().from(users).where(eq(users.email, email)).get()!;
    const cookie = `${(await createSessionCookie(u.id)).split(";")[0]}; nova_asst_dev=${"e".repeat(32)}`;
    const res = await startRoute(new Request("http://localhost/api/assistant/conversations", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text }) }));
    return res.json();
  };

  it("a Viewer's judgement question sends only domain tools (no propose tools), <= 6, and the route is logged", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-real");
    vi.stubEnv("ASSISTANT_AI", "on");
    await ask("cancel NC-1001? should I, compare it with NC-1002", "viewer@nova.test");
    await ask("Which customer has the most money stuck with us?", "operator@nova.test");
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect((b.tools ?? []).length).toBeLessThanOrEqual(MAX_TOOLS);
    expect((bodies[0].tools as Anthropic.Tool[]).map((t) => t.name).filter((n) => n.startsWith("propose_"))).toEqual([]);
    expect((bodies[1].tools as Anthropic.Tool[]).map((t) => t.name)).toContain("customers_at_risk");
    const logged = db.select().from(assistantToolCalls).where(eq(assistantToolCalls.tool, "(route)")).all();
    expect(JSON.parse(logged[1].input!)).toMatchObject({ domains: ["money", "customers"] });
  });

  it("without AI a judgement question gets the parser answer plus what it couldn't cover", async () => {
    vi.stubEnv("ASSISTANT_AI", "off");
    const r = await ask("Which orders should I cancel today?", "operator@nova.test");
    expect(r.answer.mode).toBe("parser");
    expect(r.answer.notice).toMatch(/judgement/);
    expect(bodies).toHaveLength(0); // AI off: the model is never called
  });
});

describe("new read tools on the sample data", () => {
  const viewer = () => db.select().from(users).where(eq(users.email, "viewer@nova.test")).get()! as AuthUser;

  it("customers_at_risk: C-003 first (₹69,000 owed, just above C-008's ₹68,750); totals add up to ₹1,89,000.00", () => {
    const r = runTool("customers_at_risk", {}, viewer());
    expect(r.title).toBe("Demo Customer 3 (C-003) has the most money at risk: ₹69,000.00 (₹69,000.00 owed in refunds, ₹0.00 unpaid). 6 customers have money at risk, ₹1,89,000.00 in total.");
    expect(runTool("get_customer", { customer_id: "C-003" }, viewer()).title).toContain("₹69,000.00 is at risk"); // same number as the customer view
    const table = r.blocks[0] as { kind: "table"; rows: unknown[][] };
    const atRisk = table.rows.map((row) => Number(String(row[1]).replace(/[₹,]/g, "")));
    expect(atRisk.reduce((s, v) => s + v, 0)).toBe(189000);
    expect([...atRisk].sort((a, b) => b - a)).toEqual(atRisk);
  });

  it("refunds_summary counts and sums succeeded and failed refunds in a range", () => {
    db.delete(refunds).run();
    db.insert(refunds).values([
      { id: "R-1", orderId: "NC-1008", amountMinor: 400000, currency: "INR", status: "succeeded", createdAt: "2026-11-27T04:00:00.000Z" },
      { id: "R-2", orderId: "NC-1018", amountMinor: 100000, currency: "INR", status: "succeeded", createdAt: "2026-11-27T06:00:00.000Z" },
      { id: "R-3", orderId: "NC-1038", amountMinor: 50000, currency: "INR", status: "failed", createdAt: "2026-11-27T07:00:00.000Z" },
      { id: "R-4", orderId: "NC-1048", amountMinor: 999900, currency: "INR", status: "succeeded", createdAt: "2026-11-20T07:00:00.000Z" },
    ]).run();
    const today = runTool("refunds_summary", { from: "2026-11-26T18:30:00.000Z", to: "2026-11-27T18:30:00.000Z" }, viewer());
    // "money went out" = succeeded only; the failed one is stated as not paid out
    expect(today.title).toMatch(/^0 refunds approved since .* and before .* \(₹0\.00\)\. Paid out \(succeeded\): 2 refunds, ₹5,000\.00; that is the money that went out\. Failed: 1 refund, ₹500\.00, not paid out\.$/);
    expect(runTool("refunds_summary", {}, viewer()).title).toBe("0 refunds approved (₹0.00). Paid out (succeeded): 3 refunds, ₹14,999.00; that is the money that went out. Failed: 1 refund, ₹500.00, not paid out.");
  });
});

describe("answer details", () => {
  it("are collapsed by default and show the count", () => {
    const html = renderToStaticMarkup(createElement(AnswerDetails, { count: 2 }, "table"));
    expect(html).toMatch(/^<details class="answer-details"><summary>Details \(2\)<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(renderToStaticMarkup(createElement(AnswerDetails, { count: 0 }, "x"))).toBe("");
  });
});
