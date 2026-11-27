"use client";

// Assistant health on the Integrations page (GET /api/assistant/health). Plain words only: no error codes.
import { useEffect, useState } from "react";
import { formatIst } from "@/lib/format";
import type { AiHealth } from "@/server/services/assistant-breaker";
import { Badge, Card, SkeletonCard } from "../../ui";

const REASONS: Record<string, string> = {
  paused_usage_limit: "skipped: paused (usage limit)",
  paused_outage: "skipped: paused (outage)",
  usage_limit: "usage limit",
  rate_limited: "rate limited",
  timeout: "timed out",
  connection: "could not connect",
  refusal: "model declined",
  guard_violations: "blocked by guardrails",
  max_tokens: "answer too long",
  too_many_rounds: "too many steps",
  error: "unexpected error",
};
const reasonLabel = (r: string) => REASONS[r] ?? (r.startsWith("api_") ? "service error" : r.replace(/_/g, " "));
const CATEGORY: Record<string, string> = { usage_limit: "usage limit", outage: "outage", refusal: "model refusal", other: "unexpected error" };
const TONE = { available: "ok", paused: "warn", degraded: "warn", off: "muted" } as const;

export function AssistantCard() {
  const [h, setH] = useState<(AiHealth & { canResume?: boolean }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [resume, setResume] = useState<{ busy?: boolean; error?: string }>({});

  // Manager only (the route returns 403 otherwise): clear the pause after the limit was raised. Audited.
  async function resumeSmartAnswers() {
    setResume({ busy: true });
    const res = await fetch("/api/assistant/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    if (!res?.ok) return setResume({ error: "Could not resume smart answers. Please try again." });
    setH({ ...(await res.json()), canResume: true });
    setResume({});
  }
  useEffect(() => {
    fetch("/api/assistant/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(setH)
      .catch(() => setFailed(true));
  }, []);
  if (failed) return <Card title="Assistant"><p className="muted small">Assistant status is not available right now.</p></Card>;
  if (!h) return <SkeletonCard rows={3} />;
  const fallbacks = Object.entries(h.fallbacks);
  return (
    <Card title="Assistant">
      <div className="stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <Badge status={h.status} tone={TONE[h.status]} label={h.label} />
          {h.canResume && (h.status === "paused" || h.status === "degraded") && (
            <button type="button" className="sm" disabled={resume.busy} aria-busy={resume.busy} onClick={resumeSmartAnswers}>
              Resume smart answers
            </button>
          )}
        </div>
        {resume.error && <span className="small error">{resume.error}</span>}
        <span className="small">
          Today: {h.aiAnswers} of {h.cap} smart answers · {h.standardAnswers} standard answers · {h.groundingMisses} summaries removed by the grounding check
        </span>
        <span className="small">
          Fallbacks: {fallbacks.length ? fallbacks.map(([r, n]) => `${reasonLabel(r)} ${n}`).join(" · ") : "none"}
        </span>
        <span className="small muted">
          Tokens today: {h.tokens.input.toLocaleString("en-IN")} in, {h.tokens.output.toLocaleString("en-IN")} out · Last error:{" "}
          {h.lastErrorAt ? `${formatIst(h.lastErrorAt)} (${CATEGORY[h.lastErrorCategory ?? ""] ?? "unknown"})` : "none"}
        </span>
      </div>
    </Card>
  );
}
