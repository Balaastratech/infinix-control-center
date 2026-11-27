// Operations assistant: one answer pipeline. The built-in parser picks a tool; the tool (assistant-tools.ts) reads local
// data as the logged-in user and returns display blocks. Actions are proposals only. docs/assistant-design.md.
import { getDb } from "@/server/db";
import { customers } from "@/server/db/schema";
import type { AuthUser } from "@/server/auth/require-role";
import { audit, userActor } from "./audit";
import { parse, type AssistantContext } from "./assistant-parser";
import { runTool } from "./assistant-tools";
import { answerWithAi, aiConfig } from "./assistant-ai";
import { recordUsage, reserveAiSlot } from "./assistant-usage";
import { addTurn, createConversation, lastContext, limits, messageCount, recentTurns, type Owner, type StoredAnswer, type ToolLog } from "./conversations";

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

const HISTORY_TURNS = 6;

// Parser first (free, deterministic). Only a question the parser can't place goes to the AI, if it is on and the daily
// caps allow; any AI failure falls back to the parser's answer with a note.
async function answer(owner: Owner, id: string, text: string, user: AuthUser): Promise<Answer> {
  const last = lastContext(owner, id);
  const parsed = answerWithParser(text, user, last);
  recordUsage(user.id, { questions: 1 });
  if (parsed.answer.intent !== "no_match" || !aiConfig.enabled) return parsed;
  const slot = reserveAiSlot(user.id);
  if (!slot.ok) return { answer: { ...parsed.answer, notice: slot.notice }, calls: parsed.calls };
  const ai = await answerWithAi({ question: text, user, last, history: recentTurns(owner, id, HISTORY_TURNS), customerNames: customerList().map((c) => c.name) });
  for (const c of ai.calls) {
    if (c.outcome === "denied" || c.outcome === "invalid" || c.outcome === "not_allowed") {
      audit({ ...actorFields(user), action: "assistant.tool", target: c.tool.slice(0, 60), outcome: c.outcome, detail: { source: "ai" } });
    }
  }
  if (ai.ok) return { answer: ai.answer, calls: ai.calls };
  return {
    answer: { ...parsed.answer, mode: "fallback", notice: "AI unavailable for this question, so this is the built-in answer." },
    calls: [...ai.calls, { source: "ai", tool: "(fallback)", input: { reason: ai.reason }, outcome: "error", ms: 0 }],
  };
}

export async function ask(owner: Owner, user: AuthUser, text: string, conversationId: string | null): Promise<AskOutcome> {
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
  const { answer: a, calls } = await answer(owner, id, text, user);
  if (!addTurn(owner, id, text, a, calls)) return { ok: false, status: 404, error: "conversation not found" };
  return { ok: true, conversationId: id, answer: a, droppedOldest: dropped || undefined };
}
