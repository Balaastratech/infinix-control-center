"use client";

// Assistant chat: my conversations (this login + this browser) on the left, the open conversation on the right.
// Facts render only from the server's blocks; links come only from blocks and must be internal paths.
// Proposal cards never act by themselves: Confirm calls the normal order routes as the logged-in user.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatMoney, parseRupees } from "@/lib/format";
import { Alert, Empty, TableWrap } from "../ui";

type Cell = string | { text: string; href: string };
interface Item {
  text: string;
  href?: string;
}
type Block =
  | { kind: "table"; title: string; columns: string[]; rows: Cell[][]; more?: Item }
  | { kind: "list"; title: string; items: Item[] }
  | { kind: "proposal"; action: "cancel" | "refund" | "ticket"; orderId: string; amountMinor?: number; maxAmountMinor?: number; reason?: string; label: string; note: string };
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
  } catch (e) {
    return { ok: false, status: 0, data: { error: `Could not reach the server: ${(e as Error).message}` } };
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

  const loadList = useCallback(async () => {
    const r = await call("GET", "/api/assistant/conversations");
    if (r.ok) {
      setList(r.data.conversations);
      setMaxChars(r.data.maxChars);
    } else setError(r.data.error ?? `HTTP ${r.status}`);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void loadList();
  }, [loadList]);

  async function open(id: string) {
    setError(null);
    const r = await call("GET", `/api/assistant/conversations/${id}`);
    if (!r.ok) return setError(r.data.error ?? `HTTP ${r.status}`);
    setCurrent(id);
    setMessages(r.data.messages);
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    const r = current
      ? await call("POST", `/api/assistant/conversations/${current}/messages`, { text: q })
      : await call("POST", "/api/assistant/conversations", { text: q });
    setBusy(false);
    if (!r.ok) return setError(r.data.error ?? `HTTP ${r.status}`);
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
    if (!r.ok) setError(r.data.error ?? `HTTP ${r.status}`);
    void loadList();
  }

  async function remove(c: ConversationRow) {
    if (!window.confirm(`Delete "${c.title}"?`)) return;
    const r = await call("DELETE", `/api/assistant/conversations/${c.id}`);
    if (!r.ok) return setError(r.data.error ?? `HTTP ${r.status}`);
    if (current === c.id) {
      setCurrent(null);
      setMessages([]);
    }
    void loadList();
  }

  return (
    <div className="grid-2" style={{ gridTemplateColumns: "minmax(200px, 260px) 1fr", alignItems: "start" }}>
      <section className="card">
        <div className="card-head">
          <span className="label">My conversations</span>
          <button type="button" className="sm" onClick={() => { setCurrent(null); setMessages([]); setError(null); }}>
            New
          </button>
        </div>
        <div className="card-body stack">
          {list === null ? <span className="muted small">Loading…</span> : list.length === 0 ? <Empty>No conversations yet.</Empty> : null}
          {list?.map((c) => (
            <div key={c.id} className="row" style={{ justifyContent: "space-between", gap: 4 }}>
              <button type="button" className={c.id === current ? "chip primary" : "chip"} style={{ height: "auto", boxShadow: "none", textAlign: "left", flex: 1 }} onClick={() => open(c.id)}>
                {c.title}
              </button>
              <button type="button" className="sm" aria-label={`Rename ${c.title}`} onClick={() => rename(c)}>✎</button>
              <button type="button" className="sm" aria-label={`Delete ${c.title}`} onClick={() => remove(c)}>✕</button>
            </div>
          ))}
          <p className="muted small">Private to you in this browser. Kept 7 days.</p>
        </div>
      </section>

      <div className="stack">
        {messages.length === 0 && (
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
          <div key={m.id} className="asked">You: {m.text}</div>
        ) : (
          <AnswerCard key={m.id} m={m} onAsk={ask} busy={busy} />
        )))}
        {error && <Alert tone="bad">{error}</Alert>}
        <section className="card">
          <div className="card-body">
            <form className="row" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
              <input style={{ flex: "1 1 280px" }} value={text} onChange={(e) => setText(e.target.value)} placeholder={current ? "Ask a follow-up, e.g. which of those are over Rs 10,000?" : "e.g. late orders over Rs 5,000"} aria-label="Ask the assistant" maxLength={maxChars} />
              <button className="primary" disabled={busy || !text.trim()} aria-busy={busy}>
                {busy ? "Working…" : "Ask"}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}

function AnswerCard({ m, onAsk, busy }: { m: Message; onAsk: (q: string) => void; busy: boolean }) {
  return (
    <section className="card answer">
      <div className="card-head">
        <span className="muted small">{m.understood}</span>
        <span className="badge">{m.mode === "ai" ? "AI" : m.mode === "fallback" ? "Built-in (AI unavailable)" : "Built-in"}</span>
      </div>
      <div className="card-body stack">
        <h3>{m.text}</h3>
        {m.notice && <Alert tone="warn">{m.notice}</Alert>}
        {m.blocks.map((b, i) => <BlockView key={i} b={b} />)}
        {m.suggestions && m.suggestions.length > 0 && (
          <div className="chips">
            {m.suggestions.map((s) => (
              <button key={s} type="button" className="chip" style={{ height: "auto", boxShadow: "none" }} disabled={busy} onClick={() => onAsk(s)}>
                {s}
              </button>
            ))}
          </div>
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
  const [state, setState] = useState<{ busy?: boolean; done?: string; error?: string }>({});

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
    setState(r.ok ? { done: p.action === "refund" ? "Refund request created. It now waits for Manager approval." : p.action === "cancel" ? "Order cancelled." : "Ticket created." } : { error: r.data.error ?? `HTTP ${r.status}` });
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
