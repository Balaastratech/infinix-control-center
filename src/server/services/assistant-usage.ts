// Daily AI caps, counted in the DB per IST day (docs/assistant-design.md section 8). A slot is reserved in one
// transaction BEFORE the API call, so concurrent questions can't overshoot. The built-in parser is never capped.
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { assistantUsage } from "@/server/db/schema";

const IST_MS = 330 * 60 * 1000;
export const istDay = (d = new Date()) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

const int = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 && process.env[name] !== "" ? v : fallback;
};
export const caps = {
  get global() {
    return int("ASSISTANT_GLOBAL_DAILY", 60);
  },
  get perUser() {
    return int("ASSISTANT_USER_DAILY", 15);
  },
};

export type Slot = { ok: true } | { ok: false; notice: string };

export function reserveAiSlot(userId: number, now = new Date()): Slot {
  const db = getDb();
  const day = istDay(now);
  return db.transaction(() => {
    const global = db.select({ n: sql<number>`coalesce(sum(${assistantUsage.aiQuestions}), 0)` }).from(assistantUsage).where(eq(assistantUsage.day, day)).get()!.n;
    const mine = db.select().from(assistantUsage).where(and(eq(assistantUsage.day, day), eq(assistantUsage.userId, userId))).get()?.aiQuestions ?? 0;
    if (mine >= caps.perUser || global >= caps.global) {
      const which = mine >= caps.perUser ? `${caps.perUser} per user` : `${caps.global} in total`;
      return { ok: false, notice: `AI limit reached for today (${which}). Built-in answers still work. Resets at midnight IST.` };
    }
    db.insert(assistantUsage)
      .values({ day, userId, aiQuestions: 1 })
      .onConflictDoUpdate({ target: [assistantUsage.day, assistantUsage.userId], set: { aiQuestions: sql`${assistantUsage.aiQuestions} + 1` } })
      .run();
    return { ok: true };
  });
}

// Every question (parser or AI) is counted; tokens are added after each API call from response.usage.
export function recordUsage(userId: number, delta: { questions?: number; inputTokens?: number; outputTokens?: number }, now = new Date()): void {
  getDb()
    .insert(assistantUsage)
    .values({ day: istDay(now), userId, questions: delta.questions ?? 0, inputTokens: delta.inputTokens ?? 0, outputTokens: delta.outputTokens ?? 0 })
    .onConflictDoUpdate({
      target: [assistantUsage.day, assistantUsage.userId],
      set: {
        questions: sql`${assistantUsage.questions} + ${delta.questions ?? 0}`,
        inputTokens: sql`${assistantUsage.inputTokens} + ${delta.inputTokens ?? 0}`,
        outputTokens: sql`${assistantUsage.outputTokens} + ${delta.outputTokens ?? 0}`,
      },
    })
    .run();
}

// A failed or skipped AI call gives its slot back: only real AI answers count against the caps.
export function releaseAiSlot(userId: number, now = new Date()): void {
  getDb()
    .update(assistantUsage)
    .set({ aiQuestions: sql`max(${assistantUsage.aiQuestions} - 1, 0)` })
    .where(and(eq(assistantUsage.day, istDay(now)), eq(assistantUsage.userId, userId)))
    .run();
}
