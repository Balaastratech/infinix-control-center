"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>NovaCommerce Ops: sign in</h1>
      <form onSubmit={onSubmit}>
        <p>
          <label>
            Email <input name="email" type="email" required autoComplete="username" />
          </label>
        </p>
        <p>
          <label>
            Password <input name="password" type="password" required autoComplete="current-password" />
          </label>
        </p>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
