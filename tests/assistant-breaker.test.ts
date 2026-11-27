// AI circuit breaker, calm fallback and observability. A fake model (through the seam) throws the errors a real API
// does; the breaker must pause, never call the API while paused, keep failed calls off the caps, and audit changes.
import Anthropic, { APIConnectionError, APIUserAbortError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute, POST as startRoute } from "@/app/api/assistant/conversations/route";
import { GET as healthRoute } from "@/app/api/assistant/health/route";
import { createSessionCookie } from "@/server/auth/session";
import type { Db } from "@/server/db";
import { assistantAiState, assistantUsage, auditLog, users } from "@/server/db/schema";
import { resetBurst } from "@/server/services/assistant";
import { setCreateMessageForTests, type CreateMessage } from "@/server/services/assistant-ai";
import { aiGate, aiHealth, classify, recordAiFailure, resetFromMessage } from "@/server/services/assistant-breaker";
import { HELP_INTRO } from "@/server/services/assistant-parser";
import { clearData, setupTestDb } from "./helpers/db";

const NO_MATCH = "hmm, sort this out for me";
const NOW = new Date("2026-11-27T10:00:00Z");
const usageError = (status = 400, msg = "API usage limit reached until 2026-12-01", headers = new Headers()) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "invalid_request_error", message: msg } }, msg, headers);

let db: Db;
let step: () => Promise<Anthropic.Message>;
const fake = vi.fn<CreateMessage>(async () => step());
const say = (text: string) => async () =>
  ({ id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as Anthropic.Message;

beforeAll(() => {
  db = setupTestDb();
  setCreateMessageForTests(fake);
});
afterAll(() => setCreateMessageForTests(null));
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  clearData();
  for (const t of ["assistant_conversations", "assistant_usage", "assistant_ai_state", "assistant_counters"]) db.run(`DELETE FROM ${t}` as never);
  resetBurst();
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-real");
  vi.stubEnv("ASSISTANT_AI", "on");
  fake.mockClear();
});

const userId = (email: string) => db.select().from(users).where(eq(users.email, email)).get()!.id;
const cookie = async (email: string) => `${(await createSessionCookie(userId(email))).split(";")[0]}; nova_asst_dev=${"d".repeat(32)}`;
async function ask(text: string, as = "operator@nova.test") {
  const res = await startRoute(new Request("http://localhost/api/assistant/conversations", { method: "POST", headers: { "Content-Type": "application/json", cookie: await cookie(as) }, body: JSON.stringify({ text }) }));
  return { status: res.status, body: await res.json() };
}
const aiUsed = (email = "operator@nova.test") => db.select().from(assistantUsage).where(eq(assistantUsage.userId, userId(email))).get()?.aiQuestions ?? 0;
const stateAudits = () => db.select().from(auditLog).where(eq(auditLog.action, "assistant.ai_state")).all();

describe("classify", () => {
  it.each([
    ["400 usage-limit message", usageError(), "usage_limit", "2026-12-01T00:00:00.000Z"],
    ["402 usage-limit message", usageError(402), "usage_limit", "2026-12-01T00:00:00.000Z"],
    ["403 usage limit with a time", usageError(403, "You have reached your usage limit. Access returns on 2026-12-01 at 05:30 UTC."), "usage_limit", "2026-12-01T05:30:00.000Z"],
    ["429 with Retry-After seconds", usageError(429, "rate limited", new Headers({ "retry-after": "120" })), "usage_limit", "2026-11-27T10:02:00.000Z"],
    ["500", usageError(500, "internal"), "outage", undefined],
    ["529 overloaded", usageError(529, "overloaded"), "outage", undefined],
    ["connection error", new APIConnectionError({ message: "down" }), "outage", undefined],
    ["timeout", new APIUserAbortError(), "outage", undefined],
    ["400 that is not a usage limit", usageError(400, "messages: invalid"), "other", undefined],
    ["a plain Error", new Error("boom"), "other", undefined],
  ])("%s", (_label, err, category, until) => {
    const f = classify(err, NOW);
    expect(f.category).toBe(category);
    expect(f.until).toBe(until);
  });

  it("usage limit with no readable reset time pauses 1 hour; a past date is ignored", () => {
    expect(resetFromMessage("usage limit reached", NOW)).toBe("2026-11-27T11:00:00.000Z");
    expect(resetFromMessage("usage limit reached until 2020-01-01", NOW)).toBe("2026-11-27T11:00:00.000Z");
  });
});

describe("circuit breaker", () => {
  it("a usage limit pauses AI until the reset time: calm standard answer, no further API calls, slot given back, audited", async () => {
    step = () => Promise.reject(usageError());
    const first = await ask(NO_MATCH);
    expect(first.status).toBe(200);
    expect(first.body.answer.mode).toBe("fallback");
    expect(first.body.answer.notice).toBeUndefined();
    expect(JSON.stringify(first.body)).not.toMatch(/400|usage limit reached|invalid_request/i);
    expect(aiUsed()).toBe(0); // the failed call does not count against the cap

    const second = await ask(NO_MATCH);
    expect(second.body.answer.mode).toBe("fallback");
    expect(fake).toHaveBeenCalledTimes(1); // paused: never called again
    expect(aiUsed()).toBe(0);

    const row = db.select().from(assistantAiState).get()!; // in the DB, so a restart keeps the pause
    expect(row).toMatchObject({ status: "paused", category: "usage_limit", pausedUntil: "2026-12-01T00:00:00.000Z" });
    expect(stateAudits()).toEqual([expect.objectContaining({ actorLabel: "system", outcome: "paused", target: "assistant" })]);
    expect(aiHealth().label).toMatch(/^Paused: usage limit until .*IST/);
    expect(aiHealth().fallbacks).toEqual({ usage_limit: 1, paused_usage_limit: 1 });
  });

  it("an outage pauses 5 minutes, then the gate reopens (audited) and a success keeps it available", async () => {
    recordAiFailure(classify(new APIConnectionError({ message: "x" }), NOW), NOW);
    expect(aiGate(new Date(NOW.getTime() + 4 * 60_000)).open).toBe(false);
    expect(aiGate(new Date(NOW.getTime() + 5 * 60_000 + 1)).open).toBe(true);
    expect(stateAudits().map((a) => a.outcome)).toEqual(["paused", "available"]);
    step = say("I don't have that.");
    expect((await ask(NO_MATCH)).body.answer.mode).toBe("ai");
    expect(aiUsed()).toBe(1);
  });

  it("an unexpected error degrades (no pause); the next success clears it", async () => {
    step = () => Promise.reject(new Error("boom"));
    await ask(NO_MATCH);
    expect(aiHealth()).toMatchObject({ status: "degraded", lastErrorCategory: "other" });
    expect(aiHealth().label).toMatch(/^Degraded: /);
    step = say("I don't have that.");
    expect((await ask(NO_MATCH)).body.answer.mode).toBe("ai");
    expect(aiHealth().status).toBe("available");
    expect(stateAudits().map((a) => a.outcome)).toEqual(["degraded", "available"]);
  });

  it("a refusal falls back but does not pause or degrade", async () => {
    step = async () => ({ ...(await say("")()), content: [], stop_reason: "refusal" }) as unknown as Anthropic.Message;
    expect((await ask(NO_MATCH)).body.answer.mode).toBe("fallback");
    expect(aiHealth()).toMatchObject({ status: "available", lastErrorCategory: "refusal" });
    expect(stateAudits()).toHaveLength(0);
  });
});

describe("observability", () => {
  it("GET /api/assistant/health: any logged-in role, 401 without a session", async () => {
    expect((await healthRoute(new Request("http://localhost/api/assistant/health"))).status).toBe(401);
    const res = await healthRoute(new Request("http://localhost/api/assistant/health", { headers: { cookie: await cookie("viewer@nova.test") } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "available", label: "Available", aiAnswers: 0, cap: 60, standardAnswers: 0 });
  });

  it("counts AI answers, standard answers, tokens; the assistant page gets paused + remaining", async () => {
    step = say("I don't have that.");
    await ask(NO_MATCH);
    await ask("money at risk");
    expect(aiHealth()).toMatchObject({ aiAnswers: 1, standardAnswers: 1, tokens: { input: 10, output: 5 } });
    const list = await listRoute(new Request("http://localhost/api/assistant/conversations", { headers: { cookie: await cookie("operator@nova.test") } }));
    expect((await list.json()).ai).toEqual({ enabled: true, paused: false, remaining: 14 });
    recordAiFailure({ category: "usage_limit", reason: "usage_limit", until: "2099-01-01T00:00:00.000Z" });
    const paused = await listRoute(new Request("http://localhost/api/assistant/conversations", { headers: { cookie: await cookie("operator@nova.test") } }));
    expect((await paused.json()).ai.paused).toBe(true);
  });

  it("a grounding miss is logged and counted", async () => {
    const steps = [
      async () => ({ ...(await say("")()), content: [{ type: "tool_use", id: "toolu_1", name: "health_and_sync", input: {} }], stop_reason: "tool_use" }) as unknown as Anthropic.Message,
      say("NC-9999 is worth ₹99,999."),
    ];
    step = () => steps.shift()!();
    const r = await ask(NO_MATCH);
    expect(r.body.answer.mode).toBe("ai");
    expect(aiHealth().groundingMisses).toBe(1);
  });

  it("unknown questions get what I can help with plus 3 examples, never 'I didn't understand'", async () => {
    vi.stubEnv("ASSISTANT_AI", "off");
    const r = await ask("blorp the frobnicator");
    expect(r.body.answer.text).toBe(HELP_INTRO);
    expect(r.body.answer.suggestions).toHaveLength(3);
    expect(JSON.stringify(r.body)).not.toMatch(/didn't understand/i);
  });
});
