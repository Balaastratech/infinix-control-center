// Small presentational pieces shared by server and client components. Styling lives in globals.css.
import type { ReactNode } from "react";
import { statusLabel } from "@/lib/labels";

export type Tone = "ok" | "warn" | "bad" | "muted" | "info";

// One colour per meaning: green ok/succeeded, amber pending/delayed/local ahead, red failed/down/at risk,
// grey cancelled/ignored, blue in progress or neutral states.
const TONES: Record<string, Tone> = {
  succeeded: "ok",
  captured: "ok",
  delivered: "ok",
  applied: "ok",
  ok: "ok",
  enabled: "ok",
  resolved: "ok",
  matched: "ok",
  pending: "warn",
  pending_approval: "warn",
  delayed: "warn",
  submitted: "warn",
  requested: "warn",
  stale: "warn",
  unsent: "warn",
  "local ahead": "warn",
  failed: "bad",
  down: "bad",
  rejected: "bad",
  refused: "bad",
  denied: "bad",
  forbidden: "bad",
  cancelled: "muted",
  ignored: "muted",
  skipped: "muted",
  disabled: "muted",
  unknown: "muted",
  processing: "info",
  shipped: "info",
  approved: "info",
  open: "info",
};

export const toneOf = (status: string | null | undefined): Tone => TONES[status ?? ""] ?? "muted";

export function Badge({ status, tone, label }: { status: string | null | undefined; tone?: Tone; label?: string }) {
  if (!status) return <span className="muted">-</span>;
  return <span className={`badge ${tone ?? toneOf(status)}`}>{label ?? statusLabel(status)}</span>;
}

export function Card({ title, count, actions, children, flush }: { title?: ReactNode; count?: number; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          <h2>
            {title}
            {count !== undefined && <span className="count">{count}</span>}
          </h2>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function Alert({ tone, children }: { tone: "ok" | "bad" | "warn"; children: ReactNode }) {
  return (
    <div className={`alert ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export const Skeleton = ({ h = 16, w = "100%" }: { h?: number; w?: number | string }) => (
  <span className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />
);

// Placeholder for a card of rows while data loads.
export function SkeletonCard({ rows = 4 }: { rows?: number }) {
  return (
    <section className="card" aria-busy="true" aria-label="Loading">
      <div className="card-head">
        <Skeleton h={14} w={140} />
      </div>
      <div className="card-body stack">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} h={14} w={`${90 - i * 12}%`} />
        ))}
      </div>
    </section>
  );
}

// Wide tables scroll inside their card instead of the page.
export const TableWrap = ({ children }: { children: ReactNode }) => <div className="table-wrap">{children}</div>;

// A labelled filter: the label sits above, "All" is the empty option, values are shown in words.
export function FilterSelect({ label, value, options, onChange, format = statusLabel }: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  format?: (value: string) => string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {format(o)}
          </option>
        ))}
      </select>
    </label>
  );
}
