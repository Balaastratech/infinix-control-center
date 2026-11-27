// Assistant conversations. The ONLY module that touches the assistant_* conversation tables, and every query is scoped
// to the owner (user id + browser device id). Not yours = null -> the route answers 404, so ids never leak.
// docs/assistant-design.md sections 1-2.
import crypto from "node:crypto";
import { and, asc, count, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@/server/db";
import { assistantConversations, assistantMessages, assistantToolCalls } from "@/server/db/schema";
import type { AssistantContext } from "./assistant-parser";
import type { Block } from "./assistant-tools";

export interface Owner {
  userId: number;
  device: string;
}

const int = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};
export const limits = {
  get retentionDays() {
    return int("ASSISTANT_RETENTION_DAYS", 7);
  },
  get maxMessages() {
    return int("ASSISTANT_MAX_MESSAGES", 20);
  },
  get maxConversations() {
    return int("ASSISTANT_MAX_CONVERSATIONS", 20);
  },
  get maxChars() {
    return int("ASSISTANT_MAX_CHARS", 500);
  },
};

const mine = (owner: Owner, id?: string) =>
  and(
    eq(assistantConversations.ownerUserId, owner.userId),
    eq(assistantConversations.ownerDevice, owner.device),
    id === undefined ? undefined : eq(assistantConversations.id, id),
  );

export interface StoredAnswer {
  text: string; // the headline
  mode: "parser" | "ai" | "fallback";
  intent: string;
  understood: string;
  blocks: Block[];
  suggestions?: string[];
  notice?: string;
  context: AssistantContext | null;
}

export interface MessageView {
  id: number;
  role: "user" | "assistant";
  text: string;
  mode: string | null;
  intent: string | null;
  understood: string | null;
  blocks: Block[];
  suggestions?: string[];
  notice?: string;
  createdAt: string;
}

// Conversations idle longer than the retention window are deleted (messages and tool calls cascade).
export function purgeOld(now = new Date()): number {
  const cutoff = new Date(now.getTime() - limits.retentionDays * 86_400_000).toISOString();
  return getDb().delete(assistantConversations).where(lt(assistantConversations.updatedAt, cutoff)).run().changes;
}

export function listConversations(owner: Owner) {
  purgeOld();
  return getDb()
    .select({ id: assistantConversations.id, title: assistantConversations.title, updatedAt: assistantConversations.updatedAt })
    .from(assistantConversations)
    .where(mine(owner))
    .orderBy(desc(assistantConversations.updatedAt))
    .all();
}

// New conversation; at the per-owner cap the oldest one is deleted first. Returns whether one was dropped.
export function createConversation(owner: Owner, firstQuestion: string): { id: string; dropped: boolean } {
  const db = getDb();
  purgeOld();
  return db.transaction(() => {
    const existing = db.select({ id: assistantConversations.id }).from(assistantConversations).where(mine(owner)).orderBy(asc(assistantConversations.updatedAt)).all();
    const excess = existing.length - limits.maxConversations + 1;
    for (const c of existing.slice(0, Math.max(0, excess))) db.delete(assistantConversations).where(mine(owner, c.id)).run();
    const id = crypto.randomUUID();
    db.insert(assistantConversations).values({ id, ownerUserId: owner.userId, ownerDevice: owner.device, title: firstQuestion.slice(0, 60) }).run();
    return { id, dropped: excess > 0 };
  });
}

export function getConversation(owner: Owner, id: string): { id: string; title: string; messages: MessageView[] } | null {
  const db = getDb();
  const conv = db.select().from(assistantConversations).where(mine(owner, id)).get();
  if (!conv) return null;
  const rows = db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, conv.id)).orderBy(asc(assistantMessages.id)).all();
  return {
    id: conv.id,
    title: conv.title,
    messages: rows.map((m) => {
      const extra = m.blocks ? (JSON.parse(m.blocks) as { blocks: Block[]; suggestions?: string[]; notice?: string }) : { blocks: [] };
      return { id: m.id, role: m.role, text: m.text, mode: m.mode, intent: m.intent, understood: m.understood, createdAt: m.createdAt, ...extra };
    }),
  };
}

export function renameConversation(owner: Owner, id: string, title: string): boolean {
  return getDb().update(assistantConversations).set({ title: title.slice(0, 60) }).where(mine(owner, id)).run().changes === 1;
}

export function deleteConversation(owner: Owner, id: string): boolean {
  return getDb().delete(assistantConversations).where(mine(owner, id)).run().changes === 1;
}

export function messageCount(owner: Owner, id: string): number | null {
  const db = getDb();
  if (!db.select({ id: assistantConversations.id }).from(assistantConversations).where(mine(owner, id)).get()) return null;
  return db.select({ n: count() }).from(assistantMessages).where(eq(assistantMessages.conversationId, id)).get()!.n;
}

// Context for follow-ups: the last assistant message's context in this (owned) conversation.
export function lastContext(owner: Owner, id: string): AssistantContext | null {
  const db = getDb();
  if (!db.select({ id: assistantConversations.id }).from(assistantConversations).where(mine(owner, id)).get()) return null;
  const row = db
    .select({ context: assistantMessages.context })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.conversationId, id), eq(assistantMessages.role, "assistant")))
    .orderBy(desc(assistantMessages.id))
    .limit(1)
    .get();
  return row?.context ? (JSON.parse(row.context) as AssistantContext) : null;
}

export interface ToolLog {
  source: "parser" | "ai";
  tool: string;
  input: unknown;
  outcome: string;
  ms: number;
}

// Store the question and the answer (and the tool calls behind it) together. False if the conversation isn't yours.
export function addTurn(owner: Owner, id: string, question: string, answer: StoredAnswer, calls: ToolLog[]): boolean {
  const db = getDb();
  return db.transaction(() => {
    const touched = db.update(assistantConversations).set({ updatedAt: new Date().toISOString() }).where(mine(owner, id)).run().changes;
    if (touched !== 1) return false;
    db.insert(assistantMessages).values({ conversationId: id, role: "user", text: question }).run();
    db.insert(assistantMessages)
      .values({
        conversationId: id,
        role: "assistant",
        text: answer.text,
        mode: answer.mode,
        intent: answer.intent,
        understood: answer.understood,
        blocks: JSON.stringify({ blocks: answer.blocks, suggestions: answer.suggestions, notice: answer.notice }),
        context: answer.context ? JSON.stringify(answer.context) : null,
      })
      .run();
    for (const c of calls) {
      db.insert(assistantToolCalls).values({ conversationId: id, source: c.source, tool: c.tool.slice(0, 60), input: JSON.stringify(c.input ?? null).slice(0, 2000), outcome: c.outcome, ms: c.ms }).run();
    }
    return true;
  });
}
