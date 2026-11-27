// Operations assistant: one answer pipeline. The built-in parser picks a tool; the tool (assistant-tools.ts) reads local
// data as the logged-in user and returns display blocks. Actions are proposals only. docs/assistant-design.md.
import { getDb } from "@/server/db";
import { customers } from "@/server/db/schema";
import type { AuthUser } from "@/server/auth/require-role";
import { audit, userActor } from "./audit";
import { parse, type AssistantContext } from "./assistant-parser";
import { runTool } from "./assistant-tools";
import { addTurn, createConversation, lastContext, limits, messageCount, type Owner, type StoredAnswer, type ToolLog } from "./conversations";

export interface Answer {
  answer: StoredAnswer;
  calls: ToolLog[];
}

const customerList = () => getDb().select({ id: customers.id, name: customers.name, email: customers.email }).from(customers).all();

export function answerWithParser(text: string, user: AuthUser, last: AssistantContext | null): Answer {
  const p = parse(text, last, customerList());
  if (!p.call) {
    return {
      answer: { text: p.question ?? "Here is what I can do:", mode: "parser", intent: p.intent, understood: p.understood, blocks: [], suggestions: p.suggestions, context: last },
      calls: [],
    };
  }
  const started = Date.now();
  const r = runTool(p.call.tool, p.call.input, user);
  const call: ToolLog = { source: "parser", tool: p.call.tool, input: p.call.input, outcome: r.outcome, ms: Date.now() - started };
  if (r.outcome === "denied" || r.outcome === "invalid") {
    audit({ ...actorFields(user), action: "assistant.tool", target: p.call.tool, outcome: r.outcome, detail: { input: p.call.input } });
  }
  const isList = p.call.tool === "find_orders" || p.call.tool === "count_orders";
  return {
    answer: {
      text: r.title,
      mode: "parser",
      intent: p.intent,
      understood: p.understood,
      blocks: r.blocks,
      // Only order lists can be referred back to; anything else keeps the previous list as the follow-up context.
      context: isList && r.outcome === "ok" ? { intent: p.intent, filters: stripIds(r.filters), resultIds: r.resultIds } : last,
    },
    calls: [call],
  };
}

const stripIds = (f: Record<string, unknown> | undefined) => {
  if (!f) return {};
  const { order_ids: _ignored, ...rest } = f;
  void _ignored;
  return rest;
};

function actorFields(user: AuthUser) {
  const a = userActor(user);
  return { userId: a.userId, actorLabel: a.label, role: a.role };
}

// ---------- one question, end to end (used by both message routes) ----------


const BURST_PER_MIN = 20;
const recent = new Map<number, number[]>(); // ponytail: per-process burst limit; a DB counter if we ever run >1 node

export function overBurst(userId: number, now = Date.now()): boolean {
  const times = (recent.get(userId) ?? []).filter((t) => now - t < 60_000);
  const over = times.length >= BURST_PER_MIN;
  if (!over) times.push(now);
  recent.set(userId, times);
  return over;
}
export const resetBurst = () => recent.clear();

export type AskOutcome =
  | { ok: true; conversationId: string; answer: StoredAnswer; droppedOldest?: boolean }
  | { ok: false; status: 404 | 409 | 429; error: string };

export function ask(owner: Owner, user: AuthUser, text: string, conversationId: string | null): AskOutcome {
  if (overBurst(user.id)) return { ok: false, status: 429, error: `Too many questions: at most ${BURST_PER_MIN} per minute.` };
  let id = conversationId;
  let dropped = false;
  if (id === null) {
    ({ id, dropped } = createConversation(owner, text));
  } else {
    const n = messageCount(owner, id);
    if (n === null) return { ok: false, status: 404, error: "conversation not found" };
    if (n + 2 > limits.maxMessages) return { ok: false, status: 409, error: "This conversation is full. Start a new one." };
  }
  const { answer, calls } = answerWithParser(text, user, lastContext(owner, id));
  if (!addTurn(owner, id, text, answer, calls)) return { ok: false, status: 404, error: "conversation not found" };
  return { ok: true, conversationId: id, answer, droppedOldest: dropped || undefined };
}
