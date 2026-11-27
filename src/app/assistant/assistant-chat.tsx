"use client";

import Link from "next/link";
import { useState } from "react";

interface Answer {
  intent?: string;
  title: string;
  items: { text: string; href?: string }[];
  ok: boolean;
}

const EXAMPLES = ["show delayed shipments", "refunds waiting for approval", "money at risk", "investigate order NC-1004", "request a refund for order NC-1002"];

export function AssistantChat() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<(Answer & { asked: string; key: number })[]>([]);

  async function ask(question: string) {
    if (!question.trim()) return;
    setBusy(true);
    let answer: Answer;
    try {
      const res = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: question }) });
      const body = await res.json().catch(() => ({}));
      answer = res.ok ? { ...body, ok: true } : { title: body.title ?? body.error ?? `HTTP ${res.status}`, items: body.items ?? [], ok: false };
    } catch (e) {
      answer = { title: `Could not reach the server: ${(e as Error).message}`, items: [], ok: false };
    }
    setAnswers((a) => [{ ...answer, asked: question, key: Date.now() }, ...a]);
    setText("");
    setBusy(false);
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
            <button className="primary" disabled={busy || !text.trim()} aria-busy={busy}>
              {busy ? "Working…" : "Ask"}
            </button>
          </form>
          <div className="chips">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="chip" style={{ height: "auto", boxShadow: "none" }} onClick={() => setText(x)}>
                {x}
              </button>
            ))}
          </div>
        </div>
      </section>
      {answers.map((a) => (
        <section key={a.key} className="card answer">
          <div className="card-head">
            <span className="asked">You asked: {a.asked}</span>
          </div>
          <div className="card-body">
            <h3 className={a.ok ? undefined : "error"}>{a.title}</h3>
            {a.items.length > 0 && (
              <ul>
                {a.items.map((it, j) => (
                  <li key={j} className={it.text.startsWith("LOCAL AHEAD") ? "badge-sub" : undefined} style={it.text.startsWith("LOCAL AHEAD") ? { fontSize: "inherit", fontWeight: 600 } : undefined}>
                    {it.href ? <Link href={it.href}>{it.text}</Link> : it.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ))}
    </>
  );
}
