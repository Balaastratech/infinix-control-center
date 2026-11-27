"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
    router.refresh();
  }
  return (
    <button className="sm" onClick={logout} disabled={busy} aria-busy={busy}>
      {busy ? "Logging out…" : "Log out"}
    </button>
  );
}
