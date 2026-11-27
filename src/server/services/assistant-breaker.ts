// AI circuit breaker (state in the DB, so a pause survives restarts). A failed AI call is classified:
//   usage_limit (400/402/403 with a usage-limit message, or 429 with Retry-After) -> pause until the reset time in the
//   message or header (fallback 1 hour); outage (5xx, connection, timeout) -> pause 5 minutes; other -> degraded, no
//   pause; refusal -> no state change. While paused the API is never called. Every status change is audited as system.
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { assistantAiState, assistantCounters, assistantUsage } from "@/server/db/schema";
import { formatIst } from "@/lib/format";
import { audit } from "./audit";
import { aiConfig } from "./assistant-ai";
import { caps, istDay } from "./assistant-usage";

export type FailCategory = "usage_limit" | "outage" | "refusal" | "other";
export interface Failure {
  category: FailCategory;
  reason: string; // short machine reason for logs and counters, never shown to staff
  until?: string; // usage_limit only: when the provider says access returns
}

const HOUR_MS = 60 * 60 * 1000;
const OUTAGE_MS = 5 * 60 * 1000;
const USAGE_MSG = /usage limit|spend(ing)? limit|credit balance|quota/i;

// "API usage limit reached until 2026-12-01" / "... on 2026-12-01 at 00:00 UTC" -> that instant (UTC); else +1 hour.
export function resetFromMessage(msg: string, now: Date): string {
  const m = /(\d{4}-\d{2}-\d{2})(?:(?:T|\s+at\s+|\s+)(\d{1,2}:\d{2}(?::\d{2})?))?/.exec(msg);
  if (m) {
    const [h, min, s = "00"] = (m[2] ?? "00:00").split(":");
    const t = new Date(`${m[1]}T${h.padStart(2, "0")}:${min}:${s}Z`);
    if (!Number.isNaN(t.getTime()) && t > now) return t.toISOString();
  }
  return new Date(now.getTime() + HOUR_MS).toISOString();
}

function retryAfter(headers: unknown, now: Date): string | null {
  const h = headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
  const raw = typeof h?.get === "function" ? h.get("retry-after") : (h as Record<string, string> | undefined)?.["retry-after"];
  if (!raw) return null;
  const secs = Number(raw);
  const t = Number.isFinite(secs) ? new Date(now.getTime() + secs * 1000) : new Date(raw);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export function classify(e: unknown, now = new Date()): Failure {
  if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError) return { category: "outage", reason: "timeout" };
  if (e instanceof Anthropic.APIConnectionError) return { category: "outage", reason: "connection" };
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    const msg = e.message ?? "";
    if (status === 429) {
      const until = retryAfter(e.headers, now);
      if (until) return { category: "usage_limit", reason: "rate_limited", until };
      if (USAGE_MSG.test(msg)) return { category: "usage_limit", reason: "usage_limit", until: resetFromMessage(msg, now) };
      return { category: "outage", reason: "rate_limited" }; // ponytail: 429 without a reset time = short pause
    }
    if ([400, 402, 403].includes(status) && USAGE_MSG.test(msg)) return { category: "usage_limit", reason: "usage_limit", until: resetFromMessage(msg, now) };
    if (status >= 500) return { category: "outage", reason: `api_${status}` };
    return { category: "other", reason: `api_${status || "error"}` };
  }
  return { category: "other", reason: "error" };
}

// ---------- state ----------

type StateRow = typeof assistantAiState.$inferSelect;
const DEGRADED_REASON: Record<string, string> = { other: "unexpected replies from the AI service" };

function read(): StateRow {
  const db = getDb();
  return db.select().from(assistantAiState).where(eq(assistantAiState.id, 1)).get() ?? { id: 1, status: "available", category: null, pausedUntil: null, lastErrorAt: null, lastErrorCategory: null, updatedAt: "" };
}

function write(next: Partial<StateRow>, prev: StateRow, now: Date): void {
  const row = { ...prev, ...next, id: 1, updatedAt: now.toISOString() };
  getDb().insert(assistantAiState).values(row).onConflictDoUpdate({ target: assistantAiState.id, set: row }).run();
  if (row.status !== prev.status || row.category !== prev.category) {
    audit({ actorLabel: "system", action: "assistant.ai_state", target: "assistant", outcome: row.status, detail: { from: prev.status, category: row.category, until: row.pausedUntil } });
  }
}

// Open = the AI may be called now. An expired pause closes back to available here (half-open: the next call probes).
export function aiGate(now = new Date()): { open: true } | { open: false; category: string } {
  const s = read();
  if (s.status !== "paused") return { open: true };
  if (s.pausedUntil && new Date(s.pausedUntil) > now) return { open: false, category: s.category ?? "outage" };
  write({ status: "available", category: null, pausedUntil: null }, s, now);
  return { open: true };
}

export function recordAiSuccess(now = new Date()): void {
  const s = read();
  if (s.status !== "available") write({ status: "available", category: null, pausedUntil: null }, s, now);
}

// A Manager clears a pause or degraded state by hand (e.g. after the usage limit was raised). Audited as that Manager.
export function resumeAi(actor: { id: number; email: string; role: string }, now = new Date()): { from: string } {
  const s = read();
  const row = { ...s, id: 1, status: "available" as const, category: null, pausedUntil: null, updatedAt: now.toISOString() };
  getDb().insert(assistantAiState).values(row).onConflictDoUpdate({ target: assistantAiState.id, set: row }).run();
  audit({ userId: actor.id, actorLabel: actor.email, role: actor.role, action: "assistant.ai_resume", target: "assistant", outcome: "available", detail: { from: s.status, category: s.category, until: s.pausedUntil } });
  return { from: s.status };
}

export function recordAiFailure(f: Failure, now = new Date()): void {
  const s = read();
  const err = { lastErrorAt: now.toISOString(), lastErrorCategory: f.category };
  if (f.category === "usage_limit") write({ ...err, status: "paused", category: f.category, pausedUntil: f.until ?? new Date(now.getTime() + HOUR_MS).toISOString() }, s, now);
  else if (f.category === "outage") write({ ...err, status: "paused", category: f.category, pausedUntil: new Date(now.getTime() + OUTAGE_MS).toISOString() }, s, now);
  else if (f.category === "other") write({ ...err, status: "degraded", category: f.category, pausedUntil: null }, s, now);
  else write(err, s, now); // refusal: a model decision, not a service problem
}

// ---------- counters + health ----------

export function bumpCounter(key: string, now = new Date()): void {
  getDb()
    .insert(assistantCounters)
    .values({ day: istDay(now), key, n: 1 })
    .onConflictDoUpdate({ target: [assistantCounters.day, assistantCounters.key], set: { n: sql`${assistantCounters.n} + 1` } })
    .run();
}

export interface AiHealth {
  status: "off" | "available" | "paused" | "degraded";
  label: string;
  aiAnswers: number;
  cap: number;
  perUserCap: number;
  standardAnswers: number;
  fallbacks: Record<string, number>;
  groundingMisses: number;
  tokens: { input: number; output: number };
  lastErrorAt: string | null;
  lastErrorCategory: string | null;
}

const CATEGORY_LABEL: Record<string, string> = { usage_limit: "usage limit", outage: "service outage", refusal: "model refusal", other: "unexpected error" };
export const categoryLabel = (c: string | null) => (c ? (CATEGORY_LABEL[c] ?? c) : null);

export function aiHealth(now = new Date()): AiHealth {
  const db = getDb();
  const day = istDay(now);
  const s = read();
  const u = db
    .select({ q: sql<number>`coalesce(sum(${assistantUsage.questions}),0)`, ai: sql<number>`coalesce(sum(${assistantUsage.aiQuestions}),0)`, i: sql<number>`coalesce(sum(${assistantUsage.inputTokens}),0)`, o: sql<number>`coalesce(sum(${assistantUsage.outputTokens}),0)` })
    .from(assistantUsage)
    .where(eq(assistantUsage.day, day))
    .get()!;
  const counters = db.select().from(assistantCounters).where(and(eq(assistantCounters.day, day))).all();
  const fallbacks = Object.fromEntries(counters.filter((c) => c.key.startsWith("fallback:")).map((c) => [c.key.slice(9), c.n]));
  const paused = s.status === "paused" && s.pausedUntil !== null && new Date(s.pausedUntil) > now;
  const status: AiHealth["status"] = !aiConfig.enabled ? "off" : paused ? "paused" : s.status === "degraded" ? "degraded" : "available";
  const label =
    status === "off" ? "Off: standard answers only"
    : status === "paused" ? `Paused: ${categoryLabel(s.category)} until ${formatIst(s.pausedUntil)}`
    : status === "degraded" ? `Degraded: ${DEGRADED_REASON[s.category ?? "other"] ?? "unexpected replies from the AI service"}`
    : "Available";
  return {
    status,
    label,
    aiAnswers: u.ai,
    cap: caps.global,
    perUserCap: caps.perUser,
    standardAnswers: Math.max(0, u.q - u.ai),
    fallbacks,
    groundingMisses: counters.find((c) => c.key === "grounding_miss")?.n ?? 0,
    tokens: { input: u.i, output: u.o },
    lastErrorAt: s.lastErrorAt,
    lastErrorCategory: s.lastErrorCategory,
  };
}

// What the assistant page shows: is AI paused for staff, and how many AI questions this user has left today.
export function aiStatusForUser(userId: number, now = new Date()): { enabled: boolean; paused: boolean; remaining: number } {
  const h = aiHealth(now);
  const mine = getDb().select().from(assistantUsage).where(and(eq(assistantUsage.day, istDay(now)), eq(assistantUsage.userId, userId))).get()?.aiQuestions ?? 0;
  return { enabled: h.status !== "off", paused: h.status === "paused", remaining: Math.max(0, Math.min(h.perUserCap - mine, h.cap - h.aiAnswers)) };
}
