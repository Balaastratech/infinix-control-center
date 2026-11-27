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

// Numbers a summary may derive from the facts: the sum or difference of two values, a sum of a consecutive run of
// values (a table column total), or the grand total. ponytail: O(n^2) over the fact values; n is a few hundred at most.
export function derivable(values: number[]): Set<number> {
  const out = new Set<number>();
  const distinct = [...new Set(values)];
  for (let i = 0; i < distinct.length; i++)
    for (let j = i + 1; j < distinct.length; j++) {
      out.add(distinct[i] + distinct[j]);
      out.add(Math.abs(distinct[i] - distinct[j]));
    }
  for (let i = 0; i < values.length; i++) {
    let run = values[i];
    for (let j = i + 1; j < values.length; j++) out.add((run += values[j]));
  }
  return out;
}

function amountList(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const p = amountToPaise(m[1], m[2]);
    if (p !== null) out.push(p);
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
  let derived: Set<number> | null = null; // built only if needed
  for (const m of s.matchAll(AMOUNT)) {
    const p = amountToPaise(m[1], m[2]);
    if (p !== null && !known.has(p) && !(derived ??= derivable(amountList(facts))).has(p)) reasons.push(`unknown amount ${m[0].trim()}`);
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
  let derivedCounts: Set<number> | null = null; // counts: sums/differences of counts in the facts
  for (const n of rest.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []) {
    if (factNumbers.has(Number(n))) continue;
    // only real counts ("11 cancelled orders"), not ids, names or dates, so an invented count can't sneak through
    derivedCounts ??= derivable([...facts.matchAll(/\b(\d{1,4}) [a-z]/gi)].map((m) => Number(m[1])));
    if (!derivedCounts.has(Number(n))) reasons.push(`unknown number ${n}`);
  }
  return { ok: reasons.length === 0, reasons };
}
