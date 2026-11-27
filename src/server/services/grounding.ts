// Grounding check for the AI summary (docs/assistant-design.md section 6). Pure. Every order id, customer id, amount,
// number and customer name the summary mentions must appear in this turn's tool results (or the user's question);
// otherwise the summary is dropped and only the tool tables are shown. Also drops summaries that claim an action
// happened, leak a secret or quote the system prompt.
import { amountToPaise } from "./assistant-parser";

export interface SummaryCheck {
  ok: boolean;
  reasons: string[];
}

const MAX_SUMMARY = 400;
const AMOUNT = /(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|lakhs?|l)?\b/gi;
const CLAIMS_ACTION = /\b(i|we)\s+(have\s+|just\s+|already\s+)?(cancell?ed|approved|rejected|refunded|issued|executed|processed|created|sent|deleted)\b/i;

function amountsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(AMOUNT)) {
    const p = amountToPaise(m[1], m[2]);
    if (p !== null) out.add(p);
  }
  return out;
}

export function checkSummary(summary: string, facts: string, question: string, opts: { customerNames: string[]; secrets: string[]; systemPrompt: string }): SummaryCheck {
  const reasons: string[] = [];
  const s = summary.trim();
  const factText = `${facts}\n${question}`;
  const lowerFacts = factText.toLowerCase();
  if (s.length > MAX_SUMMARY) reasons.push("too long");
  if (CLAIMS_ACTION.test(s)) reasons.push("claims an action");
  if (/\b(you|i)\s+(are|am)\s+(now\s+)?(an?\s+)?(admin|administrator|manager|superuser|root)\b/i.test(s)) reasons.push("claims a role change");
  for (const secret of opts.secrets) if (secret.length >= 8 && s.includes(secret)) reasons.push("contains a secret");
  for (const line of opts.systemPrompt.split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l.length >= 30)) {
    if (s.toLowerCase().includes(line.slice(0, 30))) {
      reasons.push("quotes the system prompt");
      break;
    }
  }

  let rest = s;
  const ids = new Set((factText.match(/\b(?:NC|C)-\d+\b/gi) ?? []).map((x) => x.toUpperCase()));
  for (const id of s.match(/\bNC-\d+\b/gi) ?? []) {
    if (!ids.has(id.toUpperCase())) reasons.push(`unknown order ${id}`);
    rest = rest.replace(id, " ");
  }
  for (const id of s.match(/\bC-\d+\b/gi) ?? []) {
    if (!ids.has(id.toUpperCase())) reasons.push(`unknown customer ${id}`);
    rest = rest.replace(id, " ");
  }
  const known = amountsIn(factText);
  for (const m of s.matchAll(AMOUNT)) {
    const p = amountToPaise(m[1], m[2]);
    if (p !== null && !known.has(p)) reasons.push(`unknown amount ${m[0].trim()}`);
    rest = rest.replace(m[0], " ");
  }
  for (const name of opts.customerNames) {
    if (name.length >= 3 && s.toLowerCase().includes(name.toLowerCase())) {
      if (!lowerFacts.includes(name.toLowerCase())) reasons.push(`unknown customer ${name}`);
      const at = rest.toLowerCase().indexOf(name.toLowerCase());
      if (at >= 0) rest = rest.slice(0, at) + " " + rest.slice(at + name.length);
    }
  }
  const factNumbers = new Set((factText.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  for (const n of rest.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!factNumbers.has(Number(n))) reasons.push(`unknown number ${n}`);
  }
  return { ok: reasons.length === 0, reasons };
}
