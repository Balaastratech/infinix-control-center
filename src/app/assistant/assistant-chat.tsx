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
  const [answers, setAnswers] = useState<(Answer & { asked: string })[]>([]);

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
    setAnswers((a) => [{ ...answer, asked: question }, ...a]);
    setText("");
    setBusy(false);
  }

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, e.g. investigate order NC-1004" size={60} maxLength={300} />{" "}
        <button disabled={busy || !text.trim()}>{busy ? "Working…" : "Ask"}</button>
      </form>
      <p>
        <small>
          Try:{" "}
          {EXAMPLES.map((x, i) => (
            <span key={x}>
              {i > 0 && " · "}
              <a href="#" onClick={(e) => { e.preventDefault(); setText(x); }}>{x}</a>
            </span>
          ))}
        </small>
      </p>
      {answers.map((a, i) => (
        <section key={answers.length - i}>
          <p><small>You: {a.asked}</small></p>
          <h3 className={a.ok ? undefined : "error"}>{a.title}</h3>
          <ul>
            {a.items.map((it, j) => (
              <li key={j}>{it.href ? <Link href={it.href}>{it.text}</Link> : it.text}</li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
