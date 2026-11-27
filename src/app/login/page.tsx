"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "../ui";

// Seeded by `npm run setup`; listed for the reviewer. Documented demo credentials, not secrets.
const DEMO_PASSWORD = "demo1234";
const DEMO_USERS = [
  { email: "viewer@nova.test", role: "viewer", can: "read only" },
  { email: "operator@nova.test", role: "operator", can: "cancel, request refunds, sync" },
  { email: "manager@nova.test", role: "manager", can: "approve refunds, workflows" },
  { email: "manager2@nova.test", role: "manager", can: "second approver" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Login failed (${res.status})`);
    } catch {
      setError("Network error, try again");
    }
    setBusy(false);
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="brand" style={{ color: "var(--text)", padding: 0 }}>
          <span className="brand-mark">N</span>
          <span>
            NovaCommerce Ops
            <small className="muted">Operations console</small>
          </span>
        </div>
        <form onSubmit={onSubmit}>
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
          {error && <Alert tone="bad">{error}</Alert>}
          <button type="submit" className="primary" disabled={busy} aria-busy={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="demo">
          <p className="label">
            Demo accounts <span className="muted">· password {DEMO_PASSWORD}</span>
          </p>
          <ul>
            {DEMO_USERS.map((u) => (
              <li key={u.email}>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(u.email);
                    setPassword(DEMO_PASSWORD);
                    setError(null);
                  }}
                  title={`Fill in ${u.email}`}
                >
                  <span>
                    {u.email} <span className="muted small">· {u.can}</span>
                  </span>
                  <span className={`role ${u.role}`}>{u.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
