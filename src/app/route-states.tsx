"use client";

// Route-level states shared by error.tsx / loading.tsx files. No raw error text: staff see a plain message and
// a retry; the digest lets us find the server log line.
import Link from "next/link";
import { Alert, Skeleton, SkeletonCard } from "./ui";

export function RouteError({ error, reset, what = "this page" }: { error: Error & { digest?: string }; reset: () => void; what?: string }) {
  return (
    <div className="page-state">
      <Alert tone="bad">
        Could not load {what}. Local data is safe; try again in a moment.
        {error.digest && <small> Reference: {error.digest}</small>}
      </Alert>
      <div className="row">
        <button type="button" className="primary" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="link-button">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

// Loading state inside the shared shell's content area: mirrors the page (title, filters or tabs, table rows, cards),
// so navigation never blanks the sidebar or top bar.
export function PageSkeleton({ title, filters = 0, tabs = 0, rows = 8, cards = 0, cols = 5 }: { title: string; filters?: number; tabs?: number; rows?: number; cards?: number; cols?: number }) {
  return (
    <div aria-busy="true" aria-label={`Loading ${title}`}>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <Skeleton h={12} w={320} />
        </div>
      </div>
      {cards > 0 && (
        <div className="grid-2" style={{ marginBottom: 16 }}>
          {Array.from({ length: cards }, (_, i) => <SkeletonCard key={i} rows={3} />)}
        </div>
      )}
      {rows > 0 && (
        <section className="card">
          {(filters > 0 || tabs > 0) && (
            <div className="toolbar">
              {Array.from({ length: tabs }, (_, i) => <Skeleton key={`t${i}`} h={28} w={120} />)}
              {Array.from({ length: filters }, (_, i) => <Skeleton key={`f${i}`} h={32} w={150} />)}
            </div>
          )}
          <div className="card-body stack">
            <div className="row" style={{ gap: 12 }}>
              {Array.from({ length: cols }, (_, i) => <Skeleton key={i} h={12} w={`${Math.floor(90 / cols)}%`} />)}
            </div>
            {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={18} />)}
          </div>
        </section>
      )}
    </div>
  );
}
