"use client";

import Link from "next/link";
import { useState } from "react";

interface Item {
  text: string;
  href?: string;
}
interface Answer {
  intent?: string;
  title: string;
  items: Item[];
  ok: boolean;
}

const EXAMPLES = ["show delayed shipments", "refunds waiting for approval", "money at risk", "investigate order NC-1004", "request a refund for order NC-1002"];
const KEEP = 5;
const NEXT = "Next: ";

// "Next: request a refund of ₹1,750.00 (ask: "request a refund for order NC-1002")"
//   -> label "Request a refund of ₹1,750.00", ask "request a refund for order NC-1002"
function nextStep(item: Item) {
  const raw = item.text.slice(NEXT.length);
  const ask = /\(ask: "([^"]+)"\)/.exec(raw)?.[1];
  const label = raw.replace(/\s*\(ask: "[^"]+"\)/, "");
  return { label: label.charAt(0).toUpperCase() + label.slice(1), ask, href: item.href };
}

export function AssistantChat() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [answers, setAnswers] = useState<(Answer & { asked: string; key: number })[]>([]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(question);
    let answer: Answer;
    try {
      const res = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: question }) });
      const body = await res.json().catch(() => ({}));
      answer = res.ok ? { ...body, ok: true } : { title: body.title ?? body.error ?? `HTTP ${res.status}`, items: body.items ?? [], ok: false };
    } catch (e) {
      answer = { title: `Could not reach the server: ${(e as Error).message}`, items: [], ok: false };
    }
    setAnswers((a) => [{ ...answer, asked: question, key: Date.now() }, ...a].slice(0, KEEP));
    setText("");
    setBusy(null);
  }

  return (
    <>
      <section className="card">
        <div className="card-body">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(text);
            }}
          >
            <input
              style={{ flex: "1 1 280px" }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. investigate order NC-1004"
              aria-label="Ask the assistant"
              maxLength={300}
            />
            <button className="primary" disabled={busy !== null || !text.trim()} aria-busy={busy === text && busy !== null}>
              {busy ? "Working…" : "Ask"}
            </button>
          </form>
          <div className="chips">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="chip" style={{ height: "auto", boxShadow: "none" }} disabled={busy !== null} aria-busy={busy === x} onClick={() => ask(x)}>
                {x}
              </button>
            ))}
          </div>
          <p className="muted small">The last {KEEP} answers stay below, newest first.</p>
        </div>
      </section>
      {answers.map((a) => {
        const facts = a.items.filter((it) => !it.text.startsWith(NEXT));
        const next = a.items.filter((it) => it.text.startsWith(NEXT)).map(nextStep);
        return (
          <section key={a.key} className="card answer">
            <div className="card-head">
              <span className="asked">You asked: {a.asked}</span>
            </div>
            <div className="card-body">
              <h3 className={a.ok ? undefined : "error"}>{a.title}</h3>
              {facts.length > 0 && (
                <ul>
                  {facts.map((it, j) => (
                    <li key={j} className={it.text.startsWith("LOCAL AHEAD") ? "badge-sub" : undefined} style={it.text.startsWith("LOCAL AHEAD") ? { fontSize: "inherit", fontWeight: 600 } : undefined}>
                      {it.href ? <Link href={it.href}>{it.text}</Link> : it.text}
                    </li>
                  ))}
                </ul>
              )}
              {next.length > 0 && (
                <div className="stack">
                  <span className="label">What you can do next</span>
                  <div className="row">
                    {next.map((n) =>
                      n.ask ? (
                        <button key={n.label} type="button" className="primary sm" disabled={busy !== null} aria-busy={busy === n.ask} onClick={() => ask(n.ask!)}>
                          {n.label}
                        </button>
                      ) : n.href ? (
                        <Link key={n.label} href={n.href} className="link-button">
                          {n.label} →
                        </Link>
                      ) : (
                        <span key={n.label} className="muted small">
                          {n.label}
                        </span>
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}
