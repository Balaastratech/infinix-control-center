"use client";

// Assistant chat: my conversations (this login + this browser) on the left, the open conversation on the right.
// Facts render only from the server's blocks; links come only from blocks and must be internal paths.
// Proposal cards never act by themselves: Confirm calls the normal order routes as the logged-in user.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney, parseRupees } from "@/lib/format";
import { Alert, Empty, TableWrap } from "../../ui";

type Cell = string | { text: string; href: string };
interface Item {
  text: string;
  href?: string;
}
type Block =
  | { kind: "table"; title: string; columns: string[]; rows: Cell[][]; more?: Item }
  | { kind: "list"; title: string; items: Item[] }
  | { kind: "proposal"; action: "cancel" | "refund" | "ticket"; orderId: string; amountMinor?: number; maxAmountMinor?: number; reason?: string; label: string; note: string; done?: string };
interface Message {
  id: number | string;
  role: "user" | "assistant";
  text: string;
  mode?: string | null;
  understood?: string | null;
  blocks: Block[];
  suggestions?: string[];
  notice?: string;
}
interface ConversationRow {
  id: string;
  title: string;
  updatedAt: string;
}

const SOMETHING_WRONG = "Something went wrong. Please try again.";
interface AiStatus {
  enabled: boolean;
  paused: boolean;
  remaining: number;
}

const STARTERS = ["money at risk", "late orders over Rs 5,000", "refunds waiting for approval", "investigate order NC-1004", "what's in the finance queue", "is any service down"];
const SAFE_HREF = /^\/(orders|customers|approvals|tickets|queues|workflows|integrations|audit)(\/|\?|$)/;
const safe = (href?: string) => (href && SAFE_HREF.test(href) ? href : undefined);
const MaybeLink = ({ href, children }: { href?: string; children: string }) => {
  const h = safe(href);
  return h ? <Link href={h}>{children}</Link> : <>{children}</>;
};

async function call(method: string, url: string, body?: unknown) {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the server. Check your connection and try again." } };
  }
}

export function AssistantChat() {
  const [list, setList] = useState<ConversationRow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxChars, setMaxChars] = useState(500);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null); // the question shown while we wait
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  const loadList = useCallback(async () => {
    const r = await call("GET", "/api/assistant/conversations");
    if (r.ok) {
      setList(r.data.conversations);
      setMaxChars(r.data.maxChars);
      setAi(r.data.ai ?? null);
    } else setError(r.data.error ?? SOMETHING_WRONG);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void loadList();
  }, [loadList]);

  async function open(id: string) {
    setError(null);
    const r = await call("GET", `/api/assistant/conversations/${id}`);
    if (!r.ok) return setError(r.data.error ?? SOMETHING_WRONG);
    setCurrent(id);
    setMessages(r.data.messages);
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setPending(q);
    setError(null);
    const r = current
      ? await call("POST", `/api/assistant/conversations/${current}/messages`, { text: q })
      : await call("POST", "/api/assistant/conversations", { text: q });
    setBusy(false);
    setPending(null);
    if (!r.ok) return setError(r.data.error ?? SOMETHING_WRONG);
    const a = r.data.answer;
    setMessages((m) => [...m, { id: `u${Date.now()}`, role: "user", text: q, blocks: [] }, { id: `a${Date.now()}`, role: "assistant", ...a }]);
    setText("");
    if (!current) setCurrent(r.data.conversationId);
    if (r.data.droppedOldest) setError("You had 20 conversations, so the oldest one was deleted.");
    void loadList();
  }

  async function rename(c: ConversationRow) {
    const title = window.prompt("Rename conversation", c.title)?.trim();
    if (!title) return;
    const r = await call("PATCH", `/api/assistant/conversations/${c.id}`, { title });
    if (!r.ok) setError(r.data.error ?? SOMETHING_WRONG);
    void loadList();
  }

  async function remove(c: ConversationRow) {
    if (!window.confirm(`Delete "${c.title}"?`)) return;
    const r = await call("DELETE", `/api/assistant/conversations/${c.id}`);
    if (!r.ok) return setError(r.data.error ?? SOMETHING_WRONG);
    if (current === c.id) {
      setCurrent(null);
      setMessages([]);
    }
    void loadList();
  }

  return (
    <div className="chat">
      <section className="card chat-list" aria-label="My conversations">
        <div className="card-head">
          <span className="label">My conversations</span>
          <button type="button" className="sm" onClick={() => { setCurrent(null); setMessages([]); setError(null); }}>
            New
          </button>
        </div>
        <div className="card-body stack">
          {list === null ? <span className="muted small">Loading…</span> : list.length === 0 ? <Empty>No conversations yet.</Empty> : null}
          {list?.map((c) => (
            <div key={c.id} className={`chat-item${c.id === current ? " active" : ""}`}>
              <button type="button" className="chat-title" title={c.title} aria-current={c.id === current ? "true" : undefined} onClick={() => open(c.id)}>
                {c.title}
              </button>
              <button type="button" className="icon-btn" title="Rename" aria-label={`Rename ${c.title}`} onClick={() => rename(c)}>✎</button>
              <button type="button" className="icon-btn" title="Delete" aria-label={`Delete ${c.title}`} onClick={() => remove(c)}>✕</button>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: "auto", padding: "8px 4px 0" }}>Private to you in this browser. Kept 7 days.</p>
        </div>
      </section>

      <section className="chat-panel" aria-label="Conversation">
        {ai?.paused && <p className="chat-info" role="status">Smart answers are paused right now. Standard answers still work.</p>}
        <div className="chat-thread" ref={threadRef} aria-live="polite">
          {messages.length === 0 && !pending && (
            <section className="card">
              <div className="card-body">
                <p>Ask about orders, customers, money at risk, queues, tickets, approvals, workflows, service health or the audit log. Actions are only proposed: you confirm them.</p>
                <div className="chips">
                  {STARTERS.map((s) => (
                    <button key={s} type="button" className="chip" style={{ height: "auto", boxShadow: "none" }} disabled={busy} onClick={() => ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
          {messages.map((m) => (m.role === "user" ? (
            <div key={m.id} className="bubble-user">{m.text}</div>
          ) : (
            <AnswerCard key={m.id} m={m} />
          )))}
          {pending && <div className="bubble-user">{pending}</div>}
          {busy && (
            <div className="typing" role="status" aria-label="Working on your answer">
              <span /><span /><span />
            </div>
          )}
          {error && <Alert tone="bad">{error}</Alert>}
        </div>
        <div className="chat-composer">
          <form onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={current ? "Ask a follow-up, e.g. which of those are over Rs 10,000?" : "e.g. late orders over Rs 5,000"} aria-label="Ask the assistant" maxLength={maxChars} />
            <button className="primary" disabled={busy || !text.trim()} aria-busy={busy}>
              {busy ? "Working…" : "Ask"}
            </button>
          </form>
          {ai?.enabled && !ai.paused && <p className="muted small" style={{ marginTop: 6 }}>Smart answers left today: {ai.remaining}</p>}
        </div>
      </section>
    </div>
  );
}

function AnswerCard({ m }: { m: Message }) {
  return (
    <section className="card answer">
      <div className="card-head">
        <span className="muted small">{m.understood}</span>
        <span className="muted small">{m.mode === "ai" ? "Smart answer" : "Standard answer"}</span>
      </div>
      <div className="card-body stack">
        <h3>{m.text}</h3>
        {m.notice && <Alert tone="warn">{m.notice}</Alert>}
        {m.blocks.map((b, i) => <BlockView key={i} b={b} />)}
        {m.suggestions && m.suggestions.length > 0 && (
          <ul className="muted">
            {m.suggestions.map((s) => <li key={s}>&ldquo;{s}&rdquo;</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

function BlockView({ b }: { b: Block }) {
  if (b.kind === "proposal") return <Proposal p={b} />;
  if (b.kind === "list")
    return (
      <div className="stack">
        <span className="label">{b.title}</span>
        <ul>
          {b.items.map((it, j) => (
            <li key={j} style={it.text.startsWith("LOCAL AHEAD") ? { fontWeight: 600 } : undefined}>
              <MaybeLink href={it.href}>{it.text}</MaybeLink>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="stack">
      <span className="label">{b.title}</span>
      {b.rows.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>{b.columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => <td key={k}>{typeof c === "string" ? c : <MaybeLink href={c.href}>{c.text}</MaybeLink>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {b.more && <MaybeLink href={b.more.href}>{b.more.text}</MaybeLink>}
    </div>
  );
}

// Confirm = the same request the order page makes. The route checks role, rules and audits as you.
function Proposal({ p }: { p: Extract<Block, { kind: "proposal" }> }) {
  const [amount, setAmount] = useState(p.amountMinor ? (p.amountMinor / 100).toFixed(2) : "");
  const [reason, setReason] = useState(p.reason ?? "");
  const [state, setState] = useState<{ busy?: boolean; done?: string; error?: string }>(p.done ? { done: p.done } : {});

  async function confirm() {
    let url = `/api/orders/${encodeURIComponent(p.orderId)}/`;
    let body: unknown = {};
    if (p.action === "cancel") url += "cancel";
    else if (p.action === "refund") {
      const paise = parseRupees(amount);
      if (paise === null || (p.maxAmountMinor !== undefined && paise > p.maxAmountMinor)) return setState({ error: `Enter an amount up to ${formatMoney(p.maxAmountMinor)}.` });
      url += "refund-requests";
      body = { amount_minor: paise };
    } else {
      url += "tickets";
      body = { reason };
    }
    setState({ busy: true });
    const r = await call("POST", url, body);
    setState(r.ok ? { done: p.action === "refund" ? "Refund request created. It now waits for Manager approval." : p.action === "cancel" ? "Order cancelled." : "Ticket created." } : { error: r.data.error ?? SOMETHING_WRONG });
  }

  return (
    <div className="card" style={{ borderStyle: "dashed" }}>
      <div className="card-body stack">
        <strong>{p.label}</strong>
        <span className="muted small">{p.note}</span>
        {p.action === "refund" && !state.done && (
          <label className="field">
            Amount (₹), up to {formatMoney(p.maxAmountMinor)}
            <input className="money-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
        )}
        {p.action === "ticket" && !state.done && (
          <label className="field">
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </label>
        )}
        {state.done ? (
          <Alert tone="ok">{state.done}</Alert>
        ) : (
          <div className="row">
            <button type="button" className="primary sm" disabled={state.busy} aria-busy={state.busy} onClick={confirm}>
              Confirm
            </button>
            <Link href={`/orders/${encodeURIComponent(p.orderId)}`} className="link-button">Open order →</Link>
          </div>
        )}
        {state.error && <Alert tone="bad">{state.error}</Alert>}
      </div>
    </div>
  );
}
