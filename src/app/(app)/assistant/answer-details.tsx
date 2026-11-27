// Answer details: tables and lists sit under the reply, collapsed by default ("Details (n)"). Native <details>, so it
// is keyboard accessible and needs no state; open it to see the evidence.
import type { ReactNode } from "react";

export const PREVIEW_ROWS = 5;

export function AnswerDetails({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="answer-details">
      <summary>Details ({count})</summary>
      <div className="stack">{children}</div>
    </details>
  );
}
