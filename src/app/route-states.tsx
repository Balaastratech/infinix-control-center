"use client";

// Route-level states shared by error.tsx / loading.tsx files. No raw error text: staff see a plain message and
// a retry; the digest lets us find the server log line.
import Link from "next/link";
import { Alert, SkeletonCard } from "./ui";

export function RouteError({ error, reset, what = "this page" }: { error: Error & { digest?: string }; reset: () => void; what?: string }) {
  return (
    <main className="page-state">
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
    </main>
  );
}

export function RouteLoading({ cards = 1 }: { cards?: number }) {
  return (
    <main className="page-state" aria-busy="true">
      {Array.from({ length: cards }, (_, i) => (
        <SkeletonCard key={i} rows={6} />
      ))}
    </main>
  );
}
